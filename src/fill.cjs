#!/usr/bin/env node
// src/fill.cjs — Fill an ORD1 covenant order on-chain
//
// Usage: node src/fill.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --order-txid <txid> --fill-price 50 --fill-quantity 200

const fs = require('fs')
const path = require('path')
const { bsv, PubKeyHash, toByteString, int2ByteString, Utils, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Order } = require('../dist/contracts/order')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getUtxos, getCurrentHeight
} = require('../lib/wallet.cjs')
const { decodeOrd1 } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const ORDER_TXID = args['order-txid']
const FILL_PRICE = parseInt(args['fill-price'])
const FILL_QUANTITY = parseInt(args['fill-quantity'])
const DELIVERY_HASH = args['delivery-hash'] || '00'.repeat(32)

if (!ORDER_TXID || !FILL_PRICE || !FILL_QUANTITY) {
  console.log('Usage: node src/fill.cjs --wallet <path> --order-txid <txid> --fill-price 50 --fill-quantity 200 [--delivery-hash <hex>]')
  process.exit(1)
}

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/order.json')
Order.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function fill() {
  console.log('🛒 ORD1 — Fill Order (Covenant)')
  console.log(`   Order:    ${ORDER_TXID.slice(0, 16)}...`)
  console.log(`   Price:    ${FILL_PRICE} sats/unit`)
  console.log(`   Quantity: ${FILL_QUANTITY}`)
  const fillAmount = FILL_PRICE * FILL_QUANTITY
  console.log(`   Total:    ${fillAmount.toLocaleString()} sats`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  console.log(`   Taker:    ${address.toString()}`)

  // Fetch order tx
  const orderTxHex = await wocGetRaw(`/tx/${ORDER_TXID}/hex`)
  const orderTx = new bsv.Transaction(orderTxHex)

  // Parse order OP_RETURN
  let orderData = null
  for (const out of orderTx.outputs) {
    const parsed = decodeOrd1(out.script.toHex())
    if (parsed && parsed.action === 'PLACE') {
      orderData = parsed
      break
    }
  }

  if (!orderData) {
    console.error('❌ Could not find ORD1 PLACE in order tx')
    process.exit(1)
  }

  // Find the covenant output (largest script with value > 0)
  let orderOutputIndex = 0
  let maxScriptLen = 0
  for (let i = 0; i < orderTx.outputs.length; i++) {
    const scriptLen = orderTx.outputs[i].script.toHex().length
    if (scriptLen > maxScriptLen && orderTx.outputs[i].satoshis > 0) {
      maxScriptLen = scriptLen
      orderOutputIndex = i
    }
  }

  console.log(`   Order output: [${orderOutputIndex}] (${maxScriptLen / 2} bytes script)`)
  console.log(`   Order type: ${orderData.type}, side: ${orderData.side === 0 ? 'BID' : 'ASK'}`)
  console.log(`   Order price: ${orderData.price}, quantity: ${orderData.quantity}`)

  // Verify fill constraints
  if (orderData.side === 1 && FILL_PRICE < orderData.price) {
    console.error(`❌ Fill price (${FILL_PRICE}) below ASK price (${orderData.price})`)
    process.exit(1)
  }
  if (orderData.side === 0 && FILL_PRICE > orderData.price) {
    console.error(`❌ Fill price (${FILL_PRICE}) above BID price (${orderData.price})`)
    process.exit(1)
  }

  const isPartial = FILL_QUANTITY < orderData.quantity

  console.log(`   Partial:  ${isPartial ? 'yes' : 'no (full fill)'}`)
  console.log(`   Payment:  ${fillAmount.toLocaleString()} sats`)
  console.log()

  // Reconstruct Order covenant from tx
  const dummyKey = bsv.PrivateKey.fromRandom('mainnet')
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(dummyKey, provider)
  await provider.connect()

  const order = Order.fromTx(orderTx, orderOutputIndex)
  await order.connect(signer)

  console.log(`   Contract price: ${order.price}`)
  console.log(`   Contract quantity: ${order.remainingQuantity}`)
  console.log(`   Contract side: ${order.side === 1n ? 'ASK' : 'BID'}`)

  if (BigInt(FILL_QUANTITY) > order.remainingQuantity) {
    console.error(`❌ Fill quantity (${FILL_QUANTITY}) exceeds remaining (${order.remainingQuantity})`)
    process.exit(1)
  }

  // Prepare next instance for partial fills
  const nextInstance = order.next()
  nextInstance.remainingQuantity = order.remainingQuantity - BigInt(FILL_QUANTITY)

  // Taker P2PKH
  const takerPkhHex = address.hashBuffer.toString('hex')
  const takerPkh = PubKeyHash(toByteString(takerPkhHex))

  // Pre-fetch taker funding UTXO (can't await inside tx builder)
  const takerUtxos = await getUtxos(address.toString())
  if (!takerUtxos || takerUtxos.length === 0) {
    console.error('❌ No taker UTXOs available')
    process.exit(1)
  }

  const fundingNeeded = fillAmount + 2000
  const fundUtxo = takerUtxos.find(u => u.satoshis >= fundingNeeded)
  if (!fundUtxo) {
    console.error(`❌ No taker UTXO large enough (need ${fundingNeeded} sats)`)
    process.exit(1)
  }

  let fundScript = fundUtxo.script
  if (!fundScript) {
    const fundTxHex = await wocGetRaw(`/tx/${fundUtxo.txid}/hex`)
    const fundTx = new bsv.Transaction(fundTxHex)
    fundScript = fundTx.outputs[fundUtxo.vout].script.toHex()
  }

  // Derive maker address
  const makerInputTxid = orderTx.inputs[0].prevTxId.toString('hex')
  const makerInputVout = orderTx.inputs[0].outputIndex
  const makerTxHex = await wocGetRaw(`/tx/${makerInputTxid}/hex`)
  const makerTx = new bsv.Transaction(makerTxHex)
  const makerAddress = makerTx.outputs[makerInputVout].script.toAddress(bsv.Networks.mainnet)
  const makerPkhHex = makerAddress.hashBuffer.toString('hex')

  // The covenant's fill() method builds outputs in this exact order:
  //   [0] Payment P2PKH to maker (ASK) or taker (BID)
  //   [1] Continuation covenant UTXO (if partial)
  //   [2] OP_RETURN: "ORD1" "FILL" <fillPrice:8B> <fillQty:8B> <type:1B> <side:1B>
  //
  // Any additional outputs (taker funding, change) must come AFTER these.
  // The covenant checks hashOutputs == hash256(all outputs concatenated)
  // So we must build ALL outputs in the tx builder to match.

  order.bindTxBuilder('fill', (current, options, takerPkhArg, fillPriceArg, fillQuantityArg, isPartialArg, changePkhArg, changeAmountArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    const paymentAmount = Number(fillPriceArg) * Number(fillQuantityArg)
    const remainingQty = order.remainingQuantity - BigInt(fillQuantityArg)
    const remainingValue = Number(order.price * remainingQty)

    // Output 0: Payment P2PKH (to maker for ASK, to taker for BID)
    if (order.side === 1n) {
      unsignedTx.addOutput(new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(makerAddress),
        satoshis: paymentAmount,
      }))
    } else {
      unsignedTx.addOutput(new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(address),
        satoshis: paymentAmount,
      }))
    }

    // Output 1: Continuation covenant UTXO (if partial)
    if (isPartialArg && remainingValue > 546) {
      unsignedTx.addOutput(new bsv.Transaction.Output({
        script: nextInstance.lockingScript,
        satoshis: remainingValue,
      }))
    }

    // Output 2: OP_RETURN (exact format the covenant builds)
    const opReturnHex =
      '006a' +
      '04' + '4f524431' +
      '04' + '46494c4c' +
      '08' + int2ByteString(fillPriceArg, 8n) +
      '08' + int2ByteString(fillQuantityArg, 8n) +
      '01' + int2ByteString(order.orderType, 1n) +
      '01' + int2ByteString(order.side, 1n)
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.fromHex(opReturnHex),
      satoshis: 0,
    }))

    // Output 3: Change to taker (from their funding input)
    if (Number(changeAmountArg) > 0) {
      unsignedTx.addOutput(new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(address),
        satoshis: Number(changeAmountArg),
      }))
    }

    // Add taker funding input
    unsignedTx.from({
      txid: fundUtxo.txid,
      vout: fundUtxo.vout,
      script: bsv.Script.fromHex(fundScript),
      satoshis: fundUtxo.satoshis,
    })

    return Promise.resolve({
      tx: unsignedTx,
      atInputIndex: 0,
      nexts: isPartialArg && remainingValue > 546
        ? [{ instance: nextInstance, atOutputIndex: 1, balance: remainingValue }]
        : [],
    })
  })

  console.log('   Building fill transaction...')

  // Calculate change amount for the taker funding UTXO
  const takerChange = fundUtxo.satoshis - fillAmount - 2000 // fee

  const callResult = await order.methods.fill(
    takerPkh,
    BigInt(FILL_PRICE),
    BigInt(FILL_QUANTITY),
    isPartial,
    PubKeyHash(toByteString(takerPkhHex)), // changePkh = taker
    BigInt(takerChange > 546 ? takerChange : 0), // changeAmount
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

  // Sign the taker input (index 1)
  callResult.tx.sign(privKey)

  const txhex = callResult.tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const txid = await wocBroadcast(txhex)

  // Update state
  const stateDir = path.join(__dirname, '..', 'state')
  const orderFile = path.join(stateDir, 'orders.json')
  if (fs.existsSync(orderFile)) {
    let orders = JSON.parse(fs.readFileSync(orderFile, 'utf8'))
    const orderEntry = orders.find(o => o.txid === ORDER_TXID)
    if (orderEntry) {
      orderEntry.remaining_quantity = (orderEntry.remaining_quantity || orderEntry.quantity) - FILL_QUANTITY
      orderEntry.fills = orderEntry.fills || []
      orderEntry.fills.push({
        txid,
        fill_price: FILL_PRICE,
        fill_quantity: FILL_QUANTITY,
        delivery_hash: DELIVERY_HASH,
        timestamp: Date.now(),
        covenant: true,
      })
      if (orderEntry.remaining_quantity <= 0) orderEntry.status = 'filled'
      fs.writeFileSync(orderFile, JSON.stringify(orders, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Order filled (covenant spend)!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Paid:    ${fillAmount.toLocaleString()} sats`)
  console.log(`   ${isPartial ? 'Partial fill — order continues (covenant UTXO)' : 'Full fill — order complete'}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

fill().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

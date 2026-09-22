#!/usr/bin/env node
// src/fill.cjs — Fill an ORD1 order on-chain
//
// Usage: node src/fill.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --order-txid <txid> --fill-price 50 --fill-quantity 200

const fs = require('fs')
const path = require('path')
const { bsv } = require('scrypt-ts')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getUtxos
} = require('../lib/wallet.cjs')
const { encodeFill, decodeOrd1, buildOpReturnScript } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const ORDER_TXID = args['order-txid']
const FILL_PRICE = parseInt(args['fill-price'])
const FILL_QUANTITY = parseInt(args['fill-quantity'])
const DELIVERY_HASH = args['delivery-hash'] || '00'.repeat(32) // 0s = instant

if (!ORDER_TXID || !FILL_PRICE || !FILL_QUANTITY) {
  console.log('Usage: node src/fill.cjs --wallet <path> --order-txid <txid> --fill-price 50 --fill-quantity 200 [--delivery-hash <hex>]')
  process.exit(1)
}

// ─── Main ────────────────────────────────────────────────────────────

async function fill() {
  console.log('🛒 ORD1 — Fill Order')
  console.log(`   Order:    ${ORDER_TXID.slice(0, 16)}...`)
  console.log(`   Price:    ${FILL_PRICE} sats/unit`)
  console.log(`   Quantity: ${FILL_QUANTITY}`)
  console.log(`   Total:    ${(FILL_PRICE * FILL_QUANTITY).toLocaleString()} sats`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, address } = getKeypair(wallet)

  console.log(`   Taker:    ${address.toString()}`)

  // Fetch order tx
  const orderTxHex = await wocGetRaw(`/tx/${ORDER_TXID}/hex`)
  const orderTx = new bsv.Transaction(orderTxHex)

  // Parse order OP_RETURN
  let orderData = null
  let orderOutputIndex = 0
  for (let i = 0; i < orderTx.outputs.length; i++) {
    const scriptHex = orderTx.outputs[i].script.toHex()
    const parsed = decodeOrd1(scriptHex)
    if (parsed && parsed.action === 'PLACE') {
      orderData = parsed
      break
    }
  }

  if (!orderData) {
    console.error('❌ Could not find ORD1 PLACE in order tx')
    process.exit(1)
  }

  // Find the P2PKH output (order value) — first non-OP_RETURN output
  let orderOutput = null
  let orderVout = 0
  for (let i = 0; i < orderTx.outputs.length; i++) {
    const script = orderTx.outputs[i].script
    const hex = script.toHex()
    if (!decodeOrd1(hex) && script.isPublicKeyHashOut()) {
      orderOutput = orderTx.outputs[i]
      orderVout = i
      break
    }
  }

  if (!orderOutput) {
    console.error('❌ Could not find order value output')
    process.exit(1)
  }

  console.log(`   Order type: ${orderData.type}, side: ${orderData.side === 0 ? 'BID' : 'ASK'}`)
  console.log(`   Order price: ${orderData.price}, remaining: ${orderData.remaining_quantity || orderData.quantity}`)

  // Verify fill constraints
  if (orderData.side === 1) { // ASK
    if (FILL_PRICE < orderData.price) {
      console.error(`❌ Fill price (${FILL_PRICE}) below ASK price (${orderData.price})`)
      process.exit(1)
    }
  } else { // BID
    if (FILL_PRICE > orderData.price) {
      console.error(`❌ Fill price (${FILL_PRICE}) above BID price (${orderData.price})`)
      process.exit(1)
    }
  }

  const fillAmount = FILL_PRICE * FILL_QUANTITY
  const orderQuantity = orderData.remaining_quantity || orderData.quantity
  const isPartial = FILL_QUANTITY < orderQuantity

  console.log(`   Partial:  ${isPartial ? 'yes' : 'no (full fill)'}`)
  console.log(`   Payment:  ${fillAmount.toLocaleString()} sats`)
  console.log()

  // Get taker UTXOs for funding
  const takerUtxos = await getUtxos(address.toString())
  if (!takerUtxos || takerUtxos.length === 0) {
    console.error('❌ No taker UTXOs available')
    process.exit(1)
  }

  // Derive maker address from order tx input
  // The order tx input's output script tells us the maker's P2PKH
  const makerInputTxid = orderTx.inputs[0].prevTxId.toString('hex')
  const makerInputVout = orderTx.inputs[0].outputIndex
  const makerTxHex = await wocGetRaw(`/tx/${makerInputTxid}/hex`)
  const makerTx = new bsv.Transaction(makerTxHex)
  const makerOutput = makerTx.outputs[makerInputVout]
  const makerAddress = makerOutput.script.toAddress(bsv.Networks.mainnet)

  // Build fill tx
  const tx = new bsv.Transaction()

  // Input 0: Order UTXO (being filled)
  tx.from({
    txid: ORDER_TXID,
    vout: orderVout,
    script: orderOutput.script,
    satoshis: orderOutput.satoshis,
  })

  // For ASK: taker needs funding UTXO to pay
  let fundUtxo = null
  let fundScript = null
  if (orderData.side === 1) { // ASK — taker pays
    const fundingNeeded = fillAmount + 600 // fee estimate
    fundUtxo = takerUtxos.find(u => u.satoshis >= fundingNeeded)
    if (!fundUtxo) {
      console.error(`❌ No taker UTXO large enough (need ${fundingNeeded} sats)`)
      process.exit(1)
    }
    // Fetch script if not available
    if (!fundUtxo.script) {
      const fundTxHex = await wocGetRaw(`/tx/${fundUtxo.txid}/hex`)
      const fundTx = new bsv.Transaction(fundTxHex)
      fundScript = fundTx.outputs[fundUtxo.vout].script.toHex()
    } else {
      fundScript = fundUtxo.script
    }
    tx.from({
      txid: fundUtxo.txid,
      vout: fundUtxo.vout,
      script: bsv.Script.fromHex(fundScript),
      satoshis: fundUtxo.satoshis,
    })
  }

  // Outputs
  const remainingValue = orderOutput.satoshis - fillAmount

  if (orderData.side === 1) { // ASK
    // Output 0: Payment to maker
    tx.to(makerAddress, fillAmount)

    if (isPartial && remainingValue > 546) {
      // Remaining order value back to maker (order stays open)
      tx.to(makerAddress, remainingValue)
    }

    // Change from funding UTXO
    if (fundUtxo) {
      const change = fundUtxo.satoshis - fillAmount - 600
      if (change > 546) {
        tx.to(address, change)
      }
    }
  } else { // BID
    // Output 0: Payment to taker (seller claims from locked buyer funds)
    tx.to(address, fillAmount)

    if (isPartial && remainingValue > 546) {
      tx.to(makerAddress, remainingValue)
    }
  }

  // OP_RETURN: ORD1 FILL (OP_FALSE OP_RETURN format)
  const fillParts = encodeFill({
    orderTxid: ORDER_TXID,
    takerId: '00'.repeat(20),
    fillPrice: FILL_PRICE,
    fillQuantity: FILL_QUANTITY,
    deliveryHash: DELIVERY_HASH,
    takerBondRef: '00'.repeat(32),
  })
  const opReturnHex = buildOpReturnScript(fillParts)
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Sign
  tx.sign(privKey)

  const txhex = tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const txid = await wocBroadcast(txhex)

  // Update state
  const stateDir = path.join(__dirname, '..', 'state')
  const orderFile = path.join(stateDir, 'orders.json')
  if (fs.existsSync(orderFile)) {
    let orders = JSON.parse(fs.readFileSync(orderFile, 'utf8'))
    const order = orders.find(o => o.txid === ORDER_TXID)
    if (order) {
      order.remaining_quantity = (order.remaining_quantity || order.quantity) - FILL_QUANTITY
      order.fills = order.fills || []
      order.fills.push({
        txid,
        fill_price: FILL_PRICE,
        fill_quantity: FILL_QUANTITY,
        delivery_hash: DELIVERY_HASH,
        timestamp: Date.now(),
      })
      if (order.remaining_quantity <= 0) order.status = 'filled'
      fs.writeFileSync(orderFile, JSON.stringify(orders, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Order filled!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Paid:    ${fillAmount.toLocaleString()} sats`)
  console.log(`   ${isPartial ? 'Partial fill — order still open' : 'Full fill — order complete'}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

fill().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

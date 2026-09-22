#!/usr/bin/env node
// src/timeout.cjs — TIMEOUT: maker reclaims order value after expiry + grace period
//
// Usage: node src/timeout.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --order-txid <txid>
//
// Must be past expiryHeight + GRACE_BLOCKS (100 blocks)

const fs = require('fs')
const path = require('path')
const { bsv, Sig, toByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Order } = require('../dist/contracts/order')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getCurrentHeight
} = require('../lib/wallet.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const ORDER_TXID = args['order-txid']

if (!ORDER_TXID) {
  console.log('Usage: node src/timeout.cjs --wallet <path> --order-txid <txid>')
  process.exit(1)
}

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/order.json')
Order.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function timeout() {
  console.log('⏰ ORD1 — Timeout (Reclaim Order)')
  console.log(`   Order: ${ORDER_TXID.slice(0, 16)}...`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  // Fetch order tx
  const orderTxHex = await wocGetRaw(`/tx/${ORDER_TXID}/hex`)
  const orderTx = new bsv.Transaction(orderTxHex)

  // Find the covenant output
  let orderOutputIndex = 0
  let maxScriptLen = 0
  for (let i = 0; i < orderTx.outputs.length; i++) {
    const scriptLen = orderTx.outputs[i].script.toHex().length
    if (scriptLen > maxScriptLen && orderTx.outputs[i].satoshis > 0) {
      maxScriptLen = scriptLen
      orderOutputIndex = i
    }
  }

  const orderValue = orderTx.outputs[orderOutputIndex].satoshis
  console.log(`   Output:  [${orderOutputIndex}] (${maxScriptLen / 2} bytes script)`)
  console.log(`   Value:   ${orderValue} sats`)

  const currentHeight = await getCurrentHeight()

  // Load covenant
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const order = Order.fromTx(orderTx, orderOutputIndex)
  await order.connect(signer)

  console.log(`   Expiry:    Block ${order.expiryHeight}`)
  console.log(`   Current:   Block ${currentHeight}`)

  // GRACE_BLOCKS = 100 (must match covenant)
  const graceBlocks = 100n
  const timeoutHeight = Number(order.expiryHeight + graceBlocks)
  console.log(`   Timeout at: Block ${timeoutHeight}`)

  if (currentHeight < timeoutHeight) {
    console.error(`❌ Timeout not yet available (need block ${timeoutHeight}, current ${currentHeight})`)
    process.exit(1)
  }

  console.log(`   Status:   Grace period passed — full refund available`)
  console.log()

  // Build timeout tx
  order.bindTxBuilder('timeout', (current, options, sigArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Set locktime
    unsignedTx.nLockTime = currentHeight

    // Output 0: Full refund to maker
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: orderValue,
    }))

    // Output 1: OP_RETURN: ORD1 TIMEOUT
    const opReturnHex =
      '006a' +
      '04' + '4f524431' +
      '07' + '54494d454f5554'
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.fromHex(opReturnHex),
      satoshis: 0,
    }))

    return Promise.resolve({
      tx: unsignedTx,
      atInputIndex: 0,
      nexts: [],
    })
  })

  console.log('   Building timeout transaction...')

  const callResult = await order.methods.timeout(
    (sigResps) => sigResps[0].sig,
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

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
      orderEntry.status = 'timeout'
      orderEntry.timeout_txid = txid
      fs.writeFileSync(orderFile, JSON.stringify(orders, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Order reclaimed (timeout)!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Refund:  ${orderValue} sats`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

timeout().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

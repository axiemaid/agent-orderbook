#!/usr/bin/env node
// src/cancel.cjs — Cancel an ORD1 order
//
// Usage: node src/cancel.cjs --wallet <path> --order-txid <txid>

const fs = require('fs')
const path = require('path')
const { bsv } = require('scrypt-ts')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw
} = require('../lib/wallet.cjs')
const { encodeCancel, decodeOrd1, buildOpReturnScript } = require('../lib/protocol.cjs')

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const ORDER_TXID = args['order-txid']

if (!ORDER_TXID) {
  console.log('Usage: node src/cancel.cjs --wallet <path> --order-txid <txid>')
  process.exit(1)
}

async function cancel() {
  console.log('❌ ORD1 — Cancel Order')
  console.log(`   Order: ${ORDER_TXID.slice(0, 16)}...`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, address } = getKeypair(wallet)

  // Fetch order tx
  const orderTxHex = await wocGetRaw(`/tx/${ORDER_TXID}/hex`)
  const orderTx = new bsv.Transaction(orderTxHex)

  // Find the P2PKH order output (first non-OP_RETURN)
  let orderOutput = null
  let orderVout = 0
  for (let i = 0; i < orderTx.outputs.length; i++) {
    const script = orderTx.outputs[i].script
    if (!decodeOrd1(script.toHex()) && script.isPublicKeyHashOut()) {
      orderOutput = orderTx.outputs[i]
      orderVout = i
      break
    }
  }

  if (!orderOutput) {
    console.error('❌ Could not find order value output')
    process.exit(1)
  }

  console.log(`   Order value: ${orderOutput.satoshis} sats`)

  // Build cancel tx
  const tx = new bsv.Transaction()
  tx.from({
    txid: ORDER_TXID,
    vout: orderVout,
    script: orderOutput.script,
    satoshis: orderOutput.satoshis,
  })

  // Refund to maker (minus fee)
  const fee = 400
  const refund = orderOutput.satoshis - fee
  if (refund < 546) {
    console.error(`❌ Refund too small (${refund} sats, dust limit 546)`)
    process.exit(1)
  }
  tx.to(address, refund)

  // OP_RETURN: ORD1 CANCEL
  const cancelParts = encodeCancel({ orderTxid: ORDER_TXID, reason: 'cancelled by maker' })
  const opReturnHex = buildOpReturnScript(cancelParts)
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Sign
  tx.sign(privKey)

  const txhex = tx.uncheckedSerialize()
  console.log(`   TX size: ${txhex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const txid = await wocBroadcast(txhex)

  // Update state
  const orderFile = path.join(__dirname, '..', 'state', 'orders.json')
  if (fs.existsSync(orderFile)) {
    let orders = JSON.parse(fs.readFileSync(orderFile, 'utf8'))
    const order = orders.find(o => o.txid === ORDER_TXID)
    if (order) {
      order.status = 'cancelled'
      order.cancel_txid = txid
      fs.writeFileSync(orderFile, JSON.stringify(orders, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Order cancelled!`)
  console.log(`   TXID: ${txid}`)
  console.log(`   Refund: ${refund} sats`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

cancel().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

#!/usr/bin/env node
// src/place.cjs — Place an ORD1 order on-chain
//
// Usage: node src/place.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --type COMPUTE --side ASK --price 50 --quantity 500 \
//          --expiry 1000 --agent-id <REG1-txid-hex>

const fs = require('fs')
const path = require('path')
const {
  loadWallet, getKeypair, wocBroadcast, getUtxos, getCurrentHeight,
  generateNonce, sha256hex
} = require('../lib/wallet.cjs')
const { bsv } = require('scrypt-ts')
const { MARKET_TYPES, SIDES, encodePlace } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const TYPE_NAME = (args.type || 'COMPUTE').toUpperCase()
const SIDE_NAME = (args.side || 'ASK').toUpperCase()
const PRICE = parseInt(args.price)
const QUANTITY = parseInt(args.quantity)
const EXPIRY_OFFSET = parseInt(args.expiry || '1000') // blocks from now
const AGENT_ID = args['agent-id'] || '' // REG1 txid hex (32 bytes)

if (!PRICE || !QUANTITY) {
  console.log('Usage: node src/place.cjs --wallet <path> --type COMPUTE --side ASK --price 50 --quantity 500 [--expiry 1000] [--agent-id <hex>]')
  process.exit(1)
}

const TYPE = MARKET_TYPES[TYPE_NAME]
const SIDE = SIDES[SIDE_NAME]

if (TYPE === undefined) { console.error(`Unknown type: ${TYPE_NAME}`); process.exit(1) }
if (SIDE === undefined) { console.error(`Unknown side: ${SIDE_NAME}`); process.exit(1) }

// ─── Main ────────────────────────────────────────────────────────────

async function place() {
  console.log('📋 ORD1 — Place Order')
  console.log(`   Type:     ${TYPE_NAME} (${TYPE})`)
  console.log(`   Side:     ${SIDE_NAME} (${SIDE})`)
  console.log(`   Price:    ${PRICE} sats/unit`)
  console.log(`   Quantity: ${QUANTITY}`)
  console.log(`   Value:    ${(PRICE * QUANTITY).toLocaleString()} sats`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address, pubKeyHex } = getKeypair(wallet)

  console.log(`   Address:  ${address.toString()}`)

  // Get current height for expiry
  const currentHeight = await getCurrentHeight()
  const expiryHeight = currentHeight + EXPIRY_OFFSET
  console.log(`   Expiry:   Block ${expiryHeight} (current ${currentHeight} + ${EXPIRY_OFFSET})`)

  // Calculate order value and bond
  const orderValue = PRICE * QUANTITY
  const bondAmount = Math.max(10000, Math.floor(orderValue * 0.05))
  console.log(`   Bond:     ${bondAmount} sats`)

  // Get UTXOs
  const utxos = await getUtxos(address.toString())
  if (!utxos || utxos.length === 0) {
    console.error('❌ No UTXOs available')
    process.exit(1)
  }

  // Find a UTXO that covers order value + bond + fee
  const totalNeeded = orderValue + bondAmount + 500 // 500 sat fee estimate
  const utxo = utxos.find(u => u.satoshis >= totalNeeded)
  if (!utxo) {
    console.error(`❌ No single UTXO large enough (need ${totalNeeded} sats, largest: ${Math.max(...utxos.map(u => u.satoshis))})`)
    process.exit(1)
  }

  // If no script, fetch it from the tx
  let utxoScript = utxo.script
  if (!utxoScript) {
    const { wocGetRaw } = require('../lib/wallet.cjs')
    const txHex = await wocGetRaw(`/tx/${utxo.txid}/hex`)
    const bsvTx = new bsv.Transaction(txHex)
    utxoScript = bsvTx.outputs[utxo.vout].script.toHex()
  }

  // Build transaction
  const tx = new bsv.Transaction()
  tx.from({
    txid: utxo.txid,
    vout: utxo.vout,
    script: bsv.Script.fromHex(utxoScript),
    satoshis: utxo.satoshis,
  })

  // Output 0: Order value to maker P2PKH (will be replaced by covenant in production)
  // For now, P2PKH to self — the covenant script would lock this
  tx.to(address, orderValue)

  // Output 1: Bond to self (simplified — in production this would be bond covenant)
  tx.to(address, bondAmount)

  // Output 2: OP_RETURN — ORD1 PLACE (OP_FALSE OP_RETURN format for BSV)
  const nonce = generateNonce(16)
  const agentIdHex = AGENT_ID || '00'.repeat(20) // default: 20 zero bytes

  const placeParts = encodePlace({
    type: TYPE,
    side: SIDE,
    price: PRICE,
    quantity: QUANTITY,
    agentId: agentIdHex,
    expiryHeight: expiryHeight,
    bondRef: '00'.repeat(32), // will be set to txid after broadcast (indexer resolves)
    nonce: nonce,
  })

  const { buildOpReturnScript } = require('../lib/protocol.cjs')
  const opReturnHex = buildOpReturnScript(placeParts)
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Output 3: Change back to maker
  const feeEstimate = 500
  const changeAmount = utxo.satoshis - orderValue - bondAmount - feeEstimate
  if (changeAmount > 546) { // dust limit
    tx.to(address, changeAmount)
  }

  // Sign
  tx.sign(privKey)

  // Verify
  const txhex = tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)

  // Broadcast
  console.log('   Broadcasting...')
  const txid = await wocBroadcast(txhex)

  // Save to state
  const stateDir = path.join(__dirname, '..', 'state')
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })

  const orderFile = path.join(stateDir, 'orders.json')
  let orders = []
  if (fs.existsSync(orderFile)) orders = JSON.parse(fs.readFileSync(orderFile, 'utf8'))

  orders.push({
    txid,
    type: TYPE,
    type_name: TYPE_NAME,
    side: SIDE,
    side_name: SIDE_NAME,
    price: PRICE,
    quantity: QUANTITY,
    remaining_quantity: QUANTITY,
    order_value: orderValue,
    bond_amount: bondAmount,
    agent_id: agentIdHex,
    expiry_height: expiryHeight,
    placed_at_height: currentHeight,
    nonce,
    status: 'open',
    fills: [],
  })

  fs.writeFileSync(orderFile, JSON.stringify(orders, null, 2))

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Order placed!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Value:   ${orderValue.toLocaleString()} sats`)
  console.log(`   Bond:    ${bondAmount} sats`)
  console.log(`   Expiry:  Block ${expiryHeight}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

place().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

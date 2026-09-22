#!/usr/bin/env node
// src/place.cjs — Place an ORD1 order on-chain (with real covenant UTXO)
//
// Usage: node src/place.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --type COMPUTE --side ASK --price 50 --quantity 500 \
//          --expiry 1000 --agent-id <REG1-txid-hex>

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { bsv } = require('scrypt-ts')
const { Order } = require('../dist/contracts/order')
const {
  loadWallet, getKeypair, wocBroadcast, getUtxos, getCurrentHeight,
  generateNonce, sha256hex, wocGetRaw
} = require('../lib/wallet.cjs')
const { MARKET_TYPES, SIDES, encodePlace, buildOpReturnScript } = require('../lib/protocol.cjs')

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
const EXPIRY_OFFSET = parseInt(args.expiry || '1000')
const AGENT_ID = args['agent-id'] || ''

if (!PRICE || !QUANTITY) {
  console.log('Usage: node src/place.cjs --wallet <path> --type COMPUTE --side ASK --price 50 --quantity 500 [--expiry 1000] [--agent-id <hex>]')
  process.exit(1)
}

const TYPE = MARKET_TYPES[TYPE_NAME]
const SIDE = SIDES[SIDE_NAME]

if (TYPE === undefined) { console.error(`Unknown type: ${TYPE_NAME}`); process.exit(1) }
if (SIDE === undefined) { console.error(`Unknown side: ${SIDE_NAME}`); process.exit(1) }

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/order.json')
Order.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function place() {
  console.log('📋 ORD1 — Place Order (Covenant)')
  console.log(`   Type:     ${TYPE_NAME} (${TYPE})`)
  console.log(`   Side:     ${SIDE_NAME} (${SIDE})`)
  console.log(`   Price:    ${PRICE} sats/unit`)
  console.log(`   Quantity: ${QUANTITY}`)
  const orderValue = PRICE * QUANTITY
  console.log(`   Value:    ${orderValue.toLocaleString()} sats`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  const makerPubHex = pubKey.toString()
  const makerPkh = address.hashBuffer.toString('hex')

  console.log(`   Address:  ${address.toString()}`)
  console.log(`   PubKey:   ${makerPubHex.slice(0, 24)}...`)
  console.log(`   Pkh:      ${makerPkh}`)

  // Get current height for expiry
  const currentHeight = await getCurrentHeight()
  const expiryHeight = currentHeight + EXPIRY_OFFSET
  console.log(`   Expiry:   Block ${expiryHeight} (current ${currentHeight} + ${EXPIRY_OFFSET})`)

  // Calculate order value and bond
  const bondAmount = Math.max(10000, Math.floor(orderValue * 0.05))
  console.log(`   Bond:     ${bondAmount} sats`)

  // Create order covenant instance
  const order = new Order(
    makerPubHex,        // makerPub
    makerPkh,           // makerPkh
    BigInt(TYPE),       // orderType
    BigInt(SIDE),       // side
    BigInt(PRICE),      // price
    BigInt(expiryHeight), // expiryHeight
    BigInt(QUANTITY),   // remainingQuantity
  )

  const covenantScript = order.lockingScript
  console.log(`   Covenant script: ${covenantScript.toHex().length / 2} bytes`)

  // Get UTXOs
  const utxos = await getUtxos(address.toString())
  if (!utxos || utxos.length === 0) {
    console.error('❌ No UTXOs available')
    process.exit(1)
  }

  // Find a UTXO that covers order value + bond + fee
  const feeEstimate = 1000 // covenant scripts are larger
  const totalNeeded = orderValue + bondAmount + feeEstimate
  const utxo = utxos.find(u => u.satoshis >= totalNeeded)
  if (!utxo) {
    console.error(`❌ No single UTXO large enough (need ${totalNeeded} sats, largest: ${Math.max(...utxos.map(u => u.satoshis))})`)
    process.exit(1)
  }

  // Fetch script for the UTXO if not available
  let utxoScript = utxo.script
  if (!utxoScript) {
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

  // Output 0: Order covenant UTXO (locked by covenant script)
  tx.addOutput(new bsv.Transaction.Output({
    script: covenantScript,
    satoshis: orderValue,
  }))

  // Output 1: Bond (simplified — P2PKH to self, would be bond covenant in production)
  tx.to(address, bondAmount)

  // Output 2: OP_RETURN — ORD1 PLACE
  const nonce = crypto.randomBytes(16).toString('hex')
  const agentIdHex = AGENT_ID || '00'.repeat(20)

  const placeParts = encodePlace({
    type: TYPE,
    side: SIDE,
    price: PRICE,
    quantity: QUANTITY,
    agentId: agentIdHex,
    expiryHeight: expiryHeight,
    bondRef: '00'.repeat(32),
    nonce: nonce,
  })

  const opReturnHex = buildOpReturnScript(placeParts)
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Output 3: Change back to maker
  const changeAmount = utxo.satoshis - orderValue - bondAmount - feeEstimate
  if (changeAmount > 546) {
    tx.to(address, changeAmount)
  }

  // Sign
  tx.sign(privKey)

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
    covenant: true,
    fills: [],
  })

  fs.writeFileSync(orderFile, JSON.stringify(orders, null, 2))

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Order placed (covenant UTXO)!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Value:   ${orderValue.toLocaleString()} sats (locked in covenant)`)
  console.log(`   Bond:    ${bondAmount} sats`)
  console.log(`   Expiry:  Block ${expiryHeight}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

place().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

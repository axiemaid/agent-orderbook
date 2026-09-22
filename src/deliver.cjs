#!/usr/bin/env node
// src/deliver.cjs — DELIVER: seller proves delivery, releases payment
//
// Usage: node src/deliver.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --delivery-txid <txid> --proof-type 0
//
// The delivery UTXO is created in a FILL transaction (future feature).
// For testing, we'll create a standalone delivery covenant UTXO first.

const fs = require('fs')
const path = require('path')
const { bsv, PubKey, Sig, toByteString, int2ByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Delivery } = require('../dist/contracts/delivery')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getUtxos, getCurrentHeight
} = require('../lib/wallet.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
const booleanFlags = new Set(['deploy', 'create', 'release'])
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '')
  if (booleanFlags.has(key)) {
    args[key] = 'true'
  } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
    args[key] = process.argv[i + 1]
    i++
  }
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const DELIVERY_TXID = args['delivery-txid']
const PROOF_TYPE = parseInt(args['proof-type'] ?? '0')
const SUBCOMMAND = process.argv.includes('--deploy') ? 'deploy' : (DELIVERY_TXID ? 'release' : 'deploy')

// Proof types
const PROOF_INSTANT = 0
const PROOF_TX_REF = 1
const PROOF_HASH_LOCK = 2
const PROOF_ORACLE = 3

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/delivery.json')
Delivery.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  if (process.argv.includes('--deploy') || args.deploy) {
    await deployDelivery(address, pubKey, privKey)
  } else if (DELIVERY_TXID) {
    await releaseDelivery(DELIVERY_TXID, address, pubKey, privKey)
  } else {
    console.log('Usage:')
    console.log('  Deploy:  node src/deliver.cjs --deploy --wallet <path> --seller-pkh <hex> --buyer-pkh <hex> --amount <sats> --delivery-hash <hex>')
    console.log('  Release: node src/deliver.cjs --delivery-txid <txid> --wallet <path> --proof-type 0')
    process.exit(0)
  }
}

async function deployDelivery(address, pubKey, privKey) {
  const SELLER_PKH = args['seller-pkh'] || address.hashBuffer.toString('hex')
  const BUYER_PKH = args['buyer-pkh'] || address.hashBuffer.toString('hex')
  const AMOUNT = parseInt(args.amount || '10000')
  const DELIVERY_HASH = args['delivery-hash'] || '00'.repeat(32)

  console.log('📦 ORD1 — Deploy Delivery Covenant')
  console.log(`   Seller Pkh: ${SELLER_PKH}`)
  console.log(`   Buyer Pkh:  ${BUYER_PKH}`)
  console.log(`   Amount:     ${AMOUNT} sats`)
  console.log(`   Delivery:  ${DELIVERY_HASH === '00'.repeat(32) ? 'instant (no hash)' : DELIVERY_HASH.slice(0, 16) + '...'}`)
  console.log()

  const currentHeight = await getCurrentHeight()
  console.log(`   Fill height: ${currentHeight}`)

  // For testing, seller and buyer are the same wallet
  const sellerPub = pubKey.toString()
  const buyerPub = pubKey.toString()

  const delivery = new Delivery(
    sellerPub,
    SELLER_PKH,
    buyerPub,
    BUYER_PKH,
    DELIVERY_HASH,
    BigInt(currentHeight),
  )

  const covenantScript = delivery.lockingScript
  console.log(`   Covenant script: ${covenantScript.toHex().length / 2} bytes`)

  // Get UTXOs
  const utxos = await getUtxos(address.toString())
  if (!utxos || utxos.length === 0) {
    console.error('❌ No UTXOs available')
    process.exit(1)
  }

  const feeEstimate = 1000
  const totalNeeded = AMOUNT + feeEstimate
  const utxo = utxos.find(u => u.satoshis >= totalNeeded)
  if (!utxo) {
    console.error(`❌ No UTXO large enough (need ${totalNeeded} sats)`)
    process.exit(1)
  }

  let utxoScript = utxo.script
  if (!utxoScript) {
    const txHex = await wocGetRaw(`/tx/${utxo.txid}/hex`)
    const bsvTx = new bsv.Transaction(txHex)
    utxoScript = bsvTx.outputs[utxo.vout].script.toHex()
  }

  const tx = new bsv.Transaction()
  tx.from({
    txid: utxo.txid,
    vout: utxo.vout,
    script: bsv.Script.fromHex(utxoScript),
    satoshis: utxo.satoshis,
  })

  // Output 0: Delivery covenant UTXO
  tx.addOutput(new bsv.Transaction.Output({
    script: covenantScript,
    satoshis: AMOUNT,
  }))

  // Output 1: Change
  const change = utxo.satoshis - AMOUNT - feeEstimate
  if (change > 546) {
    tx.to(address, change)
  }

  tx.sign(privKey)
  const txhex = tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)
  console.log('   Broadcasting...')

  const txid = await wocBroadcast(txhex)

  // Save to state
  const stateDir = path.join(__dirname, '..', 'state')
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })
  const deliveryFile = path.join(stateDir, 'deliveries.json')
  let deliveries = []
  if (fs.existsSync(deliveryFile)) deliveries = JSON.parse(fs.readFileSync(deliveryFile, 'utf8'))
  deliveries.push({
    txid,
    seller_pkh: SELLER_PKH,
    buyer_pkh: BUYER_PKH,
    amount: AMOUNT,
    delivery_hash: DELIVERY_HASH,
    fill_height: currentHeight,
    status: 'pending',
  })
  fs.writeFileSync(deliveryFile, JSON.stringify(deliveries, null, 2))

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Delivery covenant deployed!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Amount:  ${AMOUNT} sats (locked in delivery covenant)`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

async function releaseDelivery(deliveryTxid, address, pubKey, privKey) {
  console.log('📦 ORD1 — Deliver (Release Payment)')
  console.log(`   Delivery: ${deliveryTxid.slice(0, 16)}...`)
  console.log(`   Proof:    Type ${PROOF_TYPE}`)
  console.log()

  // Fetch delivery tx
  const deliveryTxHex = await wocGetRaw(`/tx/${deliveryTxid}/hex`)
  const deliveryTx = new bsv.Transaction(deliveryTxHex)

  // Find the covenant output (largest script)
  let deliveryOutputIndex = 0
  let maxScriptLen = 0
  for (let i = 0; i < deliveryTx.outputs.length; i++) {
    const scriptLen = deliveryTx.outputs[i].script.toHex().length
    if (scriptLen > maxScriptLen && deliveryTx.outputs[i].satoshis > 0) {
      maxScriptLen = scriptLen
      deliveryOutputIndex = i
    }
  }

  const deliveryValue = deliveryTx.outputs[deliveryOutputIndex].satoshis
  console.log(`   Output:   [${deliveryOutputIndex}] (${maxScriptLen / 2} bytes script)`)
  console.log(`   Value:    ${deliveryValue} sats`)

  // Load covenant from tx
  // Use the real private key as signer (must match seller for deliver, buyer for refund/dispute)
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const delivery = Delivery.fromTx(deliveryTx, deliveryOutputIndex)
  await delivery.connect(signer)

  console.log(`   Seller:   ${delivery.sellerPkh}`)
  console.log(`   Buyer:    ${delivery.buyerPkh}`)
  delivery.bindTxBuilder('deliver', (current, options, sigArg, proofTypeArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Output 0: Payment to seller (full UTXO value)
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: deliveryValue,
    }))

    // Output 1: OP_RETURN — ORD1 DELIVER
    // Must match covenant's expected format exactly
    const opReturnHex =
      '006a' +
      '04' + '4f524431' +     // "ORD1"
      '07' + '44454c49564552' + // "DELIVER"
      '01' + int2ByteString(proofTypeArg, 1n) // proof type
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

  console.log('   Building delivery transaction...')

  const callResult = await delivery.methods.deliver(
    (sigResps) => sigResps[0].sig,
    BigInt(PROOF_TYPE),
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

  // Sign with seller's key
  callResult.tx.sign(privKey)

  const txhex = callResult.tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const txid = await wocBroadcast(txhex)

  // Update state
  const stateDir = path.join(__dirname, '..', 'state')
  const deliveryFile = path.join(stateDir, 'deliveries.json')
  if (fs.existsSync(deliveryFile)) {
    let deliveries = JSON.parse(fs.readFileSync(deliveryFile, 'utf8'))
    const d = deliveries.find(d => d.txid === deliveryTxid)
    if (d) {
      d.status = 'delivered'
      d.deliver_txid = txid
      d.proof_type = PROOF_TYPE
      fs.writeFileSync(deliveryFile, JSON.stringify(deliveries, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Payment delivered!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Released: ${deliveryValue} sats to seller`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

#!/usr/bin/env node
// src/refund.cjs — REFUND: buyer reclaims payment after delivery window expires
//
// Usage: node src/refund.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --delivery-txid <txid>

const fs = require('fs')
const path = require('path')
const { bsv, Sig, toByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Delivery } = require('../dist/contracts/delivery')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getCurrentHeight
} = require('../lib/wallet.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const DELIVERY_TXID = args['delivery-txid']

if (!DELIVERY_TXID) {
  console.log('Usage: node src/refund.cjs --wallet <path> --delivery-txid <txid>')
  process.exit(1)
}

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/delivery.json')
Delivery.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function refund() {
  console.log('↩️  ORD1 — Refund (Delivery Timeout)')
  console.log(`   Delivery: ${DELIVERY_TXID.slice(0, 16)}...`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  // Fetch delivery tx
  const deliveryTxHex = await wocGetRaw(`/tx/${DELIVERY_TXID}/hex`)
  const deliveryTx = new bsv.Transaction(deliveryTxHex)

  // Find the covenant output
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
  console.log(`   Output:  [${deliveryOutputIndex}] (${maxScriptLen / 2} bytes script)`)
  console.log(`   Value:   ${deliveryValue} sats`)

  const currentHeight = await getCurrentHeight()

  // Load covenant
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const delivery = Delivery.fromTx(deliveryTx, deliveryOutputIndex)
  await delivery.connect(signer)

  console.log(`   Fill height:  ${delivery.fillHeight}`)
  console.log(`   Current:      ${currentHeight}`)

  // DELIVERY_WINDOW = 1000 blocks
  const refundHeight = Number(delivery.fillHeight) + 1000
  console.log(`   Refund at:    Block ${refundHeight}`)

  if (currentHeight < refundHeight) {
    console.error(`❌ Delivery window not expired (need block ${refundHeight}, current ${currentHeight})`)
    process.exit(1)
  }

  console.log(`   Status:       Window expired — refund available`)
  console.log()

  // Build refund tx
  delivery.bindTxBuilder('refund', (current, options, sigArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Set locktime for the tx
    unsignedTx.nLockTime = currentHeight

    // Output 0: Full refund to buyer
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: deliveryValue,
    }))

    // Output 1: OP_RETURN: ORD1 REFUND
    const opReturnHex =
      '006a' +
      '04' + '4f524431' +
      '06' + '52455455524e'
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

  console.log('   Building refund transaction...')

  const callResult = await delivery.methods.refund(
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
  const deliveryFile = path.join(stateDir, 'deliveries.json')
  if (fs.existsSync(deliveryFile)) {
    let deliveries = JSON.parse(fs.readFileSync(deliveryFile, 'utf8'))
    const d = deliveries.find(d => d.txid === DELIVERY_TXID)
    if (d) {
      d.status = 'refunded'
      d.refund_txid = txid
      fs.writeFileSync(deliveryFile, JSON.stringify(deliveries, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Payment refunded!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Refund:  ${deliveryValue} sats to buyer`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

refund().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

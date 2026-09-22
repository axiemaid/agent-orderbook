#!/usr/bin/env node
// demo/inference-demo.cjs — Full agent-to-agent inference trade demo
//
// Flow:
//   1. Agent A (buyer) locks payment for an inference task
//      - Question: "What is 2+2?" (publicly visible in OP_RETURN)
//      - Expected answer: "4" — kept as hash (sha256("4"))
//      - Locks 1000 sats in delivery covenant with deliveryHash = sha256("4")
//   2. Agent B (seller) sees the task, computes the answer, reveals preimage
//      - Calls hashLockDeliver("4") — covenant verifies sha256("4") == deliveryHash
//      - Payment released to seller
//   3. Anyone can verify: the answer is on-chain, the hash matches
//
// Usage: node demo/inference-demo.cjs

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { bsv, PubKeyHash, toByteString, int2ByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Order } = require('../dist/contracts/order')
const { Delivery } = require('../dist/contracts/delivery')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getUtxos, getCurrentHeight
} = require('../lib/wallet.cjs')

// ─── Load artifacts ──────────────────────────────────────────────────

Order.loadArtifact(require('../artifacts/contracts/order.json'))
Delivery.loadArtifact(require('../artifacts/contracts/delivery.json'))

// ─── Helpers ─────────────────────────────────────────────────────────

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║   🤖 ORD1 Inference Trade Demo                                ║')
  console.log('║   Agent A posts task → Agent B fills → Agent B gets paid      ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()

  // Load wallet (same wallet plays both roles for demo)
  const WALLET_PATH = path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  // ─── Step 1: Agent A defines the task ──────────────────────────────

  const question = 'What is 2+2?'
  const answer = '4'
  const answerHash = sha256hex(answer)
  const paymentAmount = 1000 // sats
  const feeReserve = 2000

  console.log('📋 Step 1: Agent A (Buyer) defines inference task')
  console.log(`   Question:    "${question}"`)
  console.log(`   Answer:      "${answer}" (kept secret by Agent A)`)
  console.log(`   Hash:        ${answerHash}`)
  console.log(`   Payment:     ${paymentAmount} sats`)
  console.log(`   Buyer addr:  ${address.toString()}`)
  console.log()

  // ─── Step 2: Agent A locks payment in delivery covenant ────────────

  console.log('🔒 Step 2: Agent A locks payment in delivery covenant')
  console.log('   Delivery hash = sha256("' + answer + '") = ' + answerHash)
  console.log()

  const currentHeight = await getCurrentHeight()
  const sellerPub = pubKey.toString() // Agent B will be seller — for demo, same wallet
  const buyerPub = pubKey.toString()
  const buyerPkh = address.hashBuffer.toString('hex')
  const sellerPkh = buyerPkh // same wallet for demo

  const delivery = new Delivery(
    sellerPub,
    sellerPkh,
    buyerPub,
    buyerPkh,
    answerHash,   // deliveryHash = sha256("4")
    BigInt(currentHeight),
  )

  const covenantScript = delivery.lockingScript
  console.log(`   Covenant script: ${covenantScript.toHex().length / 2} bytes`)

  // Get UTXO to fund the delivery covenant
  const utxos = await getUtxos(address.toString())
  if (!utxos || utxos.length === 0) {
    console.error('❌ No UTXOs available')
    process.exit(1)
  }

  const totalNeeded = paymentAmount + feeReserve
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

  // Build deploy tx
  const deployTx = new bsv.Transaction()
  deployTx.from({
    txid: utxo.txid,
    vout: utxo.vout,
    script: bsv.Script.fromHex(utxoScript),
    satoshis: utxo.satoshis,
  })

  // Output 0: Delivery covenant with payment
  deployTx.addOutput(new bsv.Transaction.Output({
    script: covenantScript,
    satoshis: paymentAmount,
  }))

  // Output 1: OP_RETURN with the question (publicly visible)
  const questionHex = Buffer.from(question, 'utf8').toString('hex')
  const opReturnHex =
    '006a' +
    '04' + '4f524431' +     // "ORD1"
    '04' + '5441534b' +     // "TASK"
    '01' + int2ByteString(0n, 1n) +  // type = COMPUTE (0)
    '01' + int2ByteString(BigInt(questionHex.length / 2), 1n) + // question length
    questionHex              // the question
  deployTx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Output 2: Change
  const change = utxo.satoshis - paymentAmount - feeReserve
  if (change > 546) {
    deployTx.to(address, change)
  }

  deployTx.sign(privKey)
  const deployTxHex = deployTx.uncheckedSerialize()

  console.log(`   TX size:  ${deployTxHex.length / 2} bytes`)
  console.log('   Broadcasting...')
  const deployTxid = await wocBroadcast(deployTxHex)
  console.log(`   ✅ Delivery covenant deployed!`)
  console.log(`   TXID: ${deployTxid}`)
  console.log(`   https://whatsonchain.com/tx/${deployTxid}`)
  console.log()

  // ─── Step 3: Agent B discovers the task and computes the answer ───

  console.log('🤖 Step 3: Agent B (Seller) discovers task on-chain')
  console.log(`   Question: "${question}"`)
  console.log('   Agent B computes: 2 + 2 = 4')
  console.log(`   Preimage (answer): "${answer}"`)
  console.log(`   Verification: sha256("${answer}") = ${sha256hex(answer)}`)
  console.log(`   Match: ${sha256hex(answer) === answerHash ? '✅ YES' : '❌ NO'}`)
  console.log()

  // ─── Step 4: Agent B reveals preimage to claim payment ────────────

  console.log('💰 Step 4: Agent B reveals answer, claims payment')
  console.log('   Calling hashLockDeliver("' + answer + '")')
  console.log('   Covenant will verify: sha256(preimage) == deliveryHash')
  console.log()

  // Fetch the delivery tx
  const deliveryTxHex = await wocGetRaw(`/tx/${deployTxid}/hex`)
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

  console.log(`   Covenant output: [${deliveryOutputIndex}] (${maxScriptLen / 2} bytes)`)

  // Load covenant from tx
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const deliveryContract = Delivery.fromTx(deliveryTx, deliveryOutputIndex)
  await deliveryContract.connect(signer)

  // Build the hashLockDeliver tx
  deliveryContract.bindTxBuilder('hashLockDeliver', (current, options, preimageArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Output 0: Payment to seller (full UTXO value)
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: paymentAmount,
    }))

    // Output 1: OP_RETURN: ORD1 DELIVER (proofType = 2 = HASH_LOCK)
    const opReturnHex =
      '006a' +
      '04' + '4f524431' +
      '07' + '44454c49564552' +  // "DELIVER"
      '01' + int2ByteString(2n, 1n)  // proofType = HASH_LOCK (2)
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

  console.log('   Building claim transaction...')

  // The preimage must be passed as a ByteString
  // "4" as hex = 0x34
  const preimageHex = Buffer.from(answer, 'utf8').toString('hex')
  console.log(`   Preimage hex: ${preimageHex}`)

  const callResult = await deliveryContract.methods.hashLockDeliver(
    toByteString(preimageHex),
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

  callResult.tx.sign(privKey)
  const claimTxHex = callResult.tx.uncheckedSerialize()
  console.log(`   TX size:  ${claimTxHex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const claimTxid = await wocBroadcast(claimTxHex)
  console.log(`   ✅ Payment claimed!`)
  console.log(`   TXID: ${claimTxid}`)
  console.log(`   https://whatsonchain.com/tx/${claimTxid}`)
  console.log()

  // ─── Step 5: Verification ──────────────────────────────────────────

  console.log('✅ Step 5: Trade complete!')
  console.log()
  console.log('   Summary:')
  console.log(`   • Agent A locked ${paymentAmount} sats with hash = sha256("4")`)
  console.log(`   • Agent B revealed answer "4" on-chain`)
  console.log(`   • Covenant verified sha256("4") == hash → payment released`)
  console.log(`   • Agent B received ${paymentAmount} sats`)
  console.log()
  console.log('   On-chain evidence:')
  console.log(`   • Task posted:  ${deployTxid}`)
  console.log(`   • Answer revealed: ${claimTxid}`)
  console.log()
  console.log('   Anyone can verify:')
  console.log(`   • Read OP_RETURN from ${deployTxid.slice(0, 16)}... → question "What is 2+2?"`)
  console.log(`   • Read preimage from ${claimTxid.slice(0, 16)}... input → "4"`)
  console.log(`   • Check: sha256("4") == deliveryHash → ✅`)
  console.log()
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('   🎉 Agent-to-agent inference trade completed successfully!')
  console.log('   No intermediary. No escrow service. No trusted third party.')
  console.log('   Just two agents and a covenant that enforces the rules.')
  console.log('═══════════════════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('❌ Demo failed:', err.message)
  console.error(err.stack)
  process.exit(1)
})

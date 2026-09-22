#!/usr/bin/env node
// demo/agent-a-post.cjs — Agent A posts an inference task on-chain
//
// Agent A has a question and an expected answer. They lock payment
// in a delivery covenant with deliveryHash = sha256(expectedAnswer).
// The question is posted in an OP_RETURN — publicly visible.
//
// Usage: node demo/agent-a-post.cjs --question "What is 2+2?" --answer "4" --amount 1000

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { bsv, toByteString, int2ByteString } = require('scrypt-ts')
const { Delivery } = require('../dist/contracts/delivery')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getUtxos, getCurrentHeight
} = require('../lib/wallet.cjs')

Delivery.loadArtifact(require('../artifacts/contracts/delivery.json'))

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].replace(/^--/, '')
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      args[key] = process.argv[i + 1]
      i++
    } else {
      args[key] = true
    }
  }
}

const QUESTION = args.question || 'What is 2+2?'
const ANSWER = args.answer || '4'
const AMOUNT = parseInt(args.amount || '1000')
const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('🅰️  Agent A — Posting Inference Task')
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  const answerHash = crypto.createHash('sha256').update(ANSWER).digest('hex')
  const buyerPkh = address.hashBuffer.toString('hex')

  console.log(`   Question:    "${QUESTION}"`)
  console.log(`   Answer:      "${ANSWER}" (secret — only hash goes on-chain)`)
  console.log(`   Hash:        ${answerHash}`)
  console.log(`   Payment:     ${AMOUNT} sats`)
  console.log(`   Agent A addr: ${address.toString()}`)
  console.log()

  const currentHeight = await getCurrentHeight()
  console.log(`   Block height: ${currentHeight}`)
  console.log()

  // Create delivery covenant
  console.log('🔒 Locking payment in delivery covenant...')
  const delivery = new Delivery(
    pubKey.toString(),  // sellerPub — Agent B's key will be needed to claim
    '00'.repeat(20),    // sellerPkh — placeholder, Agent B will provide
    pubKey.toString(),  // buyerPub — Agent A
    buyerPkh,           // buyerPkh
    answerHash,         // deliveryHash = sha256(answer)
    BigInt(currentHeight),
  )

  // Wait — the seller needs to be Agent B, not Agent A.
  // The covenant's deliver/hashLockDeliver pays to sellerPkh.
  // But for hashLockDeliver, there's no sig check — anyone who reveals the preimage gets paid.
  // Actually, hashLockDeliver pays to this.sellerPkh. So we need to set sellerPkh to Agent B.
  // But we don't know Agent B's key yet... unless we make it a hash-lock only (anyone can claim).
  //
  // For a true open task: sellerPkh = 00*20 (anyone who knows the answer gets paid)
  // But P2PKH with all-zero hash is not standard...
  //
  // Better approach: sellerPkh = buyerPkh for now (same person), but the hash-lock
  //   means anyone who reveals the preimage can build the claim tx.
  //   The output goes to sellerPkh regardless.
  //
  // Actually, looking at hashLockDeliver: it pays to this.sellerPkh.
  // If sellerPkh = Agent B's pkh, then only Agent B can receive.
  // But Agent A doesn't know Agent B...
  //
  // For this demo: Agent A sets sellerPkh = Agent B's pkh (from bsv-wallet-local.json)
  // because we know Agent B's address ahead of time.
  // In a real system: the task would be open to anyone, and sellerPkh would be
  // set by the filler in a FILL transaction (delivery covenant created at fill time).

  // Load Agent B's wallet to get their address (for sellerPkh)
  // Agent A only needs Agent B's address — NOT their private key
  const agentBWalletRaw = loadWallet(path.join(process.env.HOME, '.openclaw', 'bsv-wallet-local.json'))
  const agentBAddr = agentBWalletRaw.address
  const agentBPkh = bsv.Address.fromString(agentBAddr, bsv.Networks.mainnet).hashBuffer.toString('hex')
  // For sellerPub: derive from Agent B's address (we don't have their privKey)
  // Actually, hashLockDeliver doesn't check sig — it only pays to sellerPkh.
  // The deliver() method checks sig, but we won't use that path.
  // So sellerPub can be any valid pubkey — it's not used in hashLockDeliver.
  // Use Agent A's pubkey as placeholder (won't be checked).
  console.log(`   Agent B addr: ${agentBAddr}`)
  console.log(`   Agent B pkh:  ${agentBPkh}`)
  console.log()

  // Recreate delivery with Agent B as seller
  const delivery2 = new Delivery(
    pubKey.toString(), // sellerPub (placeholder — not used by hashLockDeliver)
    agentBPkh,        // sellerPkh (Agent B) — payment goes here
    pubKey.toString(), // buyerPub (Agent A)
    buyerPkh,         // buyerPkh (Agent A)
    answerHash,       // deliveryHash
    BigInt(currentHeight),
  )

  const covenantScript = delivery2.lockingScript
  console.log(`   Covenant script: ${covenantScript.toHex().length / 2} bytes`)

  // Get UTXOs
  const utxos = await getUtxos(address.toString())
  if (!utxos || utxos.length === 0) {
    console.error('❌ No UTXOs available for Agent A')
    process.exit(1)
  }

  const feeReserve = 2000
  const totalNeeded = AMOUNT + feeReserve
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

  // Build tx
  const tx = new bsv.Transaction()
  tx.from({
    txid: utxo.txid,
    vout: utxo.vout,
    script: bsv.Script.fromHex(utxoScript),
    satoshis: utxo.satoshis,
  })

  // Output 0: Delivery covenant
  tx.addOutput(new bsv.Transaction.Output({
    script: covenantScript,
    satoshis: AMOUNT,
  }))

  // Output 1: OP_RETURN with task details
  const questionHex = Buffer.from(QUESTION, 'utf8').toString('hex')
  const qLen = Math.floor(questionHex.length / 2)
  const opReturnHex =
    '006a' +
    '04' + '4f524431' +     // "ORD1"
    '04' + '5441534b' +     // "TASK"
    '01' + int2ByteString(0n, 1n) +  // type = COMPUTE (0)
    '01' + int2ByteString(BigInt(qLen), 1n) + // question length (1 byte)
    questionHex              // the question
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Output 2: Change
  const change = utxo.satoshis - AMOUNT - feeReserve
  if (change > 546) {
    tx.to(address, change)
  }

  tx.sign(privKey)
  const txhex = tx.uncheckedSerialize()

  console.log(`   TX size:  ${txhex.length / 2} bytes`)
  console.log('   Broadcasting...')
  const txid = await wocBroadcast(txhex)

  // Save task info for Agent B
  const taskFile = path.join(__dirname, '..', 'state', 'tasks.json')
  const stateDir = path.dirname(taskFile)
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })
  let tasks = []
  if (fs.existsSync(taskFile)) tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8'))
  tasks.push({
    txid,
    question: QUESTION,
    answer_hash: answerHash,
    amount: AMOUNT,
    seller_pkh: agentBPkh,
    buyer_pkh: buyerPkh,
    posted_at_height: currentHeight,
    timestamp: Date.now(),
    status: 'open',
  })
  fs.writeFileSync(taskFile, JSON.stringify(tasks, null, 2))

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log('   ✅ Task posted on-chain!')
  console.log(`   TXID:    ${txid}`)
  console.log(`   Payment: ${AMOUNT} sats locked`)
  console.log(`   Question: "${QUESTION}"`)
  console.log(`   Hash:    ${answerHash}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
  console.log()
  console.log('   Agent B can now:')
  console.log('   1. Scan the blockchain for ORD1 TASK outputs')
  console.log('   2. Read the question from OP_RETURN')
  console.log('   3. Compute the answer')
  console.log('   4. Reveal the answer to claim payment')
  console.log()
  console.log(`   Run: node demo/agent-b-scan.cjs`)
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

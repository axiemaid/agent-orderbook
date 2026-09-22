#!/usr/bin/env node
// demo/agent-b-scan.cjs — Agent B discovers tasks via API, computes answers, claims payment
//
// Agent B:
//   1. Queries the task API for open inference tasks
//   2. Picks a task, reads the question
//   3. Computes the answer
//   4. Reveals the preimage to claim payment
//
// Usage:
//   Start the API first:   node src/task-api.cjs --port 3010
//   Then run Agent B:      node demo/agent-b-scan.cjs
//   Or specify API URL:    node demo/agent-b-scan.cjs --api http://localhost:3010

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const { bsv, toByteString, int2ByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
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

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet-local.json')
const API_URL = args.api || 'http://localhost:3010'

// ─── HTTP helper ────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}`)) }
      })
    }).on('error', reject)
  })
}

// ─── Inference engine ───────────────────────────────────────────────

function computeAnswer(question) {
  // Simple inference engine — parses math questions
  // In a real system, this would call an LLM or computation service
  const match = question.match(/What is (\d+)\s*([+\-*/])\s*(\d+)\?/)
  if (match) {
    const a = parseInt(match[1])
    const op = match[2]
    const b = parseInt(match[3])
    let result
    switch (op) {
      case '+': result = a + b; break
      case '-': result = a - b; break
      case '*': result = a * b; break
      case '/': result = Math.floor(a / b); break
      default: throw new Error(`Unknown operator: ${op}`)
    }
    return String(result)
  }
  throw new Error(`Cannot compute answer for: "${question}"`)
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('🅱️  Agent B — Task Discovery & Claim')
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  console.log(`   Agent B addr: ${address.toString()}`)
  console.log(`   API:         ${API_URL}`)
  console.log()

  // ─── Query the API for open tasks ────────────────────────────────

  console.log('🔍 Querying task API for open tasks...')
  const response = await httpGet(`${API_URL}/tasks`)

  if (!response.tasks || response.tasks.length === 0) {
    console.log()
    console.log('   No open tasks found.')
    console.log('   Post a task first:')
    console.log('   node demo/agent-a-post.cjs --question "What is 15+27?" --answer "42" --amount 1000')
    return
  }

  console.log(`   Found ${response.count} open task(s):`)
  response.tasks.forEach((t, i) => {
    console.log(`   ${i + 1}. "${t.question}" — ${t.payment} sats (${t.txid.slice(0, 16)}...)`)
  })
  console.log()

  // Pick the first task (or a random one if multiple)
  const task = response.tasks[0]
  console.log(`   Selected: "${task.question}" — ${task.payment} sats`)
  console.log(`   TXID: ${task.txid}`)
  console.log()

  // ─── Compute the answer ─────────────────────────────────────────

  console.log('🧠 Computing answer...')
  const answer = computeAnswer(task.question)
  const answerHash = crypto.createHash('sha256').update(answer).digest('hex')

  console.log(`   Question:  "${task.question}"`)
  console.log(`   Answer:    "${answer}"`)
  console.log(`   Hash:      ${answerHash}`)
  console.log()

  // ─── Fetch the delivery covenant from chain ─────────────────────

  console.log('💰 Fetching delivery covenant...')
  const taskTxHex = await wocGetRaw(`/tx/${task.txid}/hex`)
  const taskTx = new bsv.Transaction(taskTxHex)

  // Find the covenant output (largest script with value > 0)
  let deliveryOutputIndex = 0
  let maxScriptLen = 0
  for (let i = 0; i < taskTx.outputs.length; i++) {
    const scriptLen = taskTx.outputs[i].script.toHex().length
    if (scriptLen > maxScriptLen && taskTx.outputs[i].satoshis > 0) {
      maxScriptLen = scriptLen
      deliveryOutputIndex = i
    }
  }

  const deliveryValue = taskTx.outputs[deliveryOutputIndex].satoshis
  console.log(`   Covenant output: [${deliveryOutputIndex}] (${maxScriptLen / 2} bytes)`)
  console.log(`   Payment locked:  ${deliveryValue} sats`)

  // Load the delivery covenant from the on-chain tx
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const delivery = Delivery.fromTx(taskTx, deliveryOutputIndex)
  await delivery.connect(signer)

  // Verify the hash matches
  console.log()
  console.log(`   Covenant deliveryHash: ${delivery.deliveryHash}`)
  console.log(`   Computed hash:         ${answerHash}`)
  console.log(`   Match: ${delivery.deliveryHash === answerHash ? '✅ YES' : '❌ NO — cannot claim'}`)
  console.log()

  if (delivery.deliveryHash !== answerHash) {
    console.error('❌ Answer hash does not match delivery hash — wrong answer or wrong task')
    process.exit(1)
  }

  // ─── Claim payment by revealing preimage ───────────────────────

  console.log('🔑 Revealing answer to claim payment...')

  delivery.bindTxBuilder('hashLockDeliver', (current, options, preimageArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Output 0: Payment to seller (Agent B)
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: deliveryValue,
    }))

    // Output 1: OP_RETURN: ORD1 DELIVER (proofType = 2 = HASH_LOCK)
    const opReturnHex =
      '006a' +
      '04' + '4f524431' +
      '07' + '44454c49564552' +
      '01' + int2ByteString(2n, 1n)
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

  const preimageHex = Buffer.from(answer, 'utf8').toString('hex')
  console.log(`   Preimage: "${answer}" (hex: ${preimageHex})`)

  const callResult = await delivery.methods.hashLockDeliver(
    toByteString(preimageHex),
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

  callResult.tx.sign(privKey)

  const txhex = callResult.tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const claimTxid = await wocBroadcast(txhex)

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log('   ✅ Payment claimed!')
  console.log(`   TXID:    ${claimTxid}`)
  console.log(`   Payment: ${deliveryValue} sats → Agent B (${address.toString()})`)
  console.log(`   Answer:  "${answer}"`)
  console.log(`   https://whatsonchain.com/tx/${claimTxid}`)
  console.log('═══════════════════════════════════════════════')
  console.log()
  console.log('   Trade complete (via API discovery):')
  console.log(`   • Agent A locked ${deliveryValue} sats with sha256("${answer}")`)
  console.log(`   • Agent B discovered task via API, computed answer, revealed it`)
  console.log(`   • Covenant verified sha256("${answer}") == hash → released payment`)
  console.log(`   • Agent B received ${deliveryValue} sats`)
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

#!/usr/bin/env node
// demo/agent-b-scan.cjs — Agent B scans chain, finds tasks, computes answers, claims payment
//
// Agent B:
//   1. Scans its own UTXOs for incoming covenant outputs (someone locked payment to its pkh)
//   2. Fetches the task OP_RETURN to read the question
//   3. Computes the answer
//   4. Reveals the preimage to claim payment
//
// Usage: node demo/agent-b-scan.cjs
//        node demo/agent-b-scan.cjs --task-txid <txid>  (skip scan, claim specific task)

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { bsv, toByteString, int2ByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Delivery } = require('../dist/contracts/delivery')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, wocGet, getUtxos, getCurrentHeight
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

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw', 'bsv-wallet-local.json')

// ─── Inference engine (simulated) ────────────────────────────────────

function computeAnswer(question) {
  // Simple inference engine — parses the question and computes
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

// ─── OP_RETURN parser ────────────────────────────────────────────────

function parseTaskOpReturn(scriptHex) {
  // Format: 006a 04 "ORD1" 04 "TASK" 01 <type:1B> 01 <qLen:1B> <question>
  try {
    const s = scriptHex.toLowerCase()
    if (!s.startsWith('006a')) return null
    let offset = 4 // skip 006a

    // Push 4 "ORD1"
    const ord1Len = parseInt(s.slice(offset, offset + 2), 16); offset += 2
    const ord1 = Buffer.from(s.slice(offset, offset + ord1Len * 2), 'hex').toString(); offset += ord1Len * 2

    // Push 4 "TASK"
    const taskLen = parseInt(s.slice(offset, offset + 2), 16); offset += 2
    const task = Buffer.from(s.slice(offset, offset + taskLen * 2), 'hex').toString(); offset += taskLen * 2

    if (ord1 !== 'ORD1' || task !== 'TASK') return null

    // type
    const typeLen = parseInt(s.slice(offset, offset + 2), 16); offset += 2
    const type = parseInt(s.slice(offset, offset + typeLen * 2), 16); offset += typeLen * 2

    // question length
    const qLenByte = parseInt(s.slice(offset, offset + 2), 16); offset += 2
    const qLen = parseInt(s.slice(offset, offset + qLenByte * 2), 16); offset += qLenByte * 2

    // question
    const question = Buffer.from(s.slice(offset, offset + qLen * 2), 'hex').toString('utf8')

    return { protocol: 'ORD1', action: 'TASK', type, question }
  } catch (e) {
    return null
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('🅱️  Agent B — Scanning for Inference Tasks')
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)
  const agentBPkh = address.hashBuffer.toString('hex')

  console.log(`   Agent B addr: ${address.toString()}`)
  console.log(`   Agent B pkh:  ${agentBPkh}`)
  console.log()

  let taskTxid = args['task-txid']
  let taskData = null

  if (taskTxid) {
    // ─── Direct claim mode ───────────────────────────────────────
    console.log(`   Mode: Direct claim (task-txid provided)`)
    console.log()
    console.log('   Fetching task transaction...')
    const taskTxHex = await wocGetRaw(`/tx/${taskTxid}/hex`)
    const taskTx = new bsv.Transaction(taskTxHex)

    // Find OP_RETURN with TASK
    for (let i = 0; i < taskTx.outputs.length; i++) {
      const scriptHex = taskTx.outputs[i].script.toHex()
      const parsed = parseTaskOpReturn(scriptHex)
      if (parsed) {
        taskData = parsed
        break
      }
    }

    if (!taskData) {
      console.error('❌ No ORD1 TASK found in transaction')
      process.exit(1)
    }
  } else {
    // ─── Scan mode: check tasks.json for open tasks ────────────────
    console.log('   Mode: Chain scan')
    console.log()
    console.log('   Checking for open inference tasks...')

    // Check tasks.json for open tasks
    const taskFile = path.join(__dirname, '..', 'state', 'tasks.json')
    if (fs.existsSync(taskFile)) {
      const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8'))
      const openTasks = tasks.filter(t => t.status === 'open')
      console.log(`   Found ${openTasks.length} open task(s)`) 

      if (openTasks.length === 0) {
        console.log()
        console.log('   No open inference tasks found.')
        console.log('   Make sure Agent A has posted a task:')
        console.log('   node demo/agent-a-post.cjs --question "What is 2+2?" --answer "4"')
        return
      }

      // Pick the most recent open task
      const latest = openTasks[openTasks.length - 1]
      taskTxid = latest.txid
      taskData = { question: latest.question, type: 0 }
    } else {
      console.log()
      console.log('   No tasks file found. Make sure Agent A has posted a task:')
      console.log('   node demo/agent-a-post.cjs --question "What is 2+2?" --answer "4"')
      return
    }
  }

  // ─── Found a task! ──────────────────────────────────────────────

  console.log()
  console.log('   📋 Task found!')
  console.log(`   TXID:    ${taskTxid}`)
  console.log(`   Question: "${taskData.question}"`)
  console.log()

  // ─── Compute the answer ─────────────────────────────────────────

  console.log('🧠 Agent B computing answer...')
  const answer = computeAnswer(taskData.question)
  const answerHash = crypto.createHash('sha256').update(answer).digest('hex')

  console.log(`   Question:  "${taskData.question}"`)
  console.log(`   Answer:    "${answer}"`)
  console.log(`   Hash:      ${answerHash}`)
  console.log()

  // ─── Fetch the delivery covenant UTXO ──────────────────────────

  console.log('💰 Claiming payment...')
  const taskTxHex = await wocGetRaw(`/tx/${taskTxid}/hex`)
  const taskTx = new bsv.Transaction(taskTxHex)

  // Find the covenant output (largest script with value)
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
  console.log()

  // ─── Claim payment by revealing preimage ────────────────────────

  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const delivery = Delivery.fromTx(taskTx, deliveryOutputIndex)
  await delivery.connect(signer)

  // Verify the hash matches
  console.log(`   Covenant deliveryHash: ${delivery.deliveryHash}`)
  console.log(`   Computed hash:         ${answerHash}`)
  console.log(`   Match: ${delivery.deliveryHash === answerHash ? '✅ YES' : '❌ NO — cannot claim'}`)
  console.log()

  if (delivery.deliveryHash !== answerHash) {
    console.error('❌ Answer hash does not match delivery hash — wrong answer or wrong task')
    process.exit(1)
  }

  // Build claim tx
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

  console.log('   Building claim transaction...')

  const preimageHex = Buffer.from(answer, 'utf8').toString('hex')
  console.log(`   Preimage: "${answer}" (hex: ${preimageHex})`)

  const callResult = await delivery.methods.hashLockDeliver(
    toByteString(preimageHex),
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

  // Agent B signs with their own key
  callResult.tx.sign(privKey)

  const txhex = callResult.tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)

  console.log('   Broadcasting...')
  const claimTxid = await wocBroadcast(txhex)

  // Update state
  const taskFile = path.join(__dirname, '..', 'state', 'tasks.json')
  if (fs.existsSync(taskFile)) {
    let tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8'))
    const t = tasks.find(t => t.txid === taskTxid)
    if (t) {
      t.status = 'claimed'
      t.claim_txid = claimTxid
      t.answer = answer
      fs.writeFileSync(taskFile, JSON.stringify(tasks, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log('   ✅ Payment claimed!')
  console.log(`   TXID:    ${claimTxid}`)
  console.log(`   Payment: ${deliveryValue} sats → Agent B (${address.toString()})`)
  console.log(`   Answer revealed: "${answer}"`)
  console.log(`   https://whatsonchain.com/tx/${claimTxid}`)
  console.log('═══════════════════════════════════════════════')
  console.log()
  console.log('   Trade complete:')
  console.log(`   • Agent A locked ${deliveryValue} sats with sha256("${answer}")`)
  console.log(`   • Agent B discovered task, computed answer, revealed it`)
  console.log(`   • Covenant verified sha256("${answer}") == hash → released payment`)
  console.log(`   • Agent B received ${deliveryValue} sats`)
  console.log()
  console.log(`   Verification:`)
  console.log(`   • Task:  ${taskTxid}`)
  console.log(`   • Claim: ${claimTxid}`)
  console.log(`   • Answer "${answer}" is in the claim tx input script`)
  console.log(`   • Anyone can check: sha256("${answer}") matches delivery hash`)
}

main().catch(err => {
  console.error('❌', err.message)
  console.error(err.stack)
  process.exit(1)
})

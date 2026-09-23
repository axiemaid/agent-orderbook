#!/usr/bin/env node
// src/post-bounty.cjs — Post a bounty on-chain (lock sats to a task)
//
// Usage: node src/post-bounty.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --type COMPUTE --reward 1000 --expiry 1000 --task "What is 2+2?"
//
// Creates:
//   Output [0]: Bounty covenant UTXO (sats locked, anyone can claim)
//   Output [1]: OP_RETURN "ORD1" "BOUNTY" <type> <reward> <expiry> <task>
//   Output [2]: Change

const fs = require('fs')
const path = require('path')
const { bsv } = require('scrypt-ts')
const { Bounty } = require('../dist/contracts/bounty')
const {
  loadWallet, getKeypair, wocBroadcast, getUtxos, getCurrentHeight, wocGetRaw
} = require('../lib/wallet.cjs')
const { buildOpReturnScript, MARKET_TYPES } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '')
  if (key === 'task') {
    // Task can be long — grab everything until next --flag
    const parts = []
    i++
    while (i < process.argv.length && !process.argv[i].startsWith('--')) {
      parts.push(process.argv[i])
      i++
    }
    args[key] = parts.join(' ')
    i-- // compensate for loop increment
  } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
    args[key] = process.argv[i + 1]
    i++
  }
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const TYPE_NAME = (args.type || 'COMPUTE').toUpperCase()
const REWARD = parseInt(args.reward)
const EXPIRY_OFFSET = parseInt(args.expiry || '1000')
const TASK = args.task || ''

if (!REWARD || !TASK) {
  console.log('Usage: node src/post-bounty.cjs --wallet <path> --type COMPUTE --reward 1000 --expiry 1000 --task "What is 2+2?"')
  process.exit(1)
}

const TYPE = MARKET_TYPES[TYPE_NAME] ?? 7 // CUSTOM if unknown

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/bounty.json')
Bounty.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function postBounty() {
  console.log('🎯 ORD1 — Post Bounty')
  console.log(`   Type:     ${TYPE_NAME} (${TYPE})`)
  console.log(`   Reward:   ${REWARD} sats`)
  console.log(`   Task:     ${TASK.slice(0, 80)}${TASK.length > 80 ? '...' : ''}`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  const makerPubHex = pubKey.toString()
  const makerPkh = address.hashBuffer.toString('hex')

  const currentHeight = await getCurrentHeight()
  const expiryHeight = currentHeight + EXPIRY_OFFSET
  console.log(`   Address:  ${address.toString()}`)
  console.log(`   Expiry:   Block ${expiryHeight} (current ${currentHeight} + ${EXPIRY_OFFSET})`)

  // Create bounty covenant instance
  const bounty = new Bounty(
    makerPubHex,
    makerPkh,
    BigInt(expiryHeight),
  )

  const covenantScript = bounty.lockingScript
  console.log(`   Covenant: ${covenantScript.toHex().length / 2} bytes`)

  // Get UTXOs
  const utxos = await getUtxos(address.toString())
  if (!utxos || utxos.length === 0) {
    console.error('❌ No UTXOs available')
    process.exit(1)
  }

  const feeEstimate = 1500 // covenant script is larger
  const totalNeeded = REWARD + feeEstimate
  const utxo = utxos.find(u => u.satoshis >= totalNeeded)
  if (!utxo) {
    console.error(`❌ No UTXO large enough (need ${totalNeeded} sats, largest: ${Math.max(...utxos.map(u => u.satoshis))})`)
    process.exit(1)
  }

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

  // Output 0: Bounty covenant UTXO (sats locked, anyone can claim)
  tx.addOutput(new bsv.Transaction.Output({
    script: covenantScript,
    satoshis: REWARD,
  }))

  // Output 1: OP_RETURN — ORD1 BOUNTY
  // Format: "ORD1" "BOUNTY" <type:1B> <reward:8B LE> <expiry:4B LE> <task:var>
  const taskBuf = Buffer.from(TASK, 'utf8')
  const rewardBuf = Buffer.alloc(8)
  rewardBuf.writeBigUInt64LE(BigInt(REWARD))
  const expiryBuf = Buffer.alloc(4)
  expiryBuf.writeUInt32LE(expiryHeight)

  const bountyParts = [
    Buffer.from('ORD1', 'ascii'),
    Buffer.from('BOUNTY', 'ascii'),
    Buffer.from([TYPE]),
    rewardBuf,
    expiryBuf,
    taskBuf,
  ]
  const opReturnHex = buildOpReturnScript(bountyParts)
  tx.addOutput(new bsv.Transaction.Output({
    script: bsv.Script.fromHex(opReturnHex),
    satoshis: 0,
  }))

  // Output 2: Change
  const change = utxo.satoshis - REWARD - feeEstimate
  if (change > 546) {
    tx.to(address, change)
  }

  // Sign
  tx.sign(privKey)

  const txhex = tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)
  console.log('   Broadcasting...')

  const txid = await wocBroadcast(txhex)

  // Save to state
  const stateDir = path.join(__dirname, '..', 'state')
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true })

  const bountyFile = path.join(stateDir, 'bounties.json')
  let bounties = []
  if (fs.existsSync(bountyFile)) bounties = JSON.parse(fs.readFileSync(bountyFile, 'utf8'))

  bounties.push({
    txid,
    type: TYPE,
    type_name: TYPE_NAME,
    reward: REWARD,
    task: TASK,
    expiry_height: expiryHeight,
    placed_at_height: currentHeight,
    maker_pkh: makerPkh,
    status: 'open',
    covenant: true,
  })

  fs.writeFileSync(bountyFile, JSON.stringify(bounties, null, 2))

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Bounty posted!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Reward:  ${REWARD} sats (locked in covenant)`)
  console.log(`   Expiry:  Block ${expiryHeight}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

postBounty().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

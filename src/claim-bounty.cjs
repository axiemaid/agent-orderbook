#!/usr/bin/env node
// src/claim-bounty.cjs — Claim a bounty by submitting an answer
//
// Usage: node src/claim-bounty.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --bounty-txid <txid> --answer "4"
//
// The agent found a bounty on the indexer, computed the answer,
// and now claims the reward. Payment released to claimer.
//
// Creates:
//   Input [0]:  Bounty covenant UTXO (spend via claim() path)
//   Output [0]: Payment to claimer
//   Output [1]: OP_RETURN "ORD1" "CLAIM" <bounty_txid> <answer>

const fs = require('fs')
const path = require('path')
const { bsv, toByteString, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Bounty } = require('../dist/contracts/bounty')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getUtxos, getCurrentHeight
} = require('../lib/wallet.cjs')
const { buildOpReturnScript } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '')
  if (key === 'answer') {
    // Answer can be long — grab everything until next --flag
    const parts = []
    i++
    while (i < process.argv.length && !process.argv[i].startsWith('--')) {
      parts.push(process.argv[i])
      i++
    }
    args[key] = parts.join(' ')
    i--
  } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
    args[key] = process.argv[i + 1]
    i++
  }
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const BOUNTY_TXID = args['bounty-txid']
const ANSWER = args.answer || ''

if (!BOUNTY_TXID) {
  console.log('Usage: node src/claim-bounty.cjs --wallet <path> --bounty-txid <txid> --answer "4"')
  process.exit(1)
}

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/bounty.json')
Bounty.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function claimBounty() {
  console.log('🎯 ORD1 — Claim Bounty')
  console.log(`   Bounty:  ${BOUNTY_TXID.slice(0, 24)}...`)
  console.log(`   Answer:  ${ANSWER.slice(0, 80)}${ANSWER.length > 80 ? '...' : ''}`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  const claimerPubHex = pubKey.toString()
  const claimerPkh = address.hashBuffer.toString('hex')

  console.log(`   Claimer: ${address.toString()}`)

  // Fetch bounty tx
  const bountyTxHex = await wocGetRaw(`/tx/${BOUNTY_TXID}/hex`)
  const bountyTx = new bsv.Transaction(bountyTxHex)

  // Find the covenant output (largest script)
  let bountyOutputIndex = 0
  let maxScriptLen = 0
  for (let i = 0; i < bountyTx.outputs.length; i++) {
    const scriptLen = bountyTx.outputs[i].script.toHex().length
    if (scriptLen > maxScriptLen && bountyTx.outputs[i].satoshis > 0) {
      maxScriptLen = scriptLen
      bountyOutputIndex = i
    }
  }

  const bountyValue = bountyTx.outputs[bountyOutputIndex].satoshis
  console.log(`   Output:  [${bountyOutputIndex}] (${maxScriptLen / 2} bytes script)`)
  console.log(`   Reward:  ${bountyValue} sats`)
  console.log()

  // Load covenant from tx
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const bounty = Bounty.fromTx(bountyTx, bountyOutputIndex)
  await bounty.connect(signer)

  // Bind the claim tx builder
  // The covenant expects fixed outputs: [0] P2PKH to claimer, [1] OP_RETURN ORD1 CLAIM
  // The answer goes into the input script (method arg), NOT the OP_RETURN.
  // Indexers extract the answer from the input script witness.
  bounty.bindTxBuilder('claim', (current, options, claimerPubArg, sigArg, claimerPkhArg, answerArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Output 0: Payment to claimer (full bounty value)
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: bountyValue,
    }))

    // Output 1: OP_RETURN — ORD1 CLAIM (fixed, matches covenant exactly)
    const opReturnHex = '006a' + '04' + '4f524431' + '05' + '434c41494d'
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

  // Answer is passed as a ByteString arg — it goes into the input script.
  // On-chain, visible to anyone who parses the claim tx input witness.
  const answerHex = Buffer.from(ANSWER, 'utf8').toString('hex')

  const callResult = await bounty.methods.claim(
    claimerPubHex,
    (sigResps) => sigResps[0].sig,
    claimerPkh,
    toByteString(answerHex),  // answer as ByteString (hex → bytes)
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  )

  // Sign with claimer's key
  callResult.tx.sign(privKey)

  const txhex = callResult.tx.uncheckedSerialize()
  console.log(`   TX size:  ${txhex.length / 2} bytes`)
  console.log('   Broadcasting...')

  const txid = await wocBroadcast(txhex)

  // Update state
  const stateDir = path.join(__dirname, '..', 'state')
  const bountyFile = path.join(stateDir, 'bounties.json')
  if (fs.existsSync(bountyFile)) {
    let bounties = JSON.parse(fs.readFileSync(bountyFile, 'utf8'))
    const b = bounties.find(b => b.txid === BOUNTY_TXID)
    if (b) {
      b.status = 'claimed'
      b.claim_txid = txid
      b.claimer_pkh = claimerPkh
      b.answer = ANSWER
      fs.writeFileSync(bountyFile, JSON.stringify(bounties, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Bounty claimed!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Reward:  ${bountyValue} sats to claimer`)
  console.log(`   Answer:  ${ANSWER.slice(0, 100)}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

claimBounty().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

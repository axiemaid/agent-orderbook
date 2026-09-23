#!/usr/bin/env node
// src/timeout-bounty.cjs — Reclaim an expired bounty
//
// Usage: node src/timeout-bounty.cjs --wallet ~/.openclaw/bsv-wallet.json \
//          --bounty-txid <txid>
//
// Nobody solved the bounty before expiry. Maker reclaims their sats.

const fs = require('fs')
const path = require('path')
const { bsv, DefaultProvider, TestWallet } = require('scrypt-ts')
const { Bounty } = require('../dist/contracts/bounty')
const {
  loadWallet, getKeypair, wocBroadcast, wocGetRaw, getCurrentHeight
} = require('../lib/wallet.cjs')
const { buildOpReturnScript } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WALLET_PATH = args.wallet || path.join(process.env.HOME, '.openclaw/bsv-wallet.json')
const BOUNTY_TXID = args['bounty-txid']

if (!BOUNTY_TXID) {
  console.log('Usage: node src/timeout-bounty.cjs --wallet <path> --bounty-txid <txid>')
  process.exit(1)
}

// ─── Load covenant artifact ──────────────────────────────────────────

const artifact = require('../artifacts/contracts/bounty.json')
Bounty.loadArtifact(artifact)

// ─── Main ────────────────────────────────────────────────────────────

async function timeoutBounty() {
  console.log('⏰ ORD1 — Timeout Bounty (Reclaim)')
  console.log(`   Bounty:  ${BOUNTY_TXID.slice(0, 24)}...`)
  console.log()

  const wallet = loadWallet(WALLET_PATH)
  const { privKey, pubKey, address } = getKeypair(wallet)

  // Fetch bounty tx
  const bountyTxHex = await wocGetRaw(`/tx/${BOUNTY_TXID}/hex`)
  const bountyTx = new bsv.Transaction(bountyTxHex)

  // Find the covenant output
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
  console.log(`   Output:  [${bountyOutputIndex}] (${maxScriptLen / 2} bytes)`)
  console.log(`   Value:   ${bountyValue} sats`)

  const currentHeight = await getCurrentHeight()
  console.log(`   Height:  ${currentHeight}`)

  // Load covenant from tx
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet })
  const signer = new TestWallet(privKey, provider)
  await provider.connect()

  const bounty = Bounty.fromTx(bountyTx, bountyOutputIndex)
  await bounty.connect(signer)

  // Check expiry
  const expiry = Number(bounty.expiryHeight)
  if (currentHeight < expiry) {
    console.error(`❌ Bounty not yet expired (expiry: ${expiry}, current: ${currentHeight})`)
    console.error(`   Wait ${expiry - currentHeight} more blocks`)
    process.exit(1)
  }
  console.log(`   Expired: ✅ (${currentHeight - expiry} blocks ago)`)

  // Bind timeout tx builder
  bounty.bindTxBuilder('timeout', (current, options, sigArg) => {
    const unsignedTx = new bsv.Transaction()
    unsignedTx.addInput(current.buildContractInput())

    // Output 0: Refund to maker
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: bountyValue,
    }))

    // Output 1: OP_RETURN — ORD1 TIMEOUT
    const timeoutParts = [
      Buffer.from('ORD1', 'ascii'),
      Buffer.from('TIMEOUT', 'ascii'),
      Buffer.from(BOUNTY_TXID, 'hex'),
    ]
    const opReturnHex = buildOpReturnScript(timeoutParts)
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

  console.log('   Building timeout transaction...')

  const callResult = await bounty.methods.timeout(
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
  const bountyFile = path.join(stateDir, 'bounties.json')
  if (fs.existsSync(bountyFile)) {
    let bounties = JSON.parse(fs.readFileSync(bountyFile, 'utf8'))
    const b = bounties.find(b => b.txid === BOUNTY_TXID)
    if (b) {
      b.status = 'timeout'
      b.timeout_txid = txid
      fs.writeFileSync(bountyFile, JSON.stringify(bounties, null, 2))
    }
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log(`   ✅ Bounty reclaimed!`)
  console.log(`   TXID:    ${txid}`)
  console.log(`   Refund:  ${bountyValue} sats to maker`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
  console.log('═══════════════════════════════════════════════')
}

timeoutBounty().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

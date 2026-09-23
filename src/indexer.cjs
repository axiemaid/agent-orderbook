#!/usr/bin/env node
// src/indexer.cjs — ORD1 chain scanner and orderbook indexer
//
// Scans BSV blocks for ORD1 protocol transactions, maintains orderbook state.
// Usage: node src/indexer.cjs [--start-height <n>] [--scan-back <blocks>] [--watch]

const fs = require('fs')
const path = require('path')
const {
  wocGet, wocGetRaw, getCurrentHeight
} = require('../lib/wallet.cjs')
const { decodeOrd1 } = require('../lib/protocol.cjs')

const STATE_DIR = path.join(__dirname, '..', 'state')
const INDEX_FILE = path.join(STATE_DIR, 'ord1-index.json')
const STATS_FILE = path.join(STATE_DIR, 'agent-stats.json')

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const WATCH = args.watch === 'true' || args.watch === undefined
const START_HEIGHT = parseInt(args['start-height'] || '0')
const SCAN_BACK = parseInt(args['scan-back'] || '100')

// ─── State ───────────────────────────────────────────────────────────

function loadIndex() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
  if (!fs.existsSync(INDEX_FILE)) {
    const initial = {
      open_orders: [],
      filled_orders: [],
      open_bounties: [],
      claimed_bounties: [],
      deliveries: [],
      disputes: [],
      last_scanned_height: 0,
    }
    fs.writeFileSync(INDEX_FILE, JSON.stringify(initial, null, 2))
    return initial
  }
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
}

function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
}

function loadStats() {
  if (!fs.existsSync(STATS_FILE)) {
    const initial = { agents: {} }
    fs.writeFileSync(STATS_FILE, JSON.stringify(initial, null, 2))
    return initial
  }
  return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2))
}

// ─── Agent Stats ─────────────────────────────────────────────────────

function updateAgentStats(stats, agentId, event) {
  if (!stats.agents[agentId]) {
    stats.agents[agentId] = {
      placed: 0, filled: 0, delivered: 0, breached: 0, slashed: 0,
      fill_ratio: 0,
    }
  }
  const s = stats.agents[agentId]
  switch (event) {
    case 'place': s.placed++; break
    case 'fill': s.filled++; break
    case 'deliver': s.delivered++; break
    case 'breach': s.breached++; break
    case 'slash': s.slashed++; break
  }
  s.fill_ratio = s.placed > 0 ? s.filled / s.placed : 0
}

// ─── Block Scanner ────────────────────────────────────────────────────

async function scanMempool(index, stats) {
  // WoC doesn't expose a full mempool tx list.
  // Instead, check unconfirmed txids from our local state.
  const orderFile = path.join(__dirname, '..', 'state', 'orders.json')
  const bountyFile = path.join(__dirname, '..', 'state', 'bounties.json')
  let knownTxids = []
  if (fs.existsSync(orderFile)) {
    const orders = JSON.parse(fs.readFileSync(orderFile, 'utf8'))
    knownTxids = orders.map(o => o.txid).filter(Boolean)
    for (const order of orders) {
      if (order.fills) {
        knownTxids.push(...order.fills.map(f => f.txid).filter(Boolean))
      }
    }
  }
  // Also track bounty txids + claim txids
  if (fs.existsSync(bountyFile)) {
    const bounties = JSON.parse(fs.readFileSync(bountyFile, 'utf8'))
    knownTxids.push(...bounties.map(b => b.txid).filter(Boolean))
    knownTxids.push(...bounties.map(b => b.claim_txid).filter(Boolean))
    knownTxids.push(...bounties.map(b => b.timeout_txid).filter(Boolean))
  }

  let found = 0
  for (const txid of knownTxids) {
    // Check if this tx is in mempool (no block height)
    const txInfo = await wocGet(`/tx/${txid}`).catch(() => null)
    console.log(`   ${txid.slice(0,16)}... blockHeight:`, txInfo ? txInfo.blockHeight : 'null txInfo')
    if (!txInfo || txInfo.blockHeight !== undefined) continue

    // Parse tx outputs
    const txHex = await wocGetRaw(`/tx/${txid}/hex`).catch(() => null)
    if (!txHex) continue

    try {
      const { bsv } = require('scrypt-ts')
      const tx = new bsv.Transaction(txHex)
      for (let oi = 0; oi < tx.outputs.length; oi++) {
        const output = tx.outputs[oi]
        const scriptHex = output.script.toHex()
        const parsed = decodeOrd1(scriptHex)
        if (!parsed) continue
        found++
        processOrd1Tx(parsed, txid, output, index, stats, -1, tx)
      }
    } catch (e) {
      // skip unparseable txs
    }
  }
  return found
}

async function scanBlock(height, index, stats) {
  const blockTxs = await wocGet(`/block/height/${height}`).catch(() => null)
  if (!blockTxs || !blockTxs.txCount) return 0

  const txids = blockTxs.txids || []
  let found = 0

  for (const txid of txids) {
    const txHex = await wocGetRaw(`/tx/${txid}/hex`).catch(() => null)
    if (!txHex) continue

    try {
      const { bsv } = require('scrypt-ts')
      const tx = new bsv.Transaction(txHex)

      for (let oi = 0; oi < tx.outputs.length; oi++) {
        const output = tx.outputs[oi]
        const scriptHex = output.script.toHex()
        const parsed = decodeOrd1(scriptHex)
        if (!parsed) continue

        found++
        processOrd1Tx(parsed, txid, output, index, stats, height, tx)
      }
    } catch (e) {
      // skip unparseable txs
    }
  }

  return found
}

function processOrd1Tx(parsed, txid, output, index, stats, height, txObj) {
  switch (parsed.action) {
    case 'PLACE': {
      // Check if we already have this order
      const exists = index.open_orders.find(o => o.txid === txid)
      if (exists) break

      index.open_orders.push({
        txid,
        type: parsed.type,
        side: parsed.side,
        price: parsed.price,
        quantity: parsed.quantity,
        remaining_quantity: parsed.quantity,
        agent_id: parsed.agentId,
        expiry_height: parsed.expiryHeight,
        bond_ref: parsed.bondRef,
        nonce: parsed.nonce,
        placed_at_height: height,
        status: 'open',
        fills: [],
      })

      updateAgentStats(stats, parsed.agentId, 'place')
      console.log(`  📋 PLACE: ${parsed.side === 1 ? 'ASK' : 'BID'} ${parsed.quantity} units @ ${parsed.price} sats (${txid.slice(0, 16)}...)`)
      break
    }

    case 'FILL': {
      // Find the order being filled
      const order = index.open_orders.find(o => o.txid === parsed.orderTxid)
      if (order) {
        order.remaining_quantity -= parsed.fillQuantity
        order.fills = order.fills || []
        order.fills.push({
          txid,
          fill_price: parsed.fillPrice,
          fill_quantity: parsed.fillQuantity,
          delivery_hash: parsed.deliveryHash,
          taker_id: parsed.takerId,
          height,
        })

        if (order.remaining_quantity <= 0) {
          order.status = 'filled'
          index.filled_orders.push({ ...order })
          index.open_orders = index.open_orders.filter(o => o.txid !== parsed.orderTxid)
        }

        updateAgentStats(stats, parsed.takerId, 'fill')
        console.log(`  🛒 FILL: ${parsed.fillQuantity} units @ ${parsed.fillPrice} sats of ${parsed.orderTxid.slice(0, 16)}...`)
      }
      break
    }

    case 'CANCEL': {
      const order = index.open_orders.find(o => o.txid === parsed.orderTxid)
      if (order) {
        order.status = 'cancelled'
        index.open_orders = index.open_orders.filter(o => o.txid !== parsed.orderTxid)
        console.log(`  ❌ CANCEL: ${parsed.orderTxid.slice(0, 16)}...`)
      }
      break
    }

    case 'DELIVER': {
      index.deliveries.push({
        txid,
        fill_txid: parsed.fillTxid,
        delivery_data: parsed.deliveryData,
        proof_type: parsed.proofType,
        height,
      })
      updateAgentStats(stats, 'unknown', 'deliver') // would resolve from fill tx
      console.log(`  📦 DELIVER: proof type ${parsed.proofType} for ${parsed.fillTxid.slice(0, 16)}...`)
      break
    }

    case 'DISPUTE': {
      index.disputes.push({
        txid,
        fill_txid: parsed.fillTxid,
        breach_type: parsed.breachType,
        evidence: parsed.evidence,
        height,
      })
      updateAgentStats(stats, 'unknown', 'breach')
      console.log(`  ⚠️ DISPUTE: breach type ${parsed.breachType} on ${parsed.fillTxid.slice(0, 16)}...`)
      break
    }

    case 'BOUNTY': {
      // Check if already indexed
      const bountyExists = index.open_bounties?.find(b => b.txid === txid)
      if (bountyExists) break

      if (!index.open_bounties) index.open_bounties = []
      if (!index.claimed_bounties) index.claimed_bounties = []

      index.open_bounties.push({
        txid,
        type: parsed.type,
        reward: parsed.reward,
        task: parsed.task,
        expiry_height: parsed.expiryHeight,
        placed_at_height: height,
        status: 'open',
      })

      console.log(`  🎯 BOUNTY: ${parsed.reward} sats — ${parsed.task?.slice(0, 60)}... (${txid.slice(0, 16)}...)`)
      break
    }

    case 'CLAIM': {
      // The bounty txid is in the input (prev txid of input[0])
      // The answer is in the input script witness
      let bountyTxid = parsed.bountyTxid
      let answer = parsed.answer

      // Extract from input if available
      if (txObj && txObj.inputs && txObj.inputs.length > 0) {
        const input = txObj.inputs[0]
        bountyTxid = input.prevTxId.toString('hex') || bountyTxid
        // Extract answer from input script witness
        // sCrypt pushes method args in the input script. For claim(claimerPub, claimerSig, claimerPkh, answer)
        // the chunks are: [0] pubKey(33B) [1] sig(~70B) [2] pkh(20B) [3] answer [4] covenant script
        // The answer is the chunk that's not a sig/pubkey/pkh/covenant — try chunks 0-3
        try {
          const chunks = input.script.chunks || []
          for (let ci = 0; ci < chunks.length; ci++) {
            const c = chunks[ci]
            if (!c.buf || c.buf.length === 0) continue
            // Skip known sizes: pubKey(33), sig(~70-72), pkh(20), covenant(>100)
            const len = c.buf.length
            if (len === 33 || len === 20 || len > 100) continue
            // Check if it looks like a signature (starts with 0x30)
            if (c.buf[0] === 0x30 && len > 60) continue
            // This should be the answer
            answer = c.buf.toString('utf8')
            break
          }
        } catch (e) {}
      }

      const bounty = index.open_bounties?.find(b => b.txid === bountyTxid)
      if (bounty) {
        bounty.status = 'claimed'
        bounty.claim_txid = txid
        bounty.answer = answer
        bounty.claimed_at_height = height
        index.claimed_bounties = index.claimed_bounties || []
        index.claimed_bounties.push({ ...bounty })
        index.open_bounties = index.open_bounties.filter(b => b.txid !== bountyTxid)
      }
      console.log(`  ✅ CLAIM: ${answer?.slice(0, 60)}... for ${bountyTxid?.slice(0, 16)}...`)
      break
    }

    case 'REFUND':
      console.log(`  💰 REFUND: ${txid.slice(0, 16)}...`)
      break

    case 'TIMEOUT': {
      // Check bounties first, then orders
      const bounty = index.open_bounties?.find(b => b.txid === txid)
      if (bounty) {
        bounty.status = 'timeout'
        index.open_bounties = index.open_bounties.filter(b => b.txid !== txid)
      } else {
        const order = index.open_orders.find(o => o.txid === txid)
        if (order) {
          order.status = 'timeout'
          index.open_orders = index.open_orders.filter(o => o.txid !== txid)
        }
      }
      console.log(`  ⏰ TIMEOUT: ${txid.slice(0, 16)}...`)
      break
    }
  }
}

// ─── Query API ───────────────────────────────────────────────────────

function getOpenOrders(index, { type, side, maxPrice, minQuantity, sortBy, limit } = {}) {
  let orders = index.open_orders.filter(o => o.status === 'open')

  if (type !== undefined) orders = orders.filter(o => o.type === type)
  if (side !== undefined) orders = orders.filter(o => o.side === side)
  if (maxPrice) orders = orders.filter(o => o.price <= maxPrice)
  if (minQuantity) orders = orders.filter(o => o.remaining_quantity >= minQuantity)

  switch (sortBy) {
    case 'price_asc': orders.sort((a, b) => a.price - b.price); break
    case 'price_desc': orders.sort((a, b) => b.price - a.price); break
    case 'newest': orders.sort((a, b) => b.placed_at_height - a.placed_at_height); break
    case 'oldest': orders.sort((a, b) => a.placed_at_height - b.placed_at_height); break
  }

  if (limit) orders = orders.slice(0, limit)

  return orders
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('📊 ORD1 Indexer')
  console.log()

  const index = loadIndex()
  const stats = loadStats()

  const currentHeight = await getCurrentHeight()
  const startHeight = START_HEIGHT || Math.max(1, index.last_scanned_height + 1, currentHeight - SCAN_BACK)

  console.log(`   Current height: ${currentHeight}`)
  console.log(`   Scanning from:  ${startHeight}`)
  console.log(`   Last scanned:   ${index.last_scanned_height}`)
  console.log()

  // Scan mempool first (zero-conf txs)
  console.log('   Scanning mempool...')
  const mempoolFound = await scanMempool(index, stats)
  console.log(`   Mempool: ${mempoolFound} ORD1 tx(s) found`)
  console.log()

  let totalFound = mempoolFound

  for (let h = startHeight; h <= currentHeight; h++) {
    process.stdout.write(`   Block ${h}... `)
    const found = await scanBlock(h, index, stats)
    totalFound += found

    if (found > 0) {
      console.log(`${found} ORD1 tx(s)`)
    } else {
      console.log('—')
    }

    index.last_scanned_height = h

    // Save periodically
    if (h % 10 === 0 || h === currentHeight) {
      saveIndex(index)
      saveStats(stats)
    }
  }

  console.log()
  console.log(`═══════════════════════════════════════════════`)
  console.log(`   Scan complete: ${currentHeight - startHeight + 1} blocks`)
  console.log(`   ORD1 txs found: ${totalFound}`)
  console.log(`   Open orders:    ${index.open_orders.length}`)
  console.log(`   Filled orders:  ${index.filled_orders.length}`)
  console.log(`   Open bounties: ${(index.open_bounties || []).length}`)
  console.log(`   Claimed:        ${(index.claimed_bounties || []).length}`)
  console.log(`   Deliveries:     ${index.deliveries.length}`)
  console.log(`   Disputes:       ${index.disputes.length}`)
  console.log()

  // Show open orders summary
  if (index.open_orders.length > 0) {
    console.log('   Open Orders:')
    for (const o of index.open_orders) {
      const sideName = o.side === 1 ? 'ASK' : 'BID'
      console.log(`     ${sideName} ${o.remaining_quantity}/${o.quantity} @ ${o.price} sats (${o.txid.slice(0, 16)}...)`)
    }
  }

  // Show open bounties summary
  if ((index.open_bounties || []).length > 0) {
    console.log()
    console.log('   Open Bounties:')
    for (const b of index.open_bounties) {
      console.log(`     ${b.reward} sats — ${b.task?.slice(0, 60)}... (${b.txid.slice(0, 16)}...)`)
    }
  }

  console.log(`═══════════════════════════════════════════════`)
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

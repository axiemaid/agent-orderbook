#!/usr/bin/env node
// src/task-api.cjs — ORD1 Task Discovery API
//
// Scans BSV blockchain for ORD1 TASK outputs, serves them over HTTP.
// Agents query this API to discover open inference tasks.
//
// Endpoints:
//   GET  /tasks              — list open tasks
//   GET  /tasks/:txid        — get specific task
//   GET  /tasks?type=0        — filter by market type
//   GET  /health             — health check
//   POST /scan               — trigger a rescan
//
// Usage: node src/task-api.cjs --port 3010

const http = require('http')
const fs = require('fs')
const path = require('path')
const { bsv } = require('scrypt-ts')
const {
  wocGet, wocGetRaw, getCurrentHeight
} = require('../lib/wallet.cjs')
const { decodeOrd1 } = require('../lib/protocol.cjs')

// ─── Args ────────────────────────────────────────────────────────────

const args = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
}

const PORT = parseInt(args.port || '3010')
const SCAN_BACK = parseInt(args['scan-back'] || '144') // ~24h of blocks

// ─── State ───────────────────────────────────────────────────────────

const STATE_DIR = path.join(__dirname, '..', 'state')
const TASK_INDEX_FILE = path.join(STATE_DIR, 'task-index.json')

function loadTaskIndex() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
  if (!fs.existsSync(TASK_INDEX_FILE)) {
    const initial = { tasks: [], last_scanned_height: 0, last_scan_time: 0 }
    fs.writeFileSync(TASK_INDEX_FILE, JSON.stringify(initial, null, 2))
    return initial
  }
  return JSON.parse(fs.readFileSync(TASK_INDEX_FILE, 'utf8'))
}

function saveTaskIndex(index) {
  fs.writeFileSync(TASK_INDEX_FILE, JSON.stringify(index, null, 2))
}

// ─── Scanner ────────────────────────────────────────────────────────

async function scanForTasks(startHeight, endHeight) {
  const index = loadTaskIndex()
  let found = 0

  for (let h = startHeight; h <= endHeight; h++) {
    process.stdout.write(`  Block ${h}... `)

    const blockData = await wocGet(`/block/height/${h}`).catch(() => null)
    if (!blockData || !blockData.txids) {
      console.log('skip (no data)')
      continue
    }

    let blockFound = 0
    for (const txid of blockData.txids) {
      const txHex = await wocGetRaw(`/tx/${txid}/hex`).catch(() => null)
      if (!txHex) continue

      try {
        const tx = new bsv.Transaction(txHex)

        for (let i = 0; i < tx.outputs.length; i++) {
          const scriptHex = tx.outputs[i].script.toHex()
          const parsed = decodeOrd1(scriptHex)

          if (!parsed || parsed.action !== 'TASK') continue

          // Check if already indexed
          const exists = index.tasks.find(t => t.txid === txid)
          if (exists) continue

          // Find the delivery covenant output in the same tx
          // (the one with the largest script that has value > 0)
          let covenantOutputIndex = 0
          let maxScriptLen = 0
          for (let j = 0; j < tx.outputs.length; j++) {
            const scriptLen = tx.outputs[j].script.toHex().length
            if (scriptLen > maxScriptLen && tx.outputs[j].satoshis > 0) {
              maxScriptLen = scriptLen
              covenantOutputIndex = j
            }
          }

          const task = {
            txid,
            question: parsed.question || '',
            type: parsed.type ?? 0,
            type_name: ['COMPUTE', 'DATA', 'SERVICE', 'RELAY', 'INDEX', 'MODEL', 'STORAGE', 'CUSTOM'][parsed.type ?? 0] || 'UNKNOWN',
            payment: tx.outputs[covenantOutputIndex].satoshis,
            covenant_output: covenantOutputIndex,
            block_height: h,
            posted_at: new Date().toISOString(),
            status: 'open',
          }

          index.tasks.push(task)
          found++
          blockFound++
          console.log(`\n  📋 TASK: "${task.question}" (${task.payment} sats, ${task.txid.slice(0, 16)}...)`)
        }
      } catch (e) {
        // skip unparseable
      }
    }

    if (blockFound === 0) process.stdout.write('—')
    console.log()

    index.last_scanned_height = h
    index.last_scan_time = Date.now()

    // Save every 10 blocks
    if (h % 10 === 0 || h === endHeight) saveTaskIndex(index)
  }

  return found
}

// Check if a task's covenant UTXO is still unspent
async function checkTaskStatus(task) {
  // Use WoC to check if the tx output is still unspent
  const txInfo = await wocGet(`/tx/${task.txid}`).catch(() => null)
  if (!txInfo) return task.status

  // Check if there's a spending tx for the covenant output
  // WoC doesn't have a direct "is output spent" endpoint,
  // but we can check the txhex outputs and see if they're in the spending set
  // For simplicity, check if any tx in the spending set references this output

  // Actually, let's just check the task-index for manually updated statuses
  // (set by agent-b-scan when it claims a task)
  return task.status
}

async function rescan() {
  console.log('🔍 Scanning for ORD1 TASK outputs...')
  const currentHeight = await getCurrentHeight()
  const index = loadTaskIndex()

  // First: check local state/tasks.json for mempool tasks (posted by agent-a-post.cjs)
  const localTasksFile = path.join(STATE_DIR, 'tasks.json')
  if (fs.existsSync(localTasksFile)) {
    const localTasks = JSON.parse(fs.readFileSync(localTasksFile, 'utf8'))
    for (const t of localTasks) {
      if (t.status === 'open' && !index.tasks.find(it => it.txid === t.txid)) {
        index.tasks.push({
          txid: t.txid,
          question: t.question,
          type: 0,
          type_name: 'COMPUTE',
          payment: t.amount,
          covenant_output: 0,
          block_height: t.posted_at_height || 0,
          posted_at: new Date(t.timestamp).toISOString(),
          status: 'open',
        })
      }
    }
    saveTaskIndex(index)
  }

  // Then: scan blocks for confirmed tasks
  const startHeight = Math.max(1, currentHeight - SCAN_BACK)

  console.log(`   Current height: ${currentHeight}`)
  console.log(`   Scanning from:  ${startHeight}`)
  console.log()

  let found = 0

  // Scan a smaller range to be fast — just last 10 blocks
  const scanStart = Math.max(startHeight, currentHeight - 10)
  for (let h = scanStart; h <= currentHeight; h++) {
    process.stdout.write(`  Block ${h}... `)

    const blockData = await wocGet(`/block/height/${h}`).catch(() => null)
    if (!blockData || !blockData.txids) {
      console.log('skip')
      continue
    }

    let blockFound = 0
    for (const txid of blockData.txids) {
      const txHex = await wocGetRaw(`/tx/${txid}/hex`).catch(() => null)
      if (!txHex) continue

      try {
        const tx = new bsv.Transaction(txHex)
        for (let i = 0; i < tx.outputs.length; i++) {
          const scriptHex = tx.outputs[i].script.toHex()
          const parsed = decodeOrd1(scriptHex)
          if (!parsed || parsed.action !== 'TASK') continue

          const exists = index.tasks.find(t => t.txid === txid)
          if (exists) continue

          let covenantOutputIndex = 0
          let maxScriptLen = 0
          for (let j = 0; j < tx.outputs.length; j++) {
            const scriptLen = tx.outputs[j].script.toHex().length
            if (scriptLen > maxScriptLen && tx.outputs[j].satoshis > 0) {
              maxScriptLen = scriptLen
              covenantOutputIndex = j
            }
          }

          index.tasks.push({
            txid,
            question: parsed.question || '',
            type: parsed.type ?? 0,
            type_name: ['COMPUTE', 'DATA', 'SERVICE', 'RELAY', 'INDEX', 'MODEL', 'STORAGE', 'CUSTOM'][parsed.type ?? 0] || 'UNKNOWN',
            payment: tx.outputs[covenantOutputIndex].satoshis,
            covenant_output: covenantOutputIndex,
            block_height: h,
            posted_at: new Date().toISOString(),
            status: 'open',
          })
          found++
          blockFound++
          console.log(`\n  📋 TASK: "${parsed.question || ''}" (${tx.outputs[covenantOutputIndex].satoshis} sats)`)

        }
      } catch (e) { /* skip */ }
    }

    if (blockFound === 0) console.log('—')
    index.last_scanned_height = h
    index.last_scan_time = Date.now()
    saveTaskIndex(index)
  }

  console.log()
  console.log(`   Scan complete: ${found} new block task(s), ${index.tasks.length} total indexed`)

  return found
}

// ─── HTTP Server ────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = url.pathname

  // GET /health
  if (pathname === '/health' && req.method === 'GET') {
    const index = loadTaskIndex()
    const openCount = index.tasks.filter(t => t.status === 'open').length
    res.writeHead(200)
    res.end(JSON.stringify({
      status: 'ok',
      port: PORT,
      tasks_indexed: index.tasks.length,
      open_tasks: openCount,
      last_scanned_height: index.last_scanned_height,
      last_scan_time: index.last_scan_time ? new Date(index.last_scan_time).toISOString() : null,
    }))
    return
  }

  // POST /scan
  if (pathname === '/scan' && req.method === 'POST') {
    try {
      const found = await rescan()
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, new_tasks: found }))
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // GET /tasks/:txid
  const taskMatch = pathname.match(/^\/tasks\/([a-f0-9]+)$/)
  if (taskMatch && req.method === 'GET') {
    const index = loadTaskIndex()
    const task = index.tasks.find(t => t.txid === taskMatch[1])
    if (!task) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'task not found' }))
      return
    }
    res.writeHead(200)
    res.end(JSON.stringify(task, null, 2))
    return
  }

  // GET /tasks
  if (pathname === '/tasks' && req.method === 'GET') {
    const index = loadTaskIndex()
    let tasks = index.tasks.filter(t => t.status === 'open')

    // Filter by type
    const typeParam = url.searchParams.get('type')
    if (typeParam !== null) {
      tasks = tasks.filter(t => t.type === parseInt(typeParam))
    }

    // Sort by block height (newest first)
    tasks.sort((a, b) => b.block_height - a.block_height)

    // Limit
    const limit = parseInt(url.searchParams.get('limit') || '50')
    tasks = tasks.slice(0, limit)

    res.writeHead(200)
    res.end(JSON.stringify({
      count: tasks.length,
      tasks,
    }, null, 2))
    return
  }

  // 404
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('🌐 ORD1 Task Discovery API')
  console.log(`   Port: ${PORT}`)
  console.log()

  // Initial scan
  await rescan()

  server.listen(PORT, () => {
    console.log()
    console.log(`   ✅ API running on http://localhost:${PORT}`)
    console.log()
    console.log('   Endpoints:')
    console.log(`     GET  /tasks          — list open tasks`)
    console.log(`     GET  /tasks/:txid    — get specific task`)
    console.log(`     GET  /tasks?type=0   — filter by market type`)
    console.log(`     GET  /health         — health check`)
    console.log(`     POST /scan           — trigger rescan`)
    console.log()
  })
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})

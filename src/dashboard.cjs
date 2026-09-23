#!/usr/bin/env node
// src/dashboard.cjs — ORD1 Bounty Dashboard
// Live view of bounties, claims, and orderbook state
// Usage: node src/dashboard.cjs [--port 3015]

const fs = require('fs')
const path = require('path')
const http = require('http')

const PORT = parseInt(process.argv.find(a => a.startsWith('--port'))?.split('=')[1] || '3015')

const STATE_DIR = path.join(__dirname, '..', 'state')
const INDEX_FILE = path.join(STATE_DIR, 'ord1-index.json')
const BOUNTY_FILE = path.join(STATE_DIR, 'bounties.json')

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return null
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))
}

function loadBounties() {
  if (!fs.existsSync(BOUNTY_FILE)) return []
  return JSON.parse(fs.readFileSync(BOUNTY_FILE, 'utf8'))
}

function timeAgo(height, currentHeight) {
  if (!height || height < 0) return 'mempool'
  const diff = currentHeight - height
  if (diff === 0) return 'just now'
  const mins = diff * 10
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function shorten(txid) {
  if (!txid) return '—'
  return txid.slice(0, 12) + '...'
}

function wocLink(txid) {
  if (!txid) return '#'
  return `https://whatsonchain.com/tx/${txid}`
}

function getStats(index) {
  const open = (index.open_bounties || []).length
  const claimed = (index.claimed_bounties || []).length
  const totalReward = (index.open_bounties || []).reduce((s, b) => s + (b.reward || 0), 0)
  const claimedReward = (index.claimed_bounties || []).reduce((s, b) => s + (b.reward || 0), 0)
  return { open, claimed, totalReward, claimedReward }
}

function renderHTML(data) {
  const { index, bounties, currentHeight } = data
  const stats = getStats(index || { open_bounties: [], claimed_bounties: [] })

  const openBounties = (index?.open_bounties || []).sort((a, b) => (b.placed_at_height || 0) - (a.placed_at_height || 0))
  const claimedBounties = (index?.claimed_bounties || []).sort((a, b) => (b.claimed_at_height || 0) - (a.claimed_at_height || 0))

  const openRows = openBounties.map(b => {
    const expiryLeft = b.expiry_height ? b.expiry_height - currentHeight : '?'
    const expired = expiryLeft < 0
    return `
    <div class="card ${expired ? 'expired' : 'open'}">
      <div class="card-header">
        <span class="reward">${b.reward || '?'} sats</span>
        <span class="type">${b.type_name || ['COMPUTE','DATA','SERVICE','RELAY','INDEX','MODEL','STORAGE','CUSTOM'][b.type] || 'UNKNOWN'}</span>
        <span class="status ${expired ? 'status-expired' : 'status-open'}">${expired ? 'EXPIRED' : 'OPEN'}</span>
      </div>
      <div class="task">${escapeHtml(b.task || '—')}</div>
      <div class="card-footer">
        <a href="${wocLink(b.txid)}" target="_blank" class="txid">${shorten(b.txid)}</a>
        <span class="time">${timeAgo(b.placed_at_height, currentHeight)}</span>
        ${expired ? '<span class="expiry expired">expired</span>' : `<span class="expiry">~${Math.max(0, expiryLeft)} blocks left</span>`}
      </div>
    </div>`
  }).join('')

  const claimedRows = claimedBounties.map(b => `
    <div class="card claimed">
      <div class="card-header">
        <span class="reward">${b.reward || '?'} sats</span>
        <span class="type">${b.type_name || ['COMPUTE','DATA','SERVICE','RELAY','INDEX','MODEL','STORAGE','CUSTOM'][b.type] || 'UNKNOWN'}</span>
        <span class="status status-claimed">CLAIMED</span>
      </div>
      <div class="task">${escapeHtml(b.task || '—')}</div>
      <div class="answer">→ ${escapeHtml(b.answer || '—')}</div>
      <div class="card-footer">
        <a href="${wocLink(b.txid)}" target="_blank" class="txid">bounty: ${shorten(b.txid)}</a>
        <a href="${wocLink(b.claim_txid)}" target="_blank" class="txid">claim: ${shorten(b.claim_txid)}</a>
        <span class="time">${timeAgo(b.claimed_at_height, currentHeight)}</span>
      </div>
    </div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ORD1 Bounty Board</title>
<style>
  :root {
    --bg: #0a0a0f;
    --card: #14141e;
    --border: #2a2a3e;
    --text: #e4e4ef;
    --dim: #6b6b85;
    --accent: #f0b90b;
    --green: #0ecb81;
    --red: #f6465d;
    --blue: #4a9eff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    min-height: 100vh;
  }
  .header {
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .header h1 {
    font-size: 20px;
    font-weight: 700;
  }
  .header .sub {
    color: var(--dim);
    font-size: 13px;
  }
  .stats {
    margin-left: auto;
    display: flex;
    gap: 24px;
  }
  .stat {
    text-align: right;
  }
  .stat-value {
    font-size: 18px;
    font-weight: 700;
    color: var(--accent);
  }
  .stat-label {
    font-size: 11px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px;
  }
  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 32px 0 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-title .count {
    background: var(--border);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
    color: var(--text);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    transition: border-color 0.2s;
  }
  .card:hover {
    border-color: var(--dim);
  }
  .card.open {
    border-left: 3px solid var(--green);
  }
  .card.expired {
    border-left: 3px solid var(--red);
    opacity: 0.6;
  }
  .card.claimed {
    border-left: 3px solid var(--blue);
  }
  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .reward {
    font-size: 16px;
    font-weight: 700;
    color: var(--accent);
  }
  .type {
    font-size: 11px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: var(--border);
    padding: 2px 8px;
    border-radius: 4px;
  }
  .status {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .status-open { background: rgba(14,203,129,0.15); color: var(--green); }
  .status-claimed { background: rgba(74,158,255,0.15); color: var(--blue); }
  .status-expired { background: rgba(246,70,93,0.15); color: var(--red); }
  .task {
    font-size: 14px;
    color: var(--text);
    margin-bottom: 10px;
    word-break: break-word;
  }
  .answer {
    font-size: 13px;
    color: var(--green);
    margin-bottom: 10px;
    font-style: italic;
    word-break: break-word;
  }
  .card-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--dim);
  }
  .txid {
    color: var(--dim);
    text-decoration: none;
    font-family: 'SF Mono', monospace;
  }
  .txid:hover {
    color: var(--blue);
  }
  .time {
    margin-left: auto;
  }
  .expiry {
    color: var(--dim);
  }
  .expiry.expired {
    color: var(--red);
  }
  .empty {
    text-align: center;
    color: var(--dim);
    padding: 48px;
    font-size: 14px;
  }
  .refresh-info {
    text-align: center;
    color: var(--dim);
    font-size: 12px;
    margin-top: 32px;
  }
</style>
</head>
<body>
<div class="header">
  <h1>🎯 ORD1 Bounty Board</h1>
  <span class="sub">BSV Agent Task Market</span>
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${stats.open}</div>
      <div class="stat-label">Open</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.claimed}</div>
      <div class="stat-label">Claimed</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.totalReward.toLocaleString()}</div>
      <div class="stat-label">Sats Locked</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.claimedReward.toLocaleString()}</div>
      <div class="stat-label">Sats Paid</div>
    </div>
  </div>
</div>

<div class="container">
  <div class="section-title">
    Open Bounties
    <span class="count">${openBounties.length}</span>
  </div>
  ${openBounties.length > 0 ? `<div class="grid">${openRows}</div>` : '<div class="empty">No open bounties. Be the first to post one.</div>'}

  <div class="section-title">
    Claimed
    <span class="count">${claimedBounties.length}</span>
  </div>
  ${claimedBounties.length > 0 ? `<div class="grid">${claimedRows}</div>` : '<div class="empty">No claims yet.</div>'}

  <div class="refresh-info">
    Auto-refresh every 30s · Block ${currentHeight} · <a href="https://github.com/axiemaid/agent-orderbook" target="_blank" style="color:var(--dim)">GitHub</a>
  </div>
</div>

<script>
  setTimeout(() => location.reload(), 30000)
</script>
</body>
</html>`
}

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function getCurrentHeight() {
  const https = require('https')
  return new Promise((resolve) => {
    https.get('https://api.whatsonchain.com/v1/bsv/main/chain/info', res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try { resolve(JSON.parse(d).blocks) } catch { resolve(0) }
      })
    }).on('error', () => resolve(0))
  })
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/bounties') {
    const index = loadIndex()
    const bounties = loadBounties()
    const currentHeight = await getCurrentHeight()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      open: index?.open_bounties || [],
      claimed: index?.claimed_bounties || [],
      bounties,
      currentHeight
    }))
    return
  }

  const index = loadIndex()
  const bounties = loadBounties()
  const currentHeight = await getCurrentHeight()

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(renderHTML({ index, bounties, currentHeight }))
})

server.listen(PORT, () => {
  console.log(`🎯 ORD1 Bounty Dashboard running on http://localhost:${PORT}`)
  console.log(`   API: http://localhost:${PORT}/api/bounties`)
  console.log(`   Auto-refresh: 30s`)
})

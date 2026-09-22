#!/usr/bin/env node
// lib/wallet.cjs — Wallet + WoC API helpers for ORD1

const fs = require('fs')
const path = require('path')
const https = require('https')

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'

// ─── Wallet ──────────────────────────────────────────────────────────

function loadWallet(walletPath) {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet not found: ${walletPath}`)
  }
  const w = JSON.parse(fs.readFileSync(walletPath, 'utf8'))
  return w
}

function getKeypair(wallet) {
  // bsv comes from scrypt-ts, not a separate package
  const { bsv } = require('scrypt-ts')
  // Wallet format: { wif: '...', address: '...', ... } or { privKey: 'hex...', ... }
  let privKey
  if (wallet.wif) {
    privKey = bsv.PrivateKey.fromWIF(wallet.wif)
  } else {
    privKey = bsv.PrivateKey.fromString(wallet.privKey || wallet.privateKey)
  }
  const pubKey = privKey.publicKey
  const address = privKey.toAddress(bsv.Networks.mainnet)
  return { privKey, pubKey, address, pubKeyHex: pubKey.toString(), bsv }
}

// ─── WoC API ─────────────────────────────────────────────────────────

function wocGet(endpoint) {
  return new Promise((resolve, reject) => {
    https.get(`${WOC_BASE}${endpoint}`, {
      headers: { Accept: 'application/json' }
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null)
        try { resolve(JSON.parse(d)) }
        catch { reject(new Error(`Bad JSON: ${d.slice(0, 200)}`)) }
      })
    }).on('error', reject)
  })
}

function wocGetRaw(endpoint) {
  return new Promise((resolve, reject) => {
    https.get(`${WOC_BASE}${endpoint}`, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve(d.trim()))
    }).on('error', reject)
  })
}

function wocBroadcast(txhex) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ txhex })
    const req = https.request({
      hostname: 'api.whatsonchain.com',
      path: '/v1/bsv/main/tx/raw',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`Broadcast failed (${res.statusCode}): ${d}`))
        else resolve(d.replace(/"/g, '').trim())
      })
    })
    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

// ─── UTXO Management ──────────────────────────────────────────────────

async function getUtxos(address) {
  // Try WoC first, fall back to GorillaPool
  try {
    const utxos = await wocGet(`/address/${address}/unspent`)
    if (utxos && utxos.length > 0) {
      return utxos.map(u => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        satoshis: u.value,
        script: u.script_hex,
      }))
    }
  } catch (e) {
    // WoC may have dropped this endpoint
  }

  // Fall back to GorillaPool
  return new Promise((resolve, reject) => {
    https.get(`https://ordinals.gorillapool.io/api/utxos/${address}`, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const utxos = JSON.parse(d)
          resolve((utxos || []).map(u => ({
            txid: u.txid || u.tx_hash,
            vout: u.vout ?? u.tx_pos,
            satoshis: u.satoshis ?? u.value,
            script: u.script || u.script_hex,
          })))
        } catch { reject(new Error(`Failed to parse UTXOs: ${d.slice(0, 200)}`)) }
      })
    }).on('error', reject)
  })
}

async function getCurrentHeight() {
  const info = await wocGet('/chain/info')
  return info.blocks
}

// ─── Helpers ──────────────────────────────────────────────────────────

function generateNonce(bytes = 16) {
  return require('crypto').randomBytes(bytes).toString('hex')
}

function sha256hex(data) {
  return require('crypto').createHash('sha256').update(data).digest('hex')
}

module.exports = {
  loadWallet,
  getKeypair,
  wocGet,
  wocGetRaw,
  wocBroadcast,
  getUtxos,
  getCurrentHeight,
  generateNonce,
  sha256hex,
}

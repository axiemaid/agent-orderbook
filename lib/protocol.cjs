#!/usr/bin/env node
// lib/protocol.cjs — ORD1 OP_RETURN encode/decode utilities

const PREFIX = 'ORD1'

// Actions
const ACTIONS = {
  PLACE:   'PLACE',
  FILL:    'FILL',
  CANCEL:  'CANCEL',
  DELIVER: 'DELIVER',
  DISPUTE: 'DISPUTE',
  REFUND:  'REFUND',
  TIMEOUT: 'TIMEOUT',
}

// Market types
const MARKET_TYPES = {
  COMPUTE: 0,
  DATA: 1,
  SERVICE: 2,
  RELAY: 3,
  INDEX: 4,
  MODEL: 5,
  STORAGE: 6,
  CUSTOM: 7,
}

// Side constants
const SIDES = { BID: 0, ASK: 1 }

// Proof types
const PROOF_TYPES = {
  INSTANT: 0,
  TX_REF: 1,
  HASH_LOCK: 2,
  ORACLE: 3,
}

/**
 * Encode a uint64 as 8-byte little-endian hex
 */
function u64hex(n) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(n))
  return buf.toString('hex')
}

/**
 * Encode a uint32 as 4-byte little-endian hex
 */
function u32hex(n) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(Number(n))
  return buf.toString('hex')
}

/**
 * Encode a uint8 as 1-byte hex
 */
function u8hex(n) {
  return Buffer.alloc(1, Number(n)).toString('hex')
}

/**
 * Build ORD1 PLACE OP_RETURN script
 * Format: OP_FALSE OP_RETURN "ORD1" "PLACE" <type:1B> <side:1B> <price:8B LE> <qty:8B LE>
 *         <agent_id:32B> <expiry:4B LE> <bond_ref:32B> <nonce:16B>
 */
function encodePlace({ type, side, price, quantity, agentId, expiryHeight, bondRef, nonce }) {
  const parts = [
    Buffer.from(PREFIX, 'ascii'),
    Buffer.from('PLACE', 'ascii'),
    Buffer.from([Number(type)]),
    Buffer.from([Number(side)]),
    Buffer.from(u64hex(price), 'hex'),
    Buffer.from(u64hex(quantity), 'hex'),
    Buffer.from(agentId, 'hex'),
    Buffer.from(u32hex(expiryHeight), 'hex'),
    Buffer.from(bondRef, 'hex'),
    Buffer.from(nonce, 'hex'),
  ]
  return parts
}

/**
 * Build ORD1 FILL OP_RETURN data parts
 * Format: "ORD1" "FILL" <order_txid:32B> <taker_id:32B> <fill_price:8B LE> <fill_qty:8B LE>
 *         <delivery_hash:32B or 0s> <taker_bond_ref:32B>
 */
function encodeFill({ orderTxid, takerId, fillPrice, fillQuantity, deliveryHash, takerBondRef }) {
  return [
    Buffer.from(PREFIX, 'ascii'),
    Buffer.from('FILL', 'ascii'),
    Buffer.from(orderTxid, 'hex'),
    Buffer.from(takerId, 'hex'),
    Buffer.from(u64hex(fillPrice), 'hex'),
    Buffer.from(u64hex(fillQuantity), 'hex'),
    Buffer.from(deliveryHash || '00'.repeat(32), 'hex'),
    Buffer.from(takerBondRef, 'hex'),
  ]
}

/**
 * Build ORD1 CANCEL OP_RETURN data parts
 */
function encodeCancel({ orderTxid, reason }) {
  return [
    Buffer.from(PREFIX, 'ascii'),
    Buffer.from('CANCEL', 'ascii'),
    Buffer.from(orderTxid, 'hex'),
    Buffer.from(reason || '', 'ascii'),
  ]
}

/**
 * Build ORD1 DELIVER OP_RETURN data parts
 */
function encodeDeliver({ fillTxid, deliveryData, proofType }) {
  return [
    Buffer.from(PREFIX, 'ascii'),
    Buffer.from('DELIVER', 'ascii'),
    Buffer.from(fillTxid, 'hex'),
    Buffer.from(deliveryData, 'hex'),
    Buffer.from([Number(proofType)]),
  ]
}

/**
 * Build ORD1 DISPUTE OP_RETURN data parts
 */
function encodeDispute({ fillTxid, breachType, evidence }) {
  return [
    Buffer.from(PREFIX, 'ascii'),
    Buffer.from('DISPUTE', 'ascii'),
    Buffer.from(fillTxid, 'hex'),
    Buffer.from([Number(breachType)]),
    Buffer.from(evidence || '', 'ascii'),
  ]
}

/**
 * Parse ORD1 OP_RETURN from a tx output script
 * Returns null if not an ORD1 protocol message
 */
function decodeOrd1(scriptHex) {
  // OP_RETURN format: either OP_FALSE OP_RETURN (0x00 0x6a) or just OP_RETURN (0x6a)
  // followed by pushdata items
  const buf = Buffer.from(scriptHex, 'hex')

  if (buf.length < 6) return null

  // Check for OP_FALSE OP_RETURN or plain OP_RETURN
  let pos
  if (buf[0] === 0x00 && buf[1] === 0x6a) {
    pos = 2
  } else if (buf[0] === 0x6a) {
    pos = 1
  } else {
    return null
  }

  // Extract pushed data items
  const items = []
  while (pos < buf.length) {
    const opcode = buf[pos]
    if (opcode === 0x00) {
      // OP_0 (empty push)
      items.push(Buffer.alloc(0))
      pos += 1
    } else if (opcode >= 0x01 && opcode <= 0x4b) {
      // Direct push: opcode = number of bytes
      items.push(buf.slice(pos + 1, pos + 1 + opcode))
      pos += 1 + opcode
    } else if (opcode === 0x4c) {
      // OP_PUSHDATA1
      const len = buf[pos + 1]
      items.push(buf.slice(pos + 2, pos + 2 + len))
      pos += 2 + len
    } else if (opcode === 0x4d) {
      // OP_PUSHDATA2
      const len = buf.readUInt16LE(pos + 1)
      items.push(buf.slice(pos + 3, pos + 3 + len))
      pos += 3 + len
    } else if (opcode === 0x4e) {
      // OP_PUSHDATA4
      const len = buf.readUInt32LE(pos + 1)
      items.push(buf.slice(pos + 5, pos + 5 + len))
      pos += 5 + len
    } else {
      break
    }
  }

  if (items.length < 2) return null
  if (items[0].toString('ascii') !== PREFIX) return null

  const action = items[1].toString('ascii')
  const result = { action }

  try {
    switch (action) {
      case 'PLACE': {
        result.type = items[2][0]
        result.side = items[3][0]
        result.price = Number(items[4].readBigUInt64LE())
        result.quantity = Number(items[5].readBigUInt64LE())
        result.agentId = items[6].toString('hex')
        result.expiryHeight = items[7].readUInt32LE()
        result.bondRef = items[8].toString('hex')
        result.nonce = items[9].toString('hex')
        break
      }
      case 'FILL': {
        result.orderTxid = items[2].toString('hex')
        result.takerId = items[3].toString('hex')
        result.fillPrice = Number(items[4].readBigUInt64LE())
        result.fillQuantity = Number(items[5].readBigUInt64LE())
        result.deliveryHash = items[6].toString('hex')
        result.takerBondRef = items[7].toString('hex')
        break
      }
      case 'CANCEL': {
        result.orderTxid = items[2].toString('hex')
        result.reason = items[3]?.toString('ascii') || ''
        break
      }
      case 'DELIVER': {
        result.fillTxid = items[2].toString('hex')
        result.deliveryData = items[3].toString('hex')
        result.proofType = items[4][0]
        break
      }
      case 'DISPUTE': {
        result.fillTxid = items[2].toString('hex')
        result.breachType = items[3][0]
        result.evidence = items[4]?.toString('ascii') || ''
        break
      }
      case 'REFUND':
      case 'TIMEOUT':
        // Simple receipts, no extra data
        break
      default:
        return null
    }
  } catch (err) {
    return null
  }

  return result
}

function buildOpReturnScript(parts) {
  // Build OP_FALSE OP_RETURN <pushdata...> script hex
  // BSV nodes require OP_FALSE (0x00) before OP_RETURN (0x6a) for 0-value data outputs
  let scriptHex = '006a'
  for (const part of parts) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part)
    const len = buf.length
    if (len === 0) {
      scriptHex += '00'
    } else if (len <= 75) {
      scriptHex += len.toString(16).padStart(2, '0')
    } else if (len <= 255) {
      scriptHex += '4c' + len.toString(16).padStart(2, '0')
    } else {
      scriptHex += '4d' + (len & 0xff).toString(16).padStart(2, '0') + ((len >> 8) & 0xff).toString(16).padStart(2, '0')
    }
    scriptHex += buf.toString('hex')
  }
  return scriptHex
}

module.exports = {
  PREFIX,
  ACTIONS,
  MARKET_TYPES,
  SIDES,
  PROOF_TYPES,
  u64hex,
  u32hex,
  u8hex,
  encodePlace,
  encodeFill,
  encodeCancel,
  encodeDeliver,
  encodeDispute,
  decodeOrd1,
  buildOpReturnScript,
}

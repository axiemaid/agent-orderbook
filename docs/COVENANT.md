# ORD1 Covenant Reference

## Overview

ORD1 uses three covenant types:

1. **Order Covenant** — locks the order value, enforces fill/cancel/timeout rules
2. **Bond Covenant** — locks collateral, enforces slash/release rules (reuse from bsv-trust)
3. **Delivery Covenant** — locks payment until delivery is proven or window expires

---

## Order Covenant

The order covenant is the core innovation. It's a stateful covenant — the UTXO can be partially spent (partial fills) and the remaining quantity updates.

### State Carried in Script

```
order_state = {
  makerPubKey:   33 bytes    // who can cancel/timeout
  type:          1 byte      // market type
  side:          1 byte      // BID or ASK
  price:         8 bytes LE  // price per unit (sats)
  quantity:      8 bytes LE  // remaining quantity
  expiryHeight: 4 bytes LE  // cancel-after height
  bondTxid:     32 bytes    // reference to bond UTXO
}
```

### Spending Paths

```
┌─────────────────────────────────────────────────┐
│               Order Covenant UTXO                │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │  FILL    │  │  CANCEL  │  │  TIMEOUT      │ │
│  │ (anyone) │  │ (maker)  │  │ (maker,       │ │
│  │          │  │          │  │  post-grace)  │ │
│  └──────────┘  └──────────┘  └───────────────┘ │
└─────────────────────────────────────────────────┘
```

#### Path 1: FILL

Conditions:
- TX must contain ORD1 "FILL" OP_RETURN
- FILL txid in OP_RETURN must match this UTXO's creating txid
- fill_price must satisfy price constraint (≥ for ASK, ≤ for BID)
- fill_quantity must be ≤ remaining quantity
- TX must include a taker bond input (verified by checking input script)
- Output [0] must be payment ≥ fill_price × fill_quantity to maker
- If partial fill: output [1] must be remaining order UTXO with same covenant (reduced quantity)

Script logic (sCrypt pseudocode):
```typescript
@method fill(tx: Tx, fillData: Ord1Fill) {
  // Verify OP_RETURN
  assert(this.checkOpReturn(tx, fillData))
  
  // Verify order reference
  assert(fillData.orderTxid == this.ctx.utxo.outpoint.txid)
  
  // Price constraint
  if (this.side == ASK) {
    assert(fillData.fillPrice >= this.price)
  } else {
    assert(fillData.fillPrice <= this.price)
  }
  
  // Quantity constraint
  assert(fillData.fillQuantity <= this.quantity)
  
  // Taker bond present (check inputs for bond covenant spend)
  assert(this.hasTakerBond(tx))
  
  // Payment output to maker
  assert(tx.outputs[0].value >= fillData.fillPrice * fillData.fillQuantity)
  assert(this.isPaymentToMaker(tx.outputs[0], this.makerPubKey))
  
  // If partial, remaining order UTXO
  if (fillData.fillQuantity < this.quantity) {
    assert(this.isRemainingOrderOutput(tx.outputs[1], this.quantity - fillData.fillQuantity))
  }
  
  // Verify signature (if required for state update)
  assert(this.checkSig(tx, this.sig))
}
```

#### Path 2: CANCEL

Conditions:
- Signed by maker
- Current height > expiry_height (free cancel after expiry)
- OR: signed by maker + cancel penalty output present (pre-expiry cancel with 1% penalty)

```typescript
@method cancel(tx: Tx, sig: Sig) {
  assert(this.checkSig(tx, sig, this.makerPubKey))
  
  if (this.ctx.blockHeight > this.expiryHeight) {
    // Free cancel after expiry
    return true
  } else {
    // Pre-expiry cancel requires penalty
    assert(tx.outputs[1].value >= this.orderValue * CANCEL_PENALTY)
    assert(this.isPaymentToBond(tx.outputs[1], this.bondTxid))
    return true
  }
}
```

#### Path 3: TIMEOUT

Conditions:
- Current height > expiry_height + GRACE_BLOCKS
- Signed by maker
- Bond is released (no slash possible after grace)

```typescript
@method timeout(tx: Tx, sig: Sig) {
  assert(this.ctx.blockHeight > this.expiryHeight + GRACE_BLOCKS)
  assert(this.checkSig(tx, sig, this.makerPubKey))
  return true
}
```

---

## Bond Covenant (Reuse from bsv-trust)

The bond covenant is already built and tested on mainnet. See `~/.openclaw/bsv-trust/bond.ts`.

### Slash Path (for ORD1)

```
DISPUTE triggers slash:
  - Must reference a valid FILL txid
  - Must be after DELIVERY_WINDOW blocks from FILL
  - No DELIVER tx exists for that fill_txid
  - Slashed sats go to the counterparty from the FILL tx
```

The bond covenant's slash path needs to be extended to check for ORD1 DISPUTE OP_RETURN instead of (or in addition to) ASSERT1 dispute format.

### Release Paths

1. **Normal release:** DELIVER tx exists referencing the FILL → bond releases to owner
2. **Timeout:** DELIVERY_WINDOW blocks pass with no DISPUTE → bond releases to owner
3. **Slash:** Valid DISPUTE within window, no DELIVER → bond goes to counterparty

---

## Delivery Covenant

The delivery covenant locks the buyer's payment until the seller proves delivery.

### State

```
delivery_state = {
  makerPubKey:    33 bytes   // seller — receives payment on delivery
  takerPubKey:    33 bytes   // buyer — receives refund on timeout
  fillTxid:       32 bytes   // reference to FILL tx
  deliveryHash:   32 bytes   // expected delivery hash (0s = instant)
  fillPrice:      8 bytes LE
  fillQuantity:   8 bytes LE
}
```

### Spending Paths

```
┌───────────────────────────────────────────────┐
│            Delivery Covenant UTXO              │
│                                                │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
│  │  DELIVER  │  │  REFUND   │  │  DISPUTE  │ │
│  │ (seller)  │  │ (buyer,   │  │ (slash to │ │
│  │           │  │  timeout) │  │  buyer)   │ │
│  └───────────┘  └───────────┘  └───────────┘ │
└───────────────────────────────────────────────┘
```

#### DELIVER path
- Signed by seller (maker)
- Must include ORD1 "DELIVER" OP_RETURN with valid proof
- Payment released to seller
- Seller's bond also releases (bond covenant checks for DELIVER tx)

#### REFUND path
- Current height > FILL height + DELIVERY_WINDOW
- Signed by buyer (taker)
- Full refund to buyer
- Seller's bond NOT auto-slashed (but buyer can still file DISPUTE separately)

#### DISPUTE path
- Anyone can trigger (incentivized watchdogs)
- Must include ORD1 "DISPUTE" OP_RETURN referencing fill_txid
- Must prove no DELIVER tx exists (checked by indexer, not script — script checks height + that dispute is valid format)
- Payment refunded to buyer
- Seller's bond slashed to buyer

---

## Implementation Notes

### sCrypt Requirements
- sCrypt-ts with TypeScript 5.3.3 (known constraint)
- Use `OP_PUSH_TX` for block height verification
- `sigResps[0].sig` for signature access (not `pubKey` field)

### Stateful Covenant Pattern
The order covenant is stateful — partial fills create a new UTXO with the same script but updated quantity. This requires:
1. The covenant script reads its own state from the UTXO's locking script
2. On partial fill, output [1] must have the same covenant script with reduced quantity
3. The script verifies this output exists before accepting the fill

This is the same pattern as UTXO Organisms (ORG1) — claim creates a new UTXO with same covenant + updated generation.

### Testing
- Test all paths on testnet before mainnet
- Especially: partial fill chain (fill → partial fill → partial fill → full)
- Edge case: what if partial fill output is dust? → enforce MIN_FILL so remaining is always ≥ 1 unit

### Known Limitations
- Price negotiation at fill time (fill_price ≠ order_price for ASK) requires the covenant to compare values — this is straightforward in sCrypt
- Taker bond verification (checking that a bond input exists in the tx) requires introspection of other inputs — possible with OP_PUSH_TX but adds script complexity
- REG1 agent verification is NOT enforced at the script level (too complex for covenants) — it's enforced at the indexer/node level (off-chain policy)

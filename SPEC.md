# ORD1 — Agent-Native On-Chain Orderbook Protocol

**Version:** 1.0
**Status:** Draft
**Author:** axiemaid
**Created:** 2026-09-23

---

## 1. Overview

ORD1 is an on-chain orderbook protocol for autonomous agents on BSV. Orders are covenant UTXOs — the chain is both the orderbook and the matching engine. No off-chain matching, no trusted intermediary, no human-in-the-loop. Agents place orders, agents fill orders, covenants settle atomically.

### Design Principles

1. **The order IS the UTXO.** No database. No matching engine. The set of open orders is the set of unspent ORD1 covenant outputs.
2. **Matching = spending.** A fill is a transaction that consumes the order UTXO. Settlement is atomic with the match.
3. **Agents only.** No UI assumptions, no partial fills, no manual approval flows. Orders are pre-authorized at placement.
4. **Bonded.** Every order requires collateral. Bad actors lose sats. Reputation is on-chain history.
5. **Permissionless.** Anyone can index, anyone can match, anyone can place orders. No gatekeeper.
6. **Composable.** Builds on REG1 (agent identity), MA1 (agent messaging), and existing covenant patterns.

---

## 2. Protocol Prefix

```
"ORD1"
```

All ORD1 transactions include `OP_FALSE OP_RETURN "ORD1" ...` as their first data output.

---

## 3. Market Types

| Type ID | Name | Unit | Description |
|---------|------|------|-------------|
| 0 | COMPUTE | 1 inference | LLM inference, image generation, vision analysis |
| 1 | DATA | 1 KB | Datasets, scraped data, query results |
| 2 | SERVICE | 1 action | Monitor, alert, execute a task |
| 3 | RELAY | 1 tx | Message/transaction relay through a node |
| 4 | INDEX | 1 hour | Subscription to an indexing feed |
| 5 | MODEL | 1 chunk | Access to a BSVMODEL-stored model |
| 6 | STORAGE | 1 KB-block | Store data on-chain for a duration |
| 7 | CUSTOM | self-defined | Agent-defined unit, documented in listing |

Market types are convention, not enforcement. The type byte helps indexers route orders to interested agents. New types can be proposed without protocol changes.

---

## 4. Order Sides

| Side | Value | Meaning |
|------|-------|---------|
| BID | 0 | Agent wants to BUY (pay sats for a service) |
| ASK | 0x01 | Agent wants to SELL (offer a service for sats) |

---

## 5. Transaction Formats

### 5.1 PLACE Order

Creates a new order. The covenant UTXO is the order itself.

**Transaction structure:**
```
Inputs:
  [0] Agent's funding UTXO (pays for order value + bond + fees)
  [1] Agent's bond UTXO (collateral — see §7)

Outputs:
  [0] Order covenant UTXO (value = order value, locked by covenant script)
  [1] Bond covenant UTXO (value = bond amount, locked by bond covenant)
  [2] Change to agent (if any)

OP_RETURN (output [3]):
  OP_FALSE OP_RETURN "ORD1" "PLACE" <type:1B> <side:1B>
  <price:8B LE uint64> <quantity:8B LE uint64>
  <agent_id:var> <expiry_height:4B LE uint32>
  <bond_ref:32B> <nonce:16B>
```

| Field | Size | Description |
|-------|------|-------------|
| type | 1 byte | Market type (§3) |
| side | 1 byte | BID (0) or ASK (0x01) |
| price | 8 bytes LE | Price per unit in satoshis |
| quantity | 8 bytes LE | Number of units |
| agent_id | variable | Agent identifier — REG1 txid (32B) or agent pubkey hash (20B) |
| expiry_height | 4 bytes LE | Block height after which order can be cancelled without penalty |
| bond_ref | 32 bytes | TXID of the bond UTXO created in this same tx (output [1]) |
| nonce | 16 bytes | Random bytes — prevents replay / duplicate order hashing |

**Order value** = `price × quantity`. This amount is locked in the order covenant UTXO (output [0]).

For ASK orders: the order value represents the maximum the seller is asking. The actual settlement may be less if the covenant allows price negotiation (see §6.3).

For BID orders: the order value is pre-staked — the buyer has already locked the sats. A matching ASK seller claims them by fulfilling the order.

### 5.2 FILL Order

A counter-agent matches an existing order by spending the order UTXO.

**Transaction structure:**
```
Inputs:
  [0] Order covenant UTXO (being filled — the order itself)
  [1] Taker's bond UTXO (taker also stakes collateral)
  [2] Taker's funding UTXO (pays fees + any additional settlement)

Outputs:
  [0] Settlement output to maker (payment for ASK fill, or service delivery commitment for BID fill)
  [1] Taker's bond UTXO (updated — now linked to this fill)
  [2] Service delivery covenant (if applicable — locks delivery until service is proven)
  [3] Change to taker (if any)

OP_RETURN (output [4]):
  OP_FALSE OP_RETURN "ORD1" "FILL" <order_txid:32B>
  <taker_id:var> <fill_price:8B LE> <fill_quantity:8B LE>
  <delivery_hash:32B or zero> <taker_bond_ref:32B>
```

| Field | Size | Description |
|-------|------|-------------|
| order_txid | 32 bytes | TXID of the PLACE order being filled |
| taker_id | variable | Taker's REG1 txid or pubkey hash |
| fill_price | 8 bytes LE | Actual fill price (≤ order price for ASK, ≥ for BID) |
| fill_quantity | 8 bytes LE | Units being filled (≤ order quantity) |
| delivery_hash | 32 bytes | SHA256 of expected delivery (0s = instant/settled) |
| taker_bond_ref | 32 bytes | TXID of taker's bond UTXO in this tx |

### 5.3 CANCEL Order

The original maker cancels their own order before expiry.

```
Inputs:
  [0] Order covenant UTXO (cancel path)

Outputs:
  [0] Return to maker (order value minus cancel fee)
  [1] Cancel fee to bond (or burns)

OP_RETURN (output [2]):
  OP_FALSE OP_RETURN "ORD1" "CANCEL" <order_txid:32B> <reason:var>
```

Cancel is only allowed:
- By the original maker (signature required)
- After expiry_height has passed (prevents order spam — place and immediately cancel)
- OR with a cancel penalty (small % of order value goes to bond slash)

### 5.4 EXPIRE (implicit)

No transaction needed. After `expiry_height + GRACE_BLOCKS` (default: 144 blocks / ~24h), the order covenant's timeout path unlocks. The maker can reclaim the order UTXO. The bond is released.

```
GRACE_BLOCKS = 144  // ~24 hours after expiry_height
```

### 5.5 DELIVER (service fulfillment)

For non-instantaneous markets (COMPUTE, SERVICE, INDEX, MODEL), the seller must prove delivery.

```
Inputs:
  [0] Service delivery covenant UTXO (from FILL tx output [2])

Outputs:
  [0] Payment to seller (was locked in delivery covenant)
  [1] Bond release to seller

OP_RETURN (output [2]):
  OP_FALSE OP_RETURN "ORD1" "DELIVER" <fill_txid:32B>
  <delivery_data:var or hash> <proof_type:1B>
```

| proof_type | Value | Description |
|------------|-------|-------------|
| INSTANT | 0 | Delivery was instant at fill time (delivery_hash = 0s) |
| TX_REF | 1 | Delivery is on-chain — delivery_data is a txid containing the result |
| HASH_LOCK | 2 | Preimage revealed — delivery_data is SHA256 preimage matching delivery_hash |
| ORACLE | 3 | Third-party oracle signs delivery confirmation (future) |

### 5.6 BOUNTY (post task with locked sats)

A simpler alternative to the orderbook flow. No FILL, no bonds, no delivery covenant. Just: lock sats with a task, anyone who claims gets paid.

**Transaction structure:**
```
Inputs:
  [0] Maker's funding UTXO (pays for reward + fees)

Outputs:
  [0] Bounty covenant UTXO (value = reward, locked by bounty covenant script)
  [1] OP_RETURN: ORD1 BOUNTY receipt
  [2] Change to maker (if any)

OP_RETURN (output [1]):
  OP_FALSE OP_RETURN "ORD1" "BOUNTY" <type:1B> <reward:8B LE uint64>
  <expiry_height:4B LE uint32> <task:var>
```

| Field | Size | Description |
|-------|------|-------------|
| type | 1 byte | Market type (§3) |
| reward | 8 bytes LE | Reward in satoshis (locked in covenant UTXO) |
| expiry_height | 4 bytes LE | Block height after which maker can reclaim |
| task | variable | Task description (UTF-8 text — prompt, question, dataset hash, etc.) |

The task is in the OP_RETURN for indexer discovery. The covenant script only manages payment release — it does not verify the answer.

### 5.7 CLAIM (claim bounty reward)

Any agent who computed the answer claims the reward in a single transaction.

**Transaction structure:**
```
Inputs:
  [0] Bounty covenant UTXO (spend via claim() path)

Outputs:
  [0] Payment to claimer (full reward)
  [1] OP_RETURN: ORD1 CLAIM receipt (fixed)
```

The answer is passed as a method argument (`answer: ByteString`) — it goes into the input script witness, not the OP_RETURN. This keeps covenant outputs fixed-size regardless of answer length. Indexers extract the answer from the claim tx input.

The covenant verifies only:
- Valid claimer signature
- Correct output structure (payment to claimer P2PKH + fixed OP_RETURN)

No answer verification on-chain. Quality is enforced at the reputation layer — indexers track claim history, future bounties can filter by reputation.

### 5.8 BOUNTY TIMEOUT (reclaim expired bounty)

If nobody claims the bounty before expiry, the maker reclaims.

```
Inputs:
  [0] Bounty covenant UTXO (timeout path)

Outputs:
  [0] Full refund to maker
  [1] OP_RETURN: ORD1 TIMEOUT
```

Requires: current block height ≥ expiry_height + GRACE_BLOCKS.

---

## 6. Covenant Script: Order UTXO

The order covenant enforces who can spend the order UTXO and under what conditions.

### 6.1 Spending Paths

The order covenant UTXO has three spending paths:

```
Path 1 — FILL (anyone, with conditions):
  • Must include ORD1 "FILL" OP_RETURN in the same tx
  • Must include a taker bond UTXO as input
  • fill_price must satisfy order constraints (see §6.3)
  • fill_quantity must be ≤ order quantity
  • Taker must be a registered agent (REG1 verification at indexer level, not script level)

Path 2 — CANCEL (maker only, post-expiry):
  • Must be signed by maker's pubkey
  • Current block height must be > expiry_height
  • OR: maker signs + includes cancel penalty payment

Path 3 — TIMEOUT (maker only, post-grace):
  • Current block height must be > expiry_height + GRACE_BLOCKS
  • Must be signed by maker's pubkey
  • Bond released automatically
```

### 6.2 Covenant Script Pseudocode

```
// Order Covenant Script
// Enforces: fill constraints, cancel authority, timeout

function canSpend(tx, input, outputs):
  opReturn = parseOpReturn(tx)
  
  if opReturn.prefix != "ORD1":
    return false
  
  switch opReturn.action:
    case "FILL":
      // Anyone can fill, but must satisfy price constraints
      assert(opReturn.fill_price >= self.minPrice)  // for ASK: taker pays ≥ ask price
      assert(opReturn.fill_quantity <= self.quantity)
      assert(hasTakerBond(tx))                      // taker must stake collateral
      // Settlement outputs must be present
      assert(outputs[0].value >= opReturn.fill_price * opReturn.fill_quantity)
      return true
    
    case "CANCEL":
      assert(verifySig(tx, self.makerPubKey))
      assert(currentHeight > self.expiry_height OR hasCancelPenalty(tx))
      return true
    
    case default:
      // TIMEOUT path — no OP_RETURN action needed
      if currentHeight > self.expiry_height + GRACE_BLOCKS:
        assert(verifySig(tx, self.makerPubKey))
        return true
    
  return false
```

### 6.3 Price Constraints

| Order Type | Fill Constraint |
|------------|----------------|
| ASK (sell) | fill_price ≥ order_price (buyer pays asking price or above) |
| BID (buy) | fill_price ≤ order_price (seller fulfills at bid price or below) |

This prevents adversarial fills (e.g., filling a 1000-sat ASK for 1 sat).

For ASK orders with `fill_price < order_price`, the covenant rejects. For BID orders with `fill_price > order_price`, the covenant rejects. This is enforced by the covenant script comparing `opReturn.fill_price` against the order's locked price.

---

## 7. Bonds and Collateral

### 7.1 Bond Amount

```
bond_amount = max(
  MIN_BOND,                          // 10,000 sats floor
  order_value * BOND_RATIO            // 5% of order value
)

MIN_BOND = 10_000 sats
BOND_RATIO = 0.05
```

Both maker (at PLACE) and taker (at FILL) must stake bonds.

### 7.2 Bond Lifecycle

```
        ┌─────────┐
        │  Staked  │ ← PLACE or FILL tx
        └────┬─────┘
             │
     ┌───────┴───────┐
     ▼               ▼
┌─────────┐   ┌───────────┐
│ Released │   │  Slashed   │
│ (normal) │   │ (breach)   │
└─────────┘   └───────────┘
```

**Released:** Order filled and delivered (DELIVER tx) or cancelled/expired normally.

**Slashed:** Agent breached — failed to deliver after filling (ASK), or failed to pay after receiving delivery (BID). Bond goes to the counterparty.

### 7.3 Breach Detection

Breach is detected off-chain by the counterparty and proven on-chain:

```
DISPUTE: OP_FALSE OP_RETURN "ORD1" "DISPUTE" <fill_txid:32B> <breach_type:1B> <evidence:var>

breach_type:
  0 = NON_DELIVERY (seller didn't deliver within delivery window)
  1 = NON_PAYMENT (buyer didn't confirm payment)
  2 = INVALID_DELIVERY (delivery doesn't match delivery_hash)
```

The bond covenant has a slash path: if a valid DISPUTE OP_RETURN references this bond's fill_txid AND the delivery window has passed, anyone can slash the bond. The slashed sats go to the counterparty (identified in the FILL tx).

```
DELIVERY_WINDOW = 1000 blocks  // ~7 days for service delivery
```

If no DISPUTE is filed within `DELIVERY_WINDOW` blocks after FILL, the bond auto-releases.

### 7.4 Reputation (Application Layer)

Reputation is derived from on-chain history — no separate protocol needed:

```
agent_reputation = {
  orders_placed: count(PLACE txs),
  orders_filled: count(FILL txs where agent is taker),
  orders_delivered: count(DELIVER txs),
  breaches: count(DISPUTE txs resolved against agent),
  fill_ratio: orders_filled / orders_placed,
  bond_slashes: count(slashed bonds)
}
```

Indexers compute this from the ORD1 transaction graph. No oracle, no subjective scoring.

---

## 8. Partial Fills

ORD1 supports partial fills for quantity-based orders.

### 8.1 Partial Fill Transaction

A taker may fill a subset of an order's quantity:

```
FILL tx:
  Inputs:
    [0] Order covenant UTXO (partial spend)
    [1] Taker bond UTXO
    [2] Taker funding UTXO

  Outputs:
    [0] Payment to maker (fill_price × fill_quantity)
    [1] Remaining order covenant UTXO (updated quantity = original - filled)
    [2] Taker bond UTXO
    [3] Service delivery covenant (if applicable)
    [4] Change

  OP_RETURN:
    "ORD1" "FILL" <order_txid> <taker_id>
    <fill_price> <fill_quantity> <delivery_hash> <taker_bond_ref>
```

Output [1] is a new order UTXO with the same covenant terms but reduced quantity. The covenant script must support this — it's a stateful covenant that tracks remaining quantity.

### 8.2 Minimum Fill Quantity

```
MIN_FILL = 1  // minimum 1 unit per fill
```

Prevents dust-filling attacks (adversarial agent fills 1 unit at a time to drain bonds through tx fees).

---

## 9. Agent Node Integration

### 9.1 Event Subscriptions

The agent node exposes a subscription API for ORD1 events:

```
subscribe ORD1 {
  types: [0, 2],          // COMPUTE, SERVICE
  sides: [BID, ASK],      // both
  max_price: 1000,        // sats per unit
  agent_filter: null,     // any agent
}

→ Events:
  ORDER_PLACED { txid, type, side, price, quantity, agent_id, expiry }
  ORDER_FILLED  { order_txid, fill_txid, taker_id, price, quantity }
  ORDER_CANCELLED { txid }
  ORDER_EXPIRED  { txid }
  DELIVERY       { fill_txid, proof_type, delivery_data }
  DISPUTE        { fill_txid, breach_type, evidence }
  BOND_SLASHED   { bond_txid, fill_txid, slashed_to }
```

### 9.2 Orderbook Query API

```
getOpenOrders({
  type: COMPUTE,
  side: ASK,
  maxPrice: 500,        // sats per unit
  minQuantity: 10,
  sortBy: "price_asc",
  limit: 50
})

→ [
  { txid, agent_id, price, quantity, expiry_height, bond_amount },
  ...
]
```

### 9.3 Auto-Matching

The agent node can auto-match for registered agents:

```
registerMatchPolicy({
  agent_id: "my-agent",
  type: COMPUTE,
  side: BID,              // I want to buy compute
  maxPrice: 500,
  minQuantity: 1,
  autoFill: true,         // node fills matching orders automatically
  bondSource: "wallet.json",
})
```

When a matching ASK appears in the mempool, the node:
1. Checks it against registered policies
2. Constructs the FILL transaction
3. Stakes the taker bond
4. Broadcasts the fill

All before the order is even confirmed. Zero-conf order matching.

---

## 10. Protocol Constants

| Constant | Value | Description |
|----------|-------|-------------|
| PROTOCOL_PREFIX | "ORD1" | OP_RETURN prefix |
| MIN_BOND | 10,000 sats | Minimum bond amount |
| BOND_RATIO | 0.05 | Bond = 5% of order value |
| GRACE_BLOCKS | 144 | Blocks after expiry before timeout |
| DELIVERY_WINDOW | 1000 | Blocks to deliver after FILL |
| MIN_FILL | 1 | Minimum units per partial fill |
| CANCEL_PENALTY | 0.01 | 1% of order value if cancelled pre-expiry |

---

## 11. Relationship to Existing Protocols

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  REG1   │────→│  MA1    │────→│  ORD1   │
│ Identity│     │ Comms   │     │ Economy │
└─────────┘     └─────────┘     └─────────┘
      │               │               │
      │               │               ▼
      │               │        ┌──────────┐
      │               └────────│  Agent   │
      │                        │  Node    │
      └────────────────────────│          │
                               └──────────┘
```

| Protocol | Role | Status |
|----------|------|--------|
| **REG1** | Agent identity & discovery | Spec complete, not built |
| **MA1** | Agent-to-agent messaging | Built (MicroAgent) |
| **ORD1** | Agent-to-agent trading | This document |
| **ASSERT1** | On-chain assertions & bonds | Built (bsv-trust) |
| **CARDIMG** | On-chain images | Built |
| **ORG1** | UTXO organisms | Spec + repo, not spawned |
| **BSVMODEL** | On-chain model storage | Built (round-trip tested) |

ORD1 reuses:
- **Bond covenant** from bsv-trust (`bond.ts`) — same slash/release pattern
- **Agent identity** from REG1 — agent_id references REG1 registration txid
- **Delivery proof** from BSVMODEL — on-chain data as proof of delivery
- **Messaging** from MA1 — agents negotiate fills via MA1 before broadcasting

---

## 12. Example Flow: Compute Market

### Agent A (seller) lists inference service

```
PLACE tx:
  Type: COMPUTE (0)
  Side: ASK (0x01)
  Price: 100 sats/inference
  Quantity: 1000 inferences
  Agent: REG1 txid for Agent A
  Expiry: current_height + 1000
  Bond: 5,000 sats (5% of 100,000)

  OP_RETURN: "ORD1" "PLACE" 0x00 0x01 <100:8B> <1000:8B> <agentA_id> <expiry> <bond_ref> <nonce>
```

### Agent B (buyer) fills the order

Agent B's node sees the order via subscription, matches auto-fill policy.

```
FILL tx:
  Inputs:
    [0] Agent A's order UTXO
    [1] Agent B's bond UTXO (5,000 sats)
    [2] Agent B's funding UTXO (100 × 100 = 10,000 sats)

  Outputs:
    [0] 10,000 sats to Agent A (payment, locked in delivery covenant)
    [1] Agent B's bond UTXO (updated)
    [2] Service delivery covenant (10,000 sats, locked until DELIVER)

  OP_RETURN: "ORD1" "FILL" <order_txid> <agentB_id> <100:8B> <100:8B> <delivery_hash> <bondB_ref>
```

### Agent A delivers

Agent A runs 1000 inferences, posts results on-chain (BSVMODEL or direct OP_RETURN), then:

```
DELIVER tx:
  Inputs:
    [0] Service delivery covenant UTXO

  Outputs:
    [0] 10,000 sats to Agent A (payment released)
    [1] Agent A's bond released

  OP_RETURN: "ORD1" "DELIVER" <fill_txid> <result_txid:32B> <proof_type:1B=0x01>
```

### Agent A fails to deliver (breach)

If Agent A doesn't DELIVER within 1000 blocks:

```
DISPUTE tx:
  Inputs:
    [0] Agent A's bond UTXO (slash path)

  Outputs:
    [0] 5,000 sats to Agent B (slashed bond)

  OP_RETURN: "ORD1" "DISPUTE" <fill_txid> <breach_type:0x00=NON_DELIVERY> <evidence>
```

Agent B gets their money back from the delivery covenant AND gets Agent A's bond.

---

## 13. Security Analysis

### 13.1 Attack: Front-Running

**Threat:** Agent sees a favorable ASK in mempool, fills it before the intended buyer.

**Mitigation:** This is a feature, not a bug. First-to-spend wins. The order was public. There is no "intended buyer" — any agent with a bond can fill. Front-running IS the matching engine.

### 13.2 Attack: Fake Orders (Spam)

**Threat:** Agent places orders with no intention of delivering (ASK) or paying (BID).

**Mitigation:**
- Bond is staked at PLACE (5% of order value, min 10,000 sats)
- Bond is slashed on DISPUTE
- Reputation (fill ratio) is visible to all agents via on-chain history
- Agents can filter by minimum reputation score

### 13.3 Attack: Bond Drain via Fees

**Threat:** Adversary fills an order with MIN_FILL=1 unit repeatedly, forcing the maker to pay tx fees for each DELIVER.

**Mitigation:**
- MIN_FILL prevents 0-unit fills
- Maker can set a higher minimum fill in the order covenant (optional field)
- Maker can batch deliveries (one DELIVER tx referencing multiple FILL txids)

### 13.4 Attack: False Dispute

**Threat:** Taker files a DISPUTE even though delivery was made.

**Mitigation:**
- DELIVER tx with on-chain proof (TX_REF or HASH_LOCK) is objective
- If DELIVER tx exists on-chain before DISPUTE, bond is NOT slashable
- False disputers can be counter-slashed (future: DISPUTE on the DISPUTE — recursive bonding)

### 13.5 Attack: Order Never Fills (Griefing)

**Threat:** Agent places an ASK at absurd price, order sits forever, locks sats.

**Mitigation:**
- Expiry height is mandatory — order can't live forever
- After expiry + grace, maker reclaims via timeout
- Agent's sats are locked but recoverable — this is a cost to the griefer too

### 13.6 Attack: Covenant Bug

**Threat:** Script bug allows unauthorized spend of order UTXO.

**Mitigation:**
- Covenant scripts are testable on testnet before mainnet use
- Standard covenant templates (provided by node) are audited
- Bond slash path requires DISPUTE OP_RETURN referencing the specific fill — can't slash without a matching fill txid

---

## 14. Indexer Responsibilities

The agent node's ORD1 indexer maintains:

```
ord1_index = {
  open_orders: [
    {
      txid, type, side, price, quantity, remaining_quantity,
      agent_id, expiry_height, bond_txid, bond_amount,
      placed_at_height, partial_fills: [fill_txids]
    }
  ],
  filled_orders: [
    {
      order_txid, fill_txid, maker_id, taker_id,
      fill_price, fill_quantity, delivery_hash, status
    }
  ],
  deliveries: [
    { fill_txid, deliver_txid, proof_type, delivery_data, height }
  ],
  disputes: [
    { fill_txid, dispute_txid, breach_type, evidence, resolved, winner }
  ],
  agent_stats: {
    agent_id: {
      placed, filled, delivered, breached, slashed, fill_ratio
    }
  }
}
```

---

## 15. Future Extensions

### 15.1 Orderbook Combiners

Agents that aggregate orders across types:
```
"I'll fill any COMPUTE BID under 200 sats/inference AND any DATA ASK for BSV corpus"
```

### 15.2 Recursive Bonds

Bond-on-bond: an agent's bond is itself backed by another agent's bond. Enables delegation — Agent A vouches for Agent B by bonding their own sats behind B's bond.

### 15.3 Oracle Integration

For markets where delivery can't be proven on-chain (physical services, off-chain compute), integrate a M-of-N oracle multisig for delivery confirmation.

### 15.4 AMM Mode

Constant-product AMM as an alternative to orderbook for high-frequency, low-value agent trades. Each market type has a liquidity pool UTXO. Agents swap against it. No orders, no matching — just swap and go.

### 15.5 Cross-Protocol Markets

- ORD1 + ORG1: Trade UTXO organism lineages
- ORD1 + CARDIMG: Trade on-chain card images
- ORD1 + BSVMODEL: Trade model access licenses
- ORD1 + REG1: Trade agent registrations (sell/transfer agent identity)

---

## 16. File Structure (Reference Implementation)

```
agent-orderbook/
├── SPEC.md              ← this document
├── contracts/
│   ├── order.ts         ← order covenant (sCrypt)
│   ├── bond.ts          ← bond covenant (reuse from bsv-trust)
│   └── delivery.ts      ← delivery covenant (locks payment until DELIVER)
├── src/
│   ├── place.cjs        ← PLACE order CLI
│   ├── fill.cjs         ← FILL order CLI
│   ├── cancel.cjs       ← CANCEL order CLI
│   ├── deliver.cjs      ← DELIVER proof CLI
│   ├── dispute.cjs      ← DISPUTE/breach CLI
│   ├── indexer.cjs      ← ORD1 chain scanner + index
│   ├── node-api.cjs     ← agent node subscription/query API
│   └── auto-match.cjs   ← auto-matching engine
├── lib/
│   ├── protocol.cjs     ← OP_RETURN encode/decode
│   ├── covenant.cjs     ← covenant script builder
│   └── wallet.cjs       ← wallet helpers (reuse bsv wallet)
├── state/
│   ├── ord1-index.json  ← orderbook state
│   └── agent-stats.json ← reputation cache
└── docs/
    ├── EXAMPLES.md      ← walkthrough flows
    └── COVENANT.md      ← script reference
```

---

## 17. Summary

ORD1 turns BSV into an agent economy:

- **Orders are UTXOs** — the chain is the orderbook
- **Matching is spending** — atomic settlement, no trusted intermediary
- **Bonds enforce honesty** — slashed on breach, released on delivery
- **Reputation is history** — derived from the transaction graph, no oracle needed
- **Agents are autonomous** — place, fill, deliver, dispute without human input

The agent node hosts the indexer, event stream, and auto-matching. Agents register (REG1), communicate (MA1), and trade (ORD1). Everything else is application logic.

**What you need to build first:** The order covenant. Everything else — bonds, delivery, indexing — you've already built in other projects. The order covenant is the one new piece.
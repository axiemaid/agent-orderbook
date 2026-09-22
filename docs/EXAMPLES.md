# ORD1 — Examples & Walkthroughs

## Example 1: Compute Market (Full Lifecycle)

### Setup
- Agent A: Has Ollama running locally, sells inference
- Agent B: Needs 100 inferences, has sats

### Step 1: Agent A registers (REG1)
```
REG1 PLACE tx:
  Name: "compute-agent-A"
  Specialization: COMPUTE
  Pubkey: 03a00f7...
  Proof-of-work: hash256(nonce + pkh + gen) with 16 leading zero bits
```
→ Agent A is now discoverable

### Step 2: Agent A places ASK order
```
ORD1 PLACE:
  Type: COMPUTE (0x00)
  Side: ASK (0x01)
  Price: 50 sats/inference
  Quantity: 500
  Order value: 25,000 sats
  Bond: 1,250 sats (5%)
  Expiry: current_height + 1000
  Agent ID: REG1 txid

OP_RETURN: OP_FALSE OP_RETURN "ORD1" "PLACE" 0x00 0x01
  <50:8B LE> <500:8B LE> <agentA_reg1_txid:32B>
  <expiry:4B LE> <bond_ref:32B> <nonce:16B>
```

### Step 3: Agent B's node detects the order
```
Event: ORDER_PLACED {
  txid: "abc123...",
  type: COMPUTE,
  side: ASK,
  price: 50,
  quantity: 500,
  agent_id: "agentA_reg1_txid",
  expiry: current+1000
}
```

Agent B's auto-match policy: `buy COMPUTE under 100 sats, min 100 units`

→ Match found. Node constructs FILL tx.

### Step 4: Agent B fills (partial — 200 inferences)
```
FILL tx:
  Inputs:
    [0] Agent A's order UTXO (partial spend)
    [1] Agent B's bond UTXO (1,000 sats — 5% of 10,000)
    [2] Agent B's funding UTXO (10,000 sats for 200 × 50)

  Outputs:
    [0] Delivery covenant UTXO (10,000 sats, locked until DELIVER)
    [1] Remaining order UTXO (15,000 sats, 300 units remaining)
    [2] Agent B's bond UTXO (updated)
    [3] Change to B

  OP_RETURN: "ORD1" "FILL" <order_txid> <agentB_id>
    <50:8B> <200:8B> <delivery_hash:32B> <bondB_ref:32B>
```

### Step 5: Agent A delivers
Agent A runs 200 inferences, posts results on-chain:
```
BSVMODEL upload: 200 inference results, manifest txid = "def456..."
```

Then creates DELIVER tx:
```
DELIVER tx:
  Inputs:
    [0] Delivery covenant UTXO (from FILL output [0])

  Outputs:
    [0] 10,000 sats to Agent A (payment released!)
    [1] Agent A's bond released

  OP_RETURN: "ORD1" "DELIVER" <fill_txid>
    <result_manifest_txid:32B> <proof_type:0x01=TX_REF>
```

### Step 6: Agent A's bond auto-releases
No DISPUTE filed within 1000 blocks → bond covenant timeout path unlocks → Agent A reclaims bond.

---

## Example 2: Data Market (Instant Settlement)

### Agent C sells scraped Mercari OP card price data

```
PLACE:
  Type: DATA (0x01)
  Side: ASK (0x01)
  Price: 2000 sats/dataset
  Quantity: 1
  Bond: 100 sats (5% of 2000, but MIN_BOND = 10,000 → 10,000 sats)
  delivery_hash: SHA256(expected data) = "a1b2c3..."
  Expiry: current + 500
```

### Agent D buys (instant — delivery_hash pre-known)
```
FILL:
  fill_price: 2000
  fill_quantity: 1
  delivery_hash: "a1b2c3..." (matches — buyer knows what they're getting)
  proof_type: INSTANT (0x00)
```

Since delivery_hash was specified at PLACE and the buyer confirms it matches at FILL, settlement is instant. No delivery window needed. Payment goes directly to seller in the FILL tx.

Agent D already has the data hash — they're buying a known dataset. The FILL tx IS the settlement.

---

## Example 3: Breach & Slash

### Agent E places ASK for STORAGE, gets filled, never delivers

```
PLACE: STORAGE, 100 sats/KB, 1000 KB, bond = 5,000 sats
FILL: Agent F buys 1000 KB, pays 100,000 sats, delivery_hash set
```

1000 blocks pass. No DELIVER tx from Agent E.

```
DISPUTE tx:
  Inputs:
    [0] Agent E's bond UTXO (slash path)

  Outputs:
    [0] 5,000 sats to Agent F

  OP_RETURN: "ORD1" "DISPUTE" <fill_txid>
    <breach_type: 0x00 = NON_DELIVERY>
    <evidence: "no DELIVER tx referencing fill_txid found">
```

Agent F also reclaims their 100,000 sats from the delivery covenant (it has a timeout path that returns to the buyer if no DELIVER within the window).

Agent E loses bond + never receives payment. Reputation: 1 breach, 0 deliveries. Other agents will refuse to fill Agent E's future orders (policy filter).

---

## Example 4: Auto-Matching Loop

### Agent B's node configuration
```json
{
  "matchPolicies": [
    {
      "type": "COMPUTE",
      "side": "BID",
      "maxPrice": 100,
      "minQuantity": 50,
      "autoFill": true,
      "bondSource": "wallet.json",
      "maxConcurrentFills": 5
    },
    {
      "type": "DATA",
      "side": "ASK",
      "maxPrice": 5000,
      "minQuantity": 1,
      "autoFill": false,
      "notifyOnly": true
    }
  ]
}
```

### Behavior
1. New COMPUTE BID under 100 sats → node auto-fills, stakes bond, broadcasts
2. New DATA ASK under 5000 sats → node notifies Agent B via MA1 message, waits for manual approval
3. COMPUTE BID at 150 sats → ignored (above maxPrice)
4. Agent B hits 5 concurrent fills → pauses auto-fill until a DELIVER completes

---

## Example 5: Multi-Agent Market Scenario

```
                 ┌──────────────┐
                 │  Agent Node   │
                 │  (ORD1 index) │
                 └──────┬───────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ Agent A  │   │ Agent B  │   │ Agent C  │
   │ Sells    │   │ Buys    │   │ Sells    │
   │ COMPUTE  │   │ COMPUTE │   │ DATA     │
   │ 50 sats  │   │ <100    │   │ 2000 sats│
   └────┬─────┘   └────┬────┘   └────┬─────┘
        │               │              │
        │    ┌──────────┘              │
        │    │  B fills A's order       │
        │    │  (auto-match)            │
        ▼    ▼                          │
   ┌──────────┐                         │
   │ FILL tx  │                         │
   │ A→B      │                         │
   └────┬─────┘                         │
        │                               │
        ▼                               │
   ┌──────────┐                ┌────────┘
   │ DELIVER  │                │
   │ A→B      │   B also buys  │
   └──────────┘   C's data ────→│
                               ▼
                          ┌──────────┐
                          │ FILL tx  │
                          │ C→B      │
                          └──────────┘
```

Agent B is both a buyer of compute (from A) and data (from C). The node manages both matches simultaneously. Agent B's reputation grows with each successful delivery confirmation.

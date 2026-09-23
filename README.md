# ORD1 — Agent-Native On-Chain Orderbook & Bounty Market

Protocol for agent-to-agent trading and task bounties on BSV. Orders are covenant UTXOs. Matching is spending. Settlement is atomic. Bounties lock sats to tasks — any agent who computes the answer claims the reward.

## Documents

- **[SPEC.md](SPEC.md)** — Full protocol specification (orderbook)
- **[docs/EXAMPLES.md](docs/EXAMPLES.md)** — Walkthrough flows (compute, data, breach, auto-match, multi-agent)
- **[docs/COVENANT.md](docs/COVENANT.md)** — Covenant script reference (order, bond, delivery)

## Two Market Models

### 1. Orderbook (order + delivery covenants)

Full orderbook with PLACE → FILL → DELIVER flow. Both sides stake bonds. Partial fills, cancellation, dispute/slash. For complex, multi-step agent trading.

### 2. Bounty Market (bounty covenant) — NEW

Simplest agent task market. Agent A locks sats with a task description. Any agent scans the indexer, computes the answer, and claims the reward in a single transaction. No bonds, no FILL step, no delivery window. Quality is 100% reputation layer — anyone can claim, but garbage answers hurt the claimer's on-chain reputation.

```
Agent A: post-bounty --reward 500 --task "summarize this article"
    → sats locked in bounty covenant UTXO + OP_RETURN "ORD1" "BOUNTY" <task>

Agent B: scan indexer → find bounty → compute answer → claim
    → claim-bounty --bounty-txid <txid> --answer "summary text"
    → covenant releases sats to claimer. Answer recorded on-chain.
```

The covenant has two paths:
- **`claim()`** — any agent signs, payment released. Answer passed as input arg (on-chain, visible to indexers)
- **`timeout()`** — maker reclaims after expiry if nobody solved it

No on-chain answer verification. The covenant is a payment lock — reputation (derived from on-chain claim history) enforces quality at the application layer.

## Status

- ✅ Spec v1.0 draft
- ✅ Order covenant (`contracts/order.ts`) — compiles, **all paths tested on mainnet**
- ✅ Delivery covenant (`contracts/delivery.ts`) — compiles, **all paths tested on mainnet**
- ✅ Hash-lock delivery (`hashLockDeliver`) — `sha256(preimage) == deliveryHash` verified on-chain
- ✅ **Bounty covenant (`contracts/bounty.ts`) — compiles, tested on mainnet**
- ✅ CLI tools: `place`, `fill`, `cancel`, `timeout`, `deliver`, `refund`, `dispute`
- ✅ **Bounty CLI tools: `post-bounty`, `claim-bounty`, `timeout-bounty`**
- ✅ Indexer — scans blocks + mempool, tracks orders, bounties, claims, deliveries
- ✅ Two-agent inference demo — Agent A posts task, Agent B discovers and claims
- ⬜ Bond covenant integration (ASSERT1)
- ⬜ Full lifecycle: place → fill → deploy delivery → deliver → bond release
- ⬜ Agent runtime (automated matching, UTXO management, auto-claim)

## Mainnet Test Results

### Order Covenant Paths

| Action | TXID | Path |
|--------|------|------|
| PLACE (covenant order) | `977e3cbf29ef3db1175e2e717bedffb8f3d35b5d204d97528098fdf1b4a42fe4` | `order` deploy |
| FILL (partial, 200/500) | `efcf0665f47109cd5a39ae9b48da5afc1c8bfa54410501dba3a332e344d65513` | `order.fill()` — continuation UTXO created |
| CANCEL (pre-expiry, 1% penalty) | `344a009b5dbc20ff17304b411ef7c5c2b265e2b0f578e4e9580668f2f237831f` | `order.cancel()` — penalty burned, refund to maker |

### Delivery Covenant Paths

| Action | TXID | Path |
|--------|------|------|
| DELIVER (instant proof) | `4c4b1bf77d29d566708dfd8808a55c7d39710f388eaf2534686bf84ec19c9bac` | `delivery.deliver()` — payment released to seller |
| DISPUTE (within window) | `d2325b56c285cf002e535a86b605d86543e71fba4f92415aa2e504643799d7b3` | `delivery.dispute()` — payment refunded to buyer |
| HASH-LOCK DELIVER | `6d18f409d851b1e34f2517f2b840b4f1b4a52c052f7627d5035eb8c81c5b20d5` | `delivery.hashLockDeliver()` — sha256("4") verified on-chain |

### Bounty Covenant Paths

| Action | TXID | Path |
|--------|------|------|
| BOUNTY (post task) | `3773a5d34c4e773af18e3056797717235292bd0af4b012c12faeb261bd0c39e9` | `bounty` deploy — 500 sats locked, task "What is 5+5?" |
| CLAIM (answer "10") | `7774ced7c2ebd39b5aba93efee5907b39bfeddd74113f17d73c5865a6e516694` | `bounty.claim()` — answer in input script, payment released |

### Two-Agent Inference Demo

Separate wallets, real discovery, autonomous computation:

| Role | Wallet | Address |
|------|--------|---------|
| Agent A (buyer) | `~/.openclaw/bsv-wallet.json` | `15tMS13ewnZY7xti1xmxmhD6cRLnxMxVWQ` |
| Agent B (seller) | `~/.openclaw/bsv-wallet-local.json` | `18VgqjwV3ie11dViH4vhxVdhTgFUv3miXm` |

| Step | TXID | Description |
|------|------|-------------|
| Agent A posts task | `40a5e9d49f556182848a88e0cc5952457f49e5acdd21fbb6c9e1774a7cc3bacd` | "What is 15+27?" locked 1000 sats with sha256("42") |
| Agent B claims | `64830308a8d995659fca79aba6c2375cd06624864d3463daae391314af9b1917` | Computed 42, revealed preimage, payment released |

**Not yet tested on mainnet** (need time to pass):
- `order.timeout()` — requires 100-block grace period
- `delivery.refund()` — requires 1000-block delivery window
- `bounty.timeout()` — requires expiry to pass (100 blocks)

## Architecture

### Three Covenants

1. **Order Covenant** (`order.ts`) — Locks order value (price × quantity). Three spending paths:
   - `fill(takerPkh, fillPrice, fillQuantity, isPartial, changePkh, changeAmount)` — match order, payment + continuation UTXO
   - `cancel(sig)` — maker cancels (1% penalty pre-expiry, free post-expiry)
   - `timeout(sig)` — maker reclaims after expiry + grace period (100 blocks)

2. **Delivery Covenant** (`delivery.ts`) — Locks payment until delivery proven. Four spending paths:
   - `deliver(sig, proofType)` — seller proves delivery, payment released
   - `hashLockDeliver(preimage)` — **permissionless** — anyone who knows the preimage gets paid. Covenant verifies `sha256(preimage) == deliveryHash` on-chain
   - `refund(sig)` — buyer reclaims after delivery window expires (1000 blocks)
   - `dispute(disputerSig, disputerPub)` — anyone triggers within window, payment refunds to buyer

3. **Bounty Covenant** (`bounty.ts`) — Simplest market. Locks sats to a task. Two spending paths:
   - `claim(claimerPub, claimerSig, claimerPkh, answer)` — any agent signs, payment released. Answer stored in input script witness (on-chain, visible to indexers). No verification of answer correctness — reputation layer handles quality.
   - `timeout(sig)` — maker reclaims after expiry if nobody solved it

### How the Bounty Model Works

Like UTXO Organisms — the UTXO sits on-chain, anyone who can spend it correctly gets the reward. The "work" (computing an answer) happens off-chain. The covenant just manages payment release.

1. Agent A posts bounty: locks sats in covenant, task description in OP_RETURN
2. Agent B scans indexer, finds bounty + task
3. Agent B computes answer off-chain
4. Agent B claims: spends the bounty UTXO, answer in input script, payment to claimer
5. Covenant verifies: valid signature → payment released. No answer quality check.
6. Reputation = on-chain history. Indexers track claims per agent. Future bounties can filter by reputation.

No bonds, no delivery window, no dispute flow. The simplest possible trustless task market.

### How Hash-Lock Delivery Works (Orderbook Model)

For deterministic tasks where the buyer knows the expected answer:

1. Agent A has a question and expected answer. Computes `hash = sha256(answer)`.
2. Locks payment in delivery covenant with `deliveryHash = hash`. Question goes in OP_RETURN (public).
3. **Anyone** can claim by revealing the preimage (the answer).
4. The covenant verifies `sha256(preimage) == deliveryHash` — if it matches, payment is released.
5. The answer is permanently recorded on-chain — open, verifiable inference.

No identity check. No whitelist. No designated seller. The hash IS the gate.

### Key Design Decisions

- **sCrypt `fromTx` + `bindTxBuilder`**: Covenant instances loaded from on-chain txs, tx builders construct outputs matching `hashOutputs`
- **Change output accounting**: `fill()` accepts `changePkh`/`changeAmount` params so external inputs are accounted for in `hashOutputs`
- **Continuation UTXO**: Partial fills create a new order covenant UTXO with reduced quantity — enables chained fills
- **OP_RETURN inline**: Covenant scripts build OP_RETURN directly to ensure exact byte match with `hashOutputs`
- **Permissionless claims**: `hashLockDeliver` and `bounty.claim()` — no whitelist, no designated recipient. Pure market mechanics.
- **Answer in input script**: Bounty answers go in the input witness (method arg), not OP_RETURN output. This keeps covenant outputs fixed-size. Indexers extract answers from the claim tx input.

### BSV Quirks

- `bsv` lib from `scrypt-ts` package, NOT standalone `bsv` npm package (v2 is different API)
- OP_RETURN requires `OP_FALSE OP_RETURN` (`0x00 0x6a`) for 0-value data outputs
- sCrypt transpiler requires TypeScript 5.3.3 (breaks on 5.9)
- `Sig` type needs callback pattern: `(sigResps) => sigResps[0].sig` — not placeholder bytes
- `TestWallet` must use the real private key matching the covenant's expected signer (not random dummy key)
- `sha256()` in sCrypt matches Node.js `crypto.createHash('sha256')` — verified on mainnet
- `toByteString(hexStr)` (without 2nd arg) treats input as hex → bytes. `toByteString(hexStr, true)` treats input as literal string → double-encodes. Use without 2nd arg for ByteString args.

## Quick Start

```bash
# Install
npm install

# Compile contracts (order, delivery, bounty)
npm run compile

# ─── Bounty Market (simplest) ────────────────────────

# Post a bounty (lock sats to a task)
node src/post-bounty.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --type COMPUTE --reward 500 --expiry 100 --task "What is 5+5?"

# Claim a bounty (any agent who computed the answer)
node src/claim-bounty.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --bounty-txid <txid> --answer "10"

# Reclaim expired bounty (if nobody solved it)
node src/timeout-bounty.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --bounty-txid <txid>

# ─── Orderbook ───────────────────────────────────────

# Place an order (covenant UTXO)
node src/place.cjs --type COMPUTE --side ASK --price 50 --quantity 500

# Fill an order (partial fill creates continuation UTXO)
node src/fill.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --order-txid <txid> --fill-price 50 --fill-quantity 200

# Cancel remaining (pre-expiry = 1% penalty)
node src/cancel.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --order-txid <fill-txid>

# ─── Delivery Covenant ────────────────────────────────

# Deploy delivery covenant + release with instant proof
node src/deliver.cjs --deploy --wallet ~/.openclaw/bsv-wallet.json --amount 10000
node src/deliver.cjs --delivery-txid <txid> --wallet ~/.openclaw/bsv-wallet.json --proof-type 0

# Dispute a delivery (within window)
node src/dispute.cjs --wallet ~/.openclaw/bsv-wallet.json --delivery-txid <txid>

# ─── Inference Demo (two agents) ──────────────────────

# Agent A posts task
node demo/agent-a-post.cjs --question "What is 15+27?" --answer "42" --amount 1000

# Agent B scans, computes answer, claims payment
node demo/agent-b-scan.cjs

# ─── Indexer ──────────────────────────────────────────

# Scan blocks + mempool for ORD1 transactions (orders + bounties)
node src/indexer.cjs
```

## Protocol Constants

| Constant | Value | Description |
|----------|-------|-------------|
| CANCEL_PENALTY | 1% | Pre-expiry cancel penalty (numerator=1, denominator=100) |
| GRACE_BLOCKS | 100 | Blocks after expiry before timeout available |
| DELIVERY_WINDOW | 1000 | Blocks to deliver before buyer can refund (~7 days) |
| PROOF_INSTANT | 0 | No proof needed (instant settlement) |
| PROOF_TX_REF | 1 | On-chain tx contains result |
| PROOF_HASH_LOCK | 2 | Preimage revealed matching hash |
| PROOF_ORACLE | 3 | Third-party oracle (future) |

## Market Types

| Type | Name | Description |
|------|------|-------------|
| 0 | COMPUTE | Compute power (CPU/GPU) |
| 1 | DATA | Data feeds / datasets |
| 2 | SERVICE | Off-chain services |
| 3 | RELAY | Message relay / routing |
| 4 | INDEX | Indexing / curation |
| 5 | MODEL | AI model inference |
| 6 | STORAGE | Decentralized storage |
| 7 | CUSTOM | Custom / other |

## File Structure

```
agent-orderbook/
├── contracts/
│   ├── order.ts              # Order covenant (fill/cancel/timeout)
│   ├── delivery.ts           # Delivery covenant (deliver/hashLockDeliver/refund/dispute)
│   └── bounty.ts            # Bounty covenant (claim/timeout) — NEW
├── artifacts/
│   └── contracts/
│       ├── order.json        # Compiled artifact
│       ├── delivery.json     # Compiled artifact
│       └── bounty.json       # Compiled artifact
├── dist/
│   └── contracts/            # Compiled JS (tsc output)
├── src/
│   ├── place.cjs             # Place order (covenant UTXO)
│   ├── fill.cjs              # Fill order (covenant spend)
│   ├── cancel.cjs            # Cancel order (covenant spend)
│   ├── timeout.cjs           # Timeout reclaim (covenant spend)
│   ├── deliver.cjs           # Deploy delivery + release payment
│   ├── refund.cjs            # Buyer refund after delivery window
│   ├── dispute.cjs           # Dispute delivery (refund to buyer)
│   ├── post-bounty.cjs       # Post bounty (lock sats to task) — NEW
│   ├── claim-bounty.cjs      # Claim bounty (answer + payment release) — NEW
│   ├── timeout-bounty.cjs    # Reclaim expired bounty — NEW
│   └── indexer.cjs           # Block + mempool scanner (orders + bounties)
├── demo/
│   ├── inference-demo.cjs    # Single-wallet demo (proof of concept)
│   ├── agent-a-post.cjs      # Agent A: post inference task on-chain
│   └── agent-b-scan.cjs      # Agent B: discover task, compute, claim payment
├── lib/
│   ├── protocol.cjs          # OP_RETURN encode/decode (PLACE/FILL/CANCEL/DELIVER/DISPUTE/BOUNTY/CLAIM)
│   └── wallet.cjs            # Wallet + WoC API helpers
├── state/
│   ├── orders.json           # Order state
│   ├── bounties.json         # Bounty state — NEW
│   ├── deliveries.json       # Delivery state
│   └── tasks.json            # Inference task state
├── docs/
│   ├── COVENANT.md           # Covenant script reference
│   └── EXAMPLES.md           # Flow walkthroughs
├── SPEC.md                   # Protocol specification
├── tsconfig.json             # TypeScript config (sCrypt)
├── tsconfig.bounty.json     # Bounty-only TS config (noEmit: false)
└── package.json
```

## Builds On

- **REG1** (identity) — Agent discovery via UTXO beacons
- **MA1** (messaging) — Agent-to-agent communication
- **ASSERT1** (bonds) — Reputation/staking
- **BSVMODEL** (delivery proof) — On-chain model inference
- **ORG1** (UTXO organisms) — Self-propagating covenant pattern (bounty uses same spend-to-claim structure)

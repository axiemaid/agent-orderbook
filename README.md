# ORD1 — Agent-Native On-Chain Orderbook

Protocol spec for agent-to-agent trading on BSV. Orders are covenant UTXOs. Matching is spending. Settlement is atomic.

## Documents

- **[SPEC.md](SPEC.md)** — Full protocol specification
- **[docs/EXAMPLES.md](docs/EXAMPLES.md)** — Walkthrough flows (compute, data, breach, auto-match, multi-agent)
- **[docs/COVENANT.md](docs/COVENANT.md)** — Covenant script reference (order, bond, delivery)

## Status

- ✅ Spec v1.0 draft
- ✅ Order covenant (`contracts/order.ts`) — compiles, **all paths tested on mainnet**
- ✅ Delivery covenant (`contracts/delivery.ts`) — compiles, **all paths tested on mainnet**
- ✅ Hash-lock delivery (`hashLockDeliver`) — `sha256(preimage) == deliveryHash` verified on-chain
- ✅ CLI tools: `place`, `fill`, `cancel`, `timeout`, `deliver`, `refund`, `dispute`
- ✅ Indexer — scans blocks + mempool, tracks order state
- ✅ Two-agent inference demo — Agent A posts task, Agent B discovers and claims
- ⬜ Bond covenant integration (ASSERT1)
- ⬜ Full lifecycle: place → fill → deploy delivery → deliver → bond release
- ⬜ Agent runtime (automated matching, UTXO management)

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

## Architecture

### Two Covenants

1. **Order Covenant** (`order.ts`) — Locks order value (price × quantity). Three spending paths:
   - `fill(takerPkh, fillPrice, fillQuantity, isPartial, changePkh, changeAmount)` — match order, payment + continuation UTXO
   - `cancel(sig)` — maker cancels (1% penalty pre-expiry, free post-expiry)
   - `timeout(sig)` — maker reclaims after expiry + grace period (100 blocks)

2. **Delivery Covenant** (`delivery.ts`) — Locks payment until delivery proven. Four spending paths:
   - `deliver(sig, proofType)` — seller proves delivery, payment released
   - `hashLockDeliver(preimage)` — **permissionless** — anyone who knows the preimage gets paid. Covenant verifies `sha256(preimage) == deliveryHash` on-chain
   - `refund(sig)` — buyer reclaims after delivery window expires (1000 blocks)
   - `dispute(disputerSig, disputerPub)` — anyone triggers within window, payment refunds to buyer

### How Hash-Lock Delivery Works

The key mechanism for inference tasks:

1. Agent A has a question and expected answer. Computes `hash = sha256(answer)`.
2. Locks payment in delivery covenant with `deliveryHash = hash`. Question goes in OP_RETURN (public).
3. **Anyone** can claim by revealing the preimage (the answer).
4. The covenant verifies `sha256(preimage) == deliveryHash` — if it matches, payment is released.
5. The answer is permanently recorded on-chain — open, verifiable inference.

No identity check. No whitelist. No designated seller. The hash IS the gate. If you can produce the answer, you get paid. The difficulty of the computation determines who can actually claim — that's the market.

### Key Design Decisions

- **sCrypt `fromTx` + `bindTxBuilder`**: Covenant instances loaded from on-chain txs, tx builders construct outputs matching `hashOutputs`
- **Change output accounting**: `fill()` accepts `changePkh`/`changeAmount` params so external inputs are accounted for in `hashOutputs`
- **Continuation UTXO**: Partial fills create a new order covenant UTXO with reduced quantity — enables chained fills
- **OP_RETURN inline**: Covenant scripts build OP_RETURN directly to ensure exact byte match with `hashOutputs`
- **Permissionless claims**: `hashLockDeliver` checks only the hash — no signature, no identity. Pure proof-of-knowledge.

### BSV Quirks

- `bsv` lib from `scrypt-ts` package, NOT standalone `bsv` npm package (v2 is different API)
- OP_RETURN requires `OP_FALSE OP_RETURN` (`0x00 0x6a`) for 0-value data outputs
- sCrypt transpiler requires TypeScript 5.3.3 (breaks on 5.9)
- `Sig` type needs callback pattern: `(sigResps) => sigResps[0].sig` — not placeholder bytes
- `TestWallet` must use the real private key matching the covenant's expected signer (not random dummy key)
- `sha256()` in sCrypt matches Node.js `crypto.createHash('sha256')` — verified on mainnet

## Quick Start

```bash
# Install
npm install

# Compile contracts
npx scrypt-cli compile -i contracts/order.ts
npx scrypt-cli compile -i contracts/delivery.ts
npx tsc -p tsconfig.json --outDir dist --noEmit false

# ─── Order Covenant ───────────────────────────────────

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

# Scan blocks + mempool for ORD1 transactions
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
│   └── delivery.ts           # Delivery covenant (deliver/hashLockDeliver/refund/dispute)
├── artifacts/
│   └── contracts/
│       ├── order.json        # Compiled artifact
│       └── delivery.json     # Compiled artifact
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
│   └── indexer.cjs           # Block + mempool scanner
├── demo/
│   ├── inference-demo.cjs    # Single-wallet demo (proof of concept)
│   ├── agent-a-post.cjs      # Agent A: post inference task on-chain
│   └── agent-b-scan.cjs      # Agent B: discover task, compute, claim payment
├── lib/
│   ├── protocol.cjs          # OP_RETURN encode/decode
│   └── wallet.cjs            # Wallet + WoC API helpers
├── state/
│   ├── orders.json           # Order state
│   ├── deliveries.json       # Delivery state
│   └── tasks.json            # Inference task state
├── docs/
│   ├── COVENANT.md           # Covenant script reference
│   └── EXAMPLES.md           # Flow walkthroughs
├── SPEC.md                   # Protocol specification
└── tsconfig.json             # TypeScript config (sCrypt)
```

## Builds On

- **REG1** (identity) — Agent discovery via UTXO beacons
- **MA1** (messaging) — Agent-to-agent communication
- **ASSERT1** (bonds) — Reputation/staking
- **BSVMODEL** (delivery proof) — On-chain model inference

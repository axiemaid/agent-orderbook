# ORD1 — Agent-Native On-Chain Orderbook

Protocol spec for agent-to-agent trading on BSV. Orders are covenant UTXOs. Matching is spending. Settlement is atomic.

## Documents

- **[SPEC.md](SPEC.md)** — Full protocol specification
- **[docs/EXAMPLES.md](docs/EXAMPLES.md)** — Walkthrough flows (compute, data, breach, auto-match, multi-agent)
- **[docs/COVENANT.md](docs/COVENANT.md)** — Covenant script reference (order, bond, delivery)

## Status

- ✅ Spec v1.0 draft
- ✅ Order covenant implementation (`contracts/order.ts`) — compiles, **tested on mainnet**
- ✅ Delivery covenant implementation (`contracts/delivery.ts`) — compiles, **tested on mainnet**
- ✅ CLI tools: `place`, `fill`, `cancel`, `timeout`, `deliver`, `refund`, `dispute`
- ✅ Indexer — scans blocks + mempool, tracks order state
- ⬜ Bond covenant adaptation (reuse from bsv-trust)
- ⬜ Full lifecycle integration (place → fill → deliver → bond release)
- ⬜ Agent runtime (automated matching, UTXO management)

## Mainnet Test Results

All covenant paths tested on BSV mainnet:

| Action | TXID | Path |
|--------|------|------|
| PLACE (covenant order) | `977e3cbf29ef3db1175e2e717bedffb8f3d35b5d204d97528098fdf1b4a42fe4` | `order.ts` deploy |
| FILL (partial, 200/500) | `efcf0665f47109cd5a39ae9b48da5afc1c8bfa54410501dba3a332e344d65513` | `order.fill()` — continuation UTXO created |
| CANCEL (pre-expiry, 1% penalty) | `344a009b5dbc20ff17304b411ef7c5c2b265e2b0f578e4e9580668f2f237831f` | `order.cancel()` — penalty burned, refund to maker |
| DELIVER (instant proof) | `4c4b1bf77d29d566708dfd8808a55c7d39710f388eaf2534686bf84ec19c9bac` | `delivery.deliver()` — payment released to seller |
| DISPUTE (within window) | `d2325b56c285cf002e535a86b605d86543e71fba4f92415aa2e504643799d7b3` | `delivery.dispute()` — payment refunded to buyer |

Also tested (simplified P2PKH, pre-covenant):
| PLACE (simplified) | `bb7e1a6528b22fcf059d9fe89b491ba142429e6acddf78778a834f20cd791668` | P2PKH order |
| FILL (simplified) | `184b9d5675d4d6315c976861de697c8d500d982e5b8305ae23f0a34871c888ff` | P2PKH fill |

**Not yet tested on mainnet:**
- `order.timeout()` — requires 100-block grace period to pass
- `delivery.refund()` — requires 1000-block delivery window to pass

## Architecture

### Two Covenants

1. **Order Covenant** (`order.ts`) — Locks order value (price × quantity). Three spending paths:
   - `fill(takerPkh, fillPrice, fillQuantity, isPartial, changePkh, changeAmount)` — match order, payment + continuation UTXO
   - `cancel(sig)` — maker cancels (1% penalty pre-expiry, free post-expiry)
   - `timeout(sig)` — maker reclaims after expiry + grace period (100 blocks)

2. **Delivery Covenant** (`delivery.ts`) — Locks payment until delivery proven. Three spending paths:
   - `deliver(sig, proofType)` — seller proves delivery, payment released
   - `refund(sig)` — buyer reclaims after delivery window expires (1000 blocks)
   - `dispute(disputerSig, disputerPub)` — anyone triggers within window, payment refunds to buyer

### Key Design Decisions

- **sCrypt `fromTx` + `bindTxBuilder`**: Covenant instances are loaded from on-chain txs, tx builders construct outputs matching the script's `hashOutputs` check
- **Change output accounting**: The `fill()` method accepts `changePkh` and `changeAmount` parameters so external inputs (taker funding) can add change outputs that the covenant accounts for in `hashOutputs`
- **Continuation UTXO**: Partial fills create a new order covenant UTXO with reduced quantity — enables chained fills
- **OP_RETURN format**: Covenant scripts build OP_RETURN inline (not via external library) to ensure exact byte match with `hashOutputs`
- **Locktime**: `cancel()`, `timeout()`, `refund()` use `nLockTime` for height-based time constraints

### BSV Quirks

- `bsv` lib from `scrypt-ts` package, NOT standalone `bsv` npm package (v2 is different API)
- OP_RETURN requires `OP_FALSE OP_RETURN` (`0x00 0x6a`) for 0-value data outputs
- sCrypt transpiler requires TypeScript 5.3.3 (breaks on 5.9)
- `Sig` type needs callback pattern: `(sigResps) => sigResps[0].sig` — not placeholder bytes
- `TestWallet` must use the real private key matching the covenant's expected signer (not a random dummy key)

## Quick Start

```bash
# Install
npm install

# Compile contracts
npx scrypt-cli compile -i contracts/order.ts
npx scrypt-cli compile -i contracts/delivery.ts
npx tsc -p tsconfig.json --outDir dist --noEmit false

# Place an order (covenant UTXO)
node src/place.cjs --type COMPUTE --side ASK --price 50 --quantity 500

# Fill an order
node src/fill.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --order-txid <txid> --fill-price 50 --fill-quantity 200

# Cancel remaining (pre-expiry = 1% penalty)
node src/cancel.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --order-txid <fill-txid>

# Deploy delivery covenant + release
node src/deliver.cjs --deploy --wallet ~/.openclaw/bsv-wallet.json --amount 10000
node src/deliver.cjs --delivery-txid <txid> --wallet ~/.openclaw/bsv-wallet.json --proof-type 0

# Dispute a delivery
node src/dispute.cjs --wallet ~/.openclaw/bsv-wallet.json --delivery-txid <txid>

# Run indexer
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
│   ├── order.ts          # Order covenant (fill/cancel/timeout)
│   └── delivery.ts       # Delivery covenant (deliver/refund/dispute)
├── artifacts/
│   └── contracts/
│       ├── order.json    # Compiled artifact
│       └── delivery.json # Compiled artifact
├── dist/
│   └── contracts/        # Compiled JS (tsc output)
├── src/
│   ├── place.cjs         # Place order
│   ├── fill.cjs         # Fill order (covenant spend)
│   ├── cancel.cjs       # Cancel order (covenant spend)
│   ├── timeout.cjs       # Timeout reclaim (covenant spend)
│   ├── deliver.cjs      # Deploy delivery + release payment
│   ├── refund.cjs        # Buyer refund after delivery window
│   ├── dispute.cjs      # Dispute delivery (refund to buyer)
│   └── indexer.cjs      # Block + mempool scanner
├── lib/
│   ├── protocol.cjs      # OP_RETURN encode/decode
│   └── wallet.cjs        # Wallet + WoC API helpers
├── state/
│   ├── orders.json       # Order state
│   └── deliveries.json   # Delivery state
├── docs/
│   ├── COVENANT.md       # Covenant script reference
│   └── EXAMPLES.md       # Flow walkthroughs
├── SPEC.md               # Protocol specification
└── tsconfig.json         # TypeScript config (sCrypt)
```

## Builds On

- **REG1** (identity) — Agent discovery via UTXO beacons
- **MA1** (messaging) — Agent-to-agent communication
- **ASSERT1** (bonds) — Reputation/staking
- **BSVMODEL** (delivery proof) — On-chain model inference

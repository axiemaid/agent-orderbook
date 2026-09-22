# ORD1 — Agent-Native On-Chain Orderbook

Protocol for agent-to-agent trading on BSV. Orders are covenant UTXOs. Matching is spending. Settlement is atomic. No matching engine, no trusted intermediary, no human-in-the-loop.

**Repo:** https://github.com/axiemaid/agent-orderbook
**Local:** `~/.openclaw/agent-orderbook/`

## Documents

- **[SPEC.md](SPEC.md)** — Full protocol specification (17 sections)
- **[docs/EXAMPLES.md](docs/EXAMPLES.md)** — Walkthrough flows (compute, data, breach, auto-match, multi-agent)
- **[docs/COVENANT.md](docs/COVENANT.md)** — Covenant script reference (order, bond, delivery)

## Status

### ✅ Done
- Spec v1.0 draft (17 sections, protocol constants, security analysis)
- Order covenant (`contracts/order.ts`) — compiles with sCrypt, 3 spending paths (fill/cancel/timeout), stateful (partial fills)
- Delivery covenant (`contracts/delivery.ts`) — compiles with sCrypt, 3 spending paths (deliver/refund/dispute)
- Protocol lib (`lib/protocol.cjs`) — OP_RETURN encode/decode for all actions, `buildOpReturnScript()` helper
- Wallet lib (`lib/wallet.cjs`) — wallet loading (WIF), WoC API helpers, UTXO fetching
- PLACE CLI (`src/place.cjs`) — working, first mainnet order broadcast
- FILL CLI (`src/fill.cjs`) — working, partial fills, price constraint enforcement
- CANCEL CLI (`src/cancel.cjs`) — written (can't test yet — fill consumed the UTXO)
- Indexer (`src/indexer.cjs`) — scans mempool + blocks, decodes ORD1, tracks order state
- **First mainnet order:** PLACE TXID `bb7e1a6528b22fcf059d9fe89b491ba142429e6acddf78778a834f20cd791668` (COMPUTE ASK, 50 sats/unit, 500 units)
- **First mainnet fill:** FILL TXID `184b9d5675d4d6315c976861de697c8d500d982e5b8305ae23f0a34871c888ff` (partial fill, 200/500 units)

### ⬜ Next Steps
1. **Integrate real covenant UTXOs** — replace simplified P2PKH with actual order covenant script in CLI tools
2. **DELIVER + DISPUTE CLI** — write `src/deliver.cjs` and `src/dispute.cjs`
3. **Test delivery covenant** — end-to-end DELIVER/REFUND/DISPUTE flows on mainnet
4. **Block scanner** — indexer currently relies on local state for mempool txids; add full block scanning for confirmed txs
5. **Agent node integration** — event subscriptions (WebSocket), auto-matching engine, orderbook query API
6. **REG1 integration** — real agent IDs from REG1 registration txids
7. **Bond covenant integration** — use actual `bond.ts` from bsv-trust instead of simplified self-bond
8. **BSVMODEL delivery proof** — wire in on-chain model storage as delivery proof type

### Architecture Notes
- Currently using **simplified P2PKH** for order/bond/delivery UTXOs (not real covenants yet)
- The covenant contracts compile and have artifacts, but the CLI tools don't deploy them yet
- Transition path: swap P2PKH outputs for covenant locking scripts — CLI structure stays the same
- `bsv` library comes from `scrypt-ts` package (NOT standalone `bsv` npm v2 — different API)
- BSV nodes require `OP_FALSE OP_RETURN` (`0x00 0x6a`) for 0-value data outputs — use `buildOpReturnScript()`

## Quick Start

```bash
# Install
cd ~/.openclaw/agent-orderbook
npm install
npx ts-patch install  # required for sCrypt

# Compile covenants
npx scrypt-cli compile -i contracts/order.ts
npx scrypt-cli compile -i contracts/delivery.ts

# Place an order
node src/place.cjs --type COMPUTE --side ASK --price 50 --quantity 500

# Fill an order (partial)
node src/fill.cjs --wallet ~/.openclaw/bsv-wallet.json \
  --order-txid <place-txid> --fill-price 50 --fill-quantity 200

# Run indexer
node src/indexer.cjs --scan-back 10
```

## Protocol Constants

| Constant | Value |
|----------|-------|
| PROTOCOL_PREFIX | "ORD1" |
| MIN_BOND | 10,000 sats |
| BOND_RATIO | 5% of order value |
| GRACE_BLOCKS | 144 (~24h) |
| DELIVERY_WINDOW | 1000 blocks (~7 days) |
| MIN_FILL | 1 unit |
| CANCEL_PENALTY | 1% of order value |

## Market Types

| ID | Name | Unit |
|----|------|------|
| 0 | COMPUTE | 1 inference |
| 1 | DATA | 1 KB |
| 2 | SERVICE | 1 action |
| 3 | RELAY | 1 tx |
| 4 | INDEX | 1 hour |
| 5 | MODEL | 1 chunk |
| 6 | STORAGE | 1 KB-block |
| 7 | CUSTOM | self-defined |

## Builds On

| Protocol | Role | Status |
|----------|------|--------|
| REG1 | Agent identity | Spec complete, not built |
| MA1 | Agent messaging | Built (MicroAgent) |
| ASSERT1 | Bonds & assertions | Built + mainnet tested |
| BSVMODEL | On-chain delivery proof | Built (round-trip tested) |

## File Structure

```
agent-orderbook/
├── SPEC.md                 # Full protocol spec
├── README.md               # This file
├── contracts/
│   ├── order.ts            # Order covenant (fill/cancel/timeout)
│   └── delivery.ts         # Delivery covenant (deliver/refund/dispute)
├── docs/
│   ├── EXAMPLES.md         # Walkthrough flows
│   └── COVENANT.md         # Covenant script reference
├── lib/
│   ├── protocol.cjs        # OP_RETURN encode/decode
│   └── wallet.cjs          # Wallet + WoC API helpers
├── src/
│   ├── place.cjs           # PLACE order CLI
│   ├── fill.cjs            # FILL order CLI
│   ├── cancel.cjs          # CANCEL order CLI
│   └── indexer.cjs         # ORD1 chain scanner + orderbook index
├── state/                  # Local state (gitignored)
│   └── orders.json         # Order state
├── artifacts/              # sCrypt compile output (gitignored)
├── package.json
└── tsconfig.json
```

## Author

axiemaid

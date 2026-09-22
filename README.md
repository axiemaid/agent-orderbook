# ORD1 — Agent-Native On-Chain Orderbook

Protocol spec for agent-to-agent trading on BSV. Orders are covenant UTXOs. Matching is spending. Settlement is atomic.

## Documents

- **[SPEC.md](SPEC.md)** — Full protocol specification
- **[docs/EXAMPLES.md](docs/EXAMPLES.md)** — Walkthrough flows (compute, data, breach, auto-match, multi-agent)
- **[docs/COVENANT.md](docs/COVENANT.md)** — Covenant script reference (order, bond, delivery)

## Status

- ✅ Spec v1.0 draft
- ⬜ Order covenant implementation (`contracts/order.ts`)
- ⬜ Bond covenant adaptation (reuse from bsv-trust)
- ⬜ Delivery covenant implementation (`contracts/delivery.ts`)
- ⬜ CLI tools (place, fill, cancel, deliver, dispute)
- ⬜ Indexer
- ⬜ Agent node integration

## Builds On

| Protocol | Role | Status |
|----------|------|--------|
| REG1 | Agent identity | Spec complete |
| MA1 | Agent messaging | Built |
| ASSERT1 | Bonds & assertions | Built + mainnet tested |
| BSVMODEL | On-chain delivery proof | Built |

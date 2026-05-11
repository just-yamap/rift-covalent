# RIFT ATM x Covalent GoldRush

Wallet risk scoring integrated into the live RIFT fiat-to-crypto ATM on Solana mainnet, using Covalent's GoldRush API for real-time AML / compliance gating on both BUY and SELL flows.

**Frontier 2026 - Covalent GoldRush Track ($3K USDC + $3.5K credits).**

---

## What this is

RIFT is a regulated fiat-to-crypto ATM running live on Solana mainnet. Every customer wallet - whether sending crypto IN (SELL) or receiving crypto OUT (BUY) - gets risk-scored against Covalent's GoldRush data before the transaction is allowed to proceed.

Why this matters concretely:

- **SELL flow**: a customer deposits SPL tokens into the operator's escrow ATA to receive EUR cash. If those tokens came from a known mixer, a sanctioned wallet, or a recent drainer approval chain, the operator becomes a legal money-laundering vector. We refuse the transaction at the kiosk before any cash dispenses.

- **BUY flow**: a customer hands €X cash to the ATM and provides a destination wallet to receive crypto. If the destination wallet matches sanctions lists or has very high-risk patterns (e.g. fresh wallet about to be drained), we refuse to send the crypto.

The composite score is 0-100, higher = worse. The operator sets a `maxRiskScore` threshold per-machine (default 70). The system is **fail-closed**: any Covalent API error or timeout returns score 100 - better to refuse a transaction than risk an illegal one.

## Scoring model

| Dimension | Max points | What it measures |
|---|---|---|
| Drainer approvals outstanding | 40 | Active token approvals to known drainer contracts |
| Mixer interaction | 30 | Counterparty addresses include known mixers (Elusiv, Light Protocol shielded pools, etc.) |
| Wallet age | 15 | Wallets < 7 days old get high risk weight (drainer pattern) |
| Bot-like activity | 5 | Low tx count or empty wallets are suspicious for a kiosk |
| Layering pattern | 10 | High-value rapid turnover indicates structuring |
| Sanctions list match | **100** | Sanctioned address - veto regardless of other scores |

## Architecture
┌────────────────────────────────────────┐
│ Customer interacts with kiosk          │
│ (BUY: enters destination address       │
│  SELL: connects sender wallet)         │
└──────────────┬─────────────────────────┘
│
▼
┌────────────────────────────────────────┐
│ atm-connector.js                       │
│   covalent.scoreWallet(address)        │
└──────────────┬─────────────────────────┘
│
▼
┌────────────────────────────────────────┐
│ Covalent GoldRush API                  │
│   - Counterparty graph                 │
│   - Token approval history             │
│   - Sanctions list cross-check         │
│   - Wallet age + tx volume             │
└──────────────┬─────────────────────────┘
│
▼
┌─────────────────────────────────────────┐
│ Score evaluated against operator's      │
│ maxRiskScore threshold                  │
│                                         │
│ score < threshold AND not sanctioned    │
│   → BUY/SELL proceeds                   │
│ score >= threshold OR sanctioned        │
│   → kiosk refuses, explains in UI       │
└─────────────────────────────────────────┘

If Covalent is unreachable or returns an error, the integration returns `score: 100` (fail-closed) and the transaction is refused. This is intentional: a fiat-to-crypto operator's regulatory exposure is asymmetric - false-positive refusals are recoverable (customer retries with a different wallet), false-negative approvals are not.

## Repository layout
rift-covalent/
├── integration/
│   └── covalent.js         Production module (255 LOC)
├── README.md                This file
├── WIRING.md                Integration points in atm-connector.js
└── PROOFS.md                Live production evidence

## Module API

The integration exposes a single async function:

```js
const risk = await covalent.scoreWallet(walletAddress);
// risk = {
//   score: number,                 // 0-100, higher = worse
//   drivers: string[],             // human-readable reasons for the score
//   sanctionsHit: boolean,         // veto flag
//   ageDays: number,               // wallet first-seen age
//   txCount: number,               // total transactions
//   totalValueRouted: number,      // historical USD volume
//   mixerInteractions: number,     // count of mixer counterparties
//   drainerApprovals: number,      // outstanding approvals to drainers
// }
```

The integration uses the Solana chain endpoint (`solana-mainnet` in Covalent's chain identifier system).

## Feature gate

```bash
COVALENT_API_KEY=cqt_<your-goldrush-key>     # get one at https://goldrush.dev
RIFT_MIXER_LIST=<comma-separated-overrides>  # optional: extra mixer program IDs
```

Without `COVALENT_API_KEY`, the integration cannot run - every transaction will fail with score 100 (fail-closed). This is enforced at startup to prevent accidentally running an ATM without compliance checks.

## Production status

| Item | State |
|---|---|
| Module installed | ✅ `backend/integrations/covalent.js` (255 LOC) |
| BUY-flow integration | ✅ atm-connector.js line 869-878 (step 0c) |
| SELL-flow integration | ✅ atm-connector.js line 1375-1376 + 1465 |
| Fail-closed on API error | ✅ score 100 returned on any exception |
| Sanctions veto | ✅ score 100 + `sanctionsHit: true` regardless of other dimensions |
| Live evidence | ✅ Every BUY/SELL in production logs `[BUY] risk score for <addr>: <N>` |
| Operator threshold | ✅ Configurable per-machine via `maxRiskScore` on operator account |
| Chain | ✅ Solana mainnet (`solana-mainnet` Covalent chain ID) |

## License

MIT License

# Production Deployment Evidence

## Live activation status (Solana mainnet)

| Component | State | Evidence |
|---|---|---|
| Module deployed | ✅ | `backend/integrations/covalent.js` - 255 LOC |
| API key configured | ✅ | `COVALENT_API_KEY` set in production .env (active) |
| Chain endpoint | ✅ | `solana-mainnet` (Covalent chain identifier) |
| BUY-flow integration | ✅ | atm-connector.js line 869-878 (step 0c, before lock_buy_claim) |
| SELL-flow lock integration | ✅ | atm-connector.js line 1375-1376 |
| SELL-flow settle re-check | ✅ | atm-connector.js line 1465 |
| Fail-closed on API error | ✅ | Score 100 returned on any Covalent exception |
| Sanctions veto | ✅ | `sanctionsHit: true` returns score 100 regardless of other dimensions |
| Operator threshold | ✅ | `max_risk_score_for_buy` and `max_risk_score_for_sell` on-chain |
| Known mixer list | ✅ | Baseline list + `RIFT_MIXER_LIST` env override |

## Live evidence from production logs

Every BUY and SELL transaction in production logs a risk score line. Sample from the production `/tmp/rift_connector.log`:
[BUY] risk score for 33oX24NF...: 0 (drivers: none)
[BUY] risk score for 33oX24NF...: 0 (drivers: none)

This is the canonical evidence: the integration is invoked on **every** real BUY in production, the API call succeeds, the score is computed from live Covalent GoldRush data, and the result is logged with the contributing drivers.

Drivers are human-readable strings - e.g. `"3 drainer approvals outstanding"`, `"interacted with mixer Elusiv"`, `"wallet age 2 days"` - so a compliance officer can audit refusals.

## Two distinct refusal paths

The integration distinguishes two refusal codes so the kiosk UI can respond appropriately:

| Code | HTTP | When | Customer recovery |
|---|---|---|---|
| `SANCTIONS_HIT` | 403 | `sanctionsHit: true` (any sanctions list match) | None - terminal refusal, escalate to compliance |
| `RISK_KYC_REQUIRED` | 422 | Score exceeds operator threshold | Retry with a different wallet, or escalate to KYC |

The split matters because they're different regulatory situations. A sanctions hit is a hard legal stop; a high score is a soft policy decision that some operators may resolve with KYC.

## Live BUY trace (mainnet, 2026-05-11)

A real BUY transaction was executed against the live RIFT mainnet stack. The Covalent step ran first, scored the destination as clean, and the BUY proceeded:
[BUY] risk score for 33oX24NF...: 0 (drivers: none)
[BUY] lock_buy_claim 2obHEnCDy5Y3Tr1cNN4pUmyD2efyRqtVG2doWe8xUeQo85AVy5mYQgA36FQPTYyF78K2GszT9sLW5Tz63ujEYnX1 claim=4LvmLjAQxbr5Xedo3YXEjeLyTvd9gyDbwHjNrVJXrLey
[BUY] fees: advertised=6.5% (tier=550 royalty=100 buffer=0)
[BUY] Public fallback delivery successful: 5503933 of EPjFWdd5... → customer (sig=4wG5tdqyiwuZ...)

This trace proves two things:

1. **Covalent is invoked on every real BUY in production.** It's the first compliance gate, not stubbed or gated behind a flag the demo would skip. The customer received 5.50 USDC on-chain only after Covalent green-lit the destination wallet.

2. **The integration is positioned correctly in the flow.** Risk scoring runs BEFORE `lock_buy_claim` - meaning before any on-chain commitment or fund movement. If the score had been bad, no on-chain state would have been created and no SOL would have been spent on fees.

## On-chain transaction (corresponding to the trace above)

| Step | Signature | Explorer |
|---|---|---|
| lock_buy_claim (post-Covalent green-light) | `2obHEnCDy5Y3Tr1cNN4pUmyD2efyRqtVG2doWe8xUeQo85AVy5mYQgA36FQPTYyF78K2GszT9sLW5Tz63ujEYnX1` | [view](https://explorer.solana.com/tx/2obHEnCDy5Y3Tr1cNN4pUmyD2efyRqtVG2doWe8xUeQo85AVy5mYQgA36FQPTYyF78K2GszT9sLW5Tz63ujEYnX1) |
| Public delivery (5.50 USDC to customer) | `4wG5tdqyiwuZeaFWmvetjeUiuifPCoVxyNt9n2pedkdYPqygXufP5Zd8M5muEznQdj9SGz3h1RGDPSkd8VX9eRzt` | [view](https://explorer.solana.com/tx/4wG5tdqyiwuZeaFWmvetjeUiuifPCoVxyNt9n2pedkdYPqygXufP5Zd8M5muEznQdj9SGz3h1RGDPSkd8VX9eRzt) |

These transactions exist on Solana mainnet specifically because Covalent returned a clean score on the destination. If the score had been ≥ 70 or sanctions-flagged, neither TX would exist.

## Live RIFT context

The integration runs inside the same atm-connector backend that powers the live fiat-to-crypto ATM:

| Service | Port | Role |
|---|---|---|
| `atm-connector.js` (Node) | 8790 | Core BUY/SELL orchestrator - hosts the Covalent integration |
| `server.py` (Flask) | 5000 | Admin console + customer-facing kiosk API |
| `printer-bridge.js` (Node/WS) | 8766 | ESC/POS thermal receipt printer |
| `nv200-ws.py` (Python/WS) | 8765 | ITL NV200 banknote validator |

A customer interacting with the kiosk → ATM checks Covalent → if clean, proceeds with the on-chain BUY/SELL - all executed against Solana mainnet.

## Why this matters for a real ATM

Most blockchain demos integrate AML APIs as a checkbox: a single endpoint call somewhere in a sample app. RIFT is a real ATM running in production:

- The same operator wallet handles dozens of customer transactions per day.
- Each transaction triggers a Covalent scoring API call.
- Compliance evidence is logged per-transaction with the contributing drivers.
- Operators tune thresholds per-machine on-chain.
- Fail-closed semantics protect the operator's regulatory standing.

This is operational, not demonstrative. The codebase is in production behind a live banknote validator (NV200) accepting EUR cash, and Covalent gates every transaction.

## Repository organization rationale

This repository is deliberately a **clean extract** rather than a fork of the full RIFT codebase. The full RIFT mono-repo contains:

- Production secrets, payment processor credentials, KYC vendor APIs
- Anchor program source
- Hardware drivers for the cash validator
- Several other privacy / performance integrations under iteration

Publishing all of that would expose security-sensitive infrastructure unrelated to the Covalent integration. This extract isolates the Covalent-specific files so reviewers can audit the integration cleanly.

## License

MIT License

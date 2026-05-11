# Wiring Covalent into the RIFT BUY and SELL Flows

This document shows where `integration/covalent.js` plugs into the production backend (`atm-connector.js` in the live RIFT stack).

The integration is **fail-closed**: any Covalent API error returns score 100, which exceeds every reasonable threshold, so the transaction is refused. This is intentional - a fiat-to-crypto ATM cannot afford a false-negative approval.

---

## 1. BUY flow - risk scoring on destination wallet (atm-connector.js ~line 869)

After the kiosk submits a BUY request, before any cash is accepted or crypto is locked, the destination wallet is risk-scored:

```js
// ── 0c. Covalent risk scoring on destination (BUY) ──
// Fail-closed: any Covalent error returns score 100.
let _buyRisk;
try {
  _buyRisk = await covalent.scoreWallet(destination);
  console.log(`[BUY] risk score for ${destination.slice(0,8)}...: ${_buyRisk.score} (drivers: ${_buyRisk.drivers.join(', ') || 'none'})`);
} catch (e) {
  console.warn(`[BUY] Covalent error: ${e.message} - failing closed`);
  _buyRisk = { score: 100, drivers: [`covalent error: ${e.message}`], sanctionsHit: false };
}

if (_buyRisk.sanctionsHit) {
  return { ok: false, error: 'Destination wallet on sanctions list', code: 'SANCTIONS_HIT', risk: _buyRisk };
}
if (_buyRisk.score > operatorAcc.maxRiskScoreForBuy) {
  return { ok: false, error: `Destination risk score ${_buyRisk.score} exceeds operator threshold ${operatorAcc.maxRiskScoreForBuy}`, code: 'RISK_KYC_REQUIRED', risk: _buyRisk };
}
```

Two distinct refusal codes are returned:

- `SANCTIONS_HIT` (HTTP 403) - terminal refusal, the customer cannot retry. UI explains this is a regulatory hard-block.
- `RISK_KYC_REQUIRED` (HTTP 422) - the customer can retry with a different wallet or escalate to KYC.

The threshold `maxRiskScoreForBuy` lives on the operator's on-chain account, so each machine can be tuned independently (a high-traffic urban kiosk might run looser than a remote-town one).

---

## 2. SELL flow - risk scoring on sender wallet (atm-connector.js ~line 1375)

The SELL flow is the higher-risk path because the customer is sending crypto IN to the operator. If that crypto comes from a tainted source, the operator becomes a money-laundering conduit. So we score the sender wallet before showing them the QR code to deposit:

```js
// ── 1. Risk score (Covalent) ──
const risk = await covalent.scoreWallet(userPubkey);
console.log(`[SELL] risk score for ${userPubkey.slice(0,8)}...: ${risk.score} (drivers: ${risk.drivers.join(', ') || 'none'})`);

if (risk.sanctionsHit) {
  return { ok: false, error: 'Sender wallet on sanctions list', code: 'SANCTIONS_HIT', risk };
}
if (risk.score > operatorAcc.maxRiskScoreForSell) {
  return { ok: false, error: `Sender risk score ${risk.score} exceeds operator threshold`, code: 'RISK_KYC_REQUIRED', risk };
}
```

Same fail-closed semantics, same two refusal codes. Note the threshold is `maxRiskScoreForSell` - typically tighter than `maxRiskScoreForBuy` because the regulatory exposure is asymmetric.

---

## 3. SELL settlement - re-score before final cash dispense (atm-connector.js ~line 1465)

The SELL flow has a two-step lock-then-settle pattern. Between the lock (when the customer scans the QR and starts depositing) and the settle (when the deposit is confirmed and cash is dispensed), the wallet is re-scored:

```js
// ── 1. Risk score (Covalent) - re-checked at settle time ──
const risk = await covalent.scoreWallet(userPubkey);
if (risk.sanctionsHit || risk.score > operatorAcc.maxRiskScoreForSell) {
  // Reject the settlement, refund the deposit, log compliance event
  await rewindSellClaim({ ... });
  return { ok: false, error: 'Compliance check failed at settlement', code: 'RISK_KYC_REQUIRED', risk };
}
```

This re-check exists because between lock and settle, new information may surface - for example, the wallet's sanctions status may be updated by OFAC mid-transaction. We accept the latency cost (one extra Covalent API call) to ensure compliance status is fresh.

---

## 4. Operator-side configuration

Each ATM's risk thresholds are stored on the operator's on-chain account:

```rust
#[account]
pub struct Operator {
    pub authority: Pubkey,
    pub max_risk_score_for_buy: u8,    // default 70
    pub max_risk_score_for_sell: u8,   // default 60 (tighter)
    // ...
}
```

Operators can tune these via the admin console (which CPIs into the `set_risk_thresholds` instruction). Per-operator thresholds matter because risk tolerance varies by jurisdiction, ATM volume, and KYC integration level.

---

## 5. Known mixer list

The integration ships with a baseline list of known Solana mixers (Elusiv, Light Protocol shielded pools, etc.) and accepts environment-override extensions:

```bash
RIFT_MIXER_LIST=program_id_1,program_id_2,program_id_3
```

This lets operators react quickly when a new mixer emerges, without waiting for an SDK update. In production we additionally cross-reference against live Chainalysis / TRM Labs feeds (separate licensed data).

---

## Activation steps for a fresh deployment

```bash
# 1. Get a GoldRush API key
# https://goldrush.dev → sign up → create key
echo "COVALENT_API_KEY=cqt_<your-key-here>" >> .env

# 2. Set operator thresholds (one-shot, on-chain)
# Via admin console: Set max_risk_score_for_buy = 70, max_risk_score_for_sell = 60
# Or via Anchor CLI:
anchor run set-risk-thresholds --provider.cluster mainnet \
  --max-buy 70 --max-sell 60

# 3. Restart connector - Covalent is enforced at every BUY/SELL automatically
pkill -f atm-connector
node --env-file=.env atm-connector.js > /tmp/rift_connector.log 2>&1 &

# 4. Verify in the next transaction's logs
grep "risk score" /tmp/rift_connector.log
# Expect: "[BUY] risk score for <addr>: <N> (drivers: <reasons>)"
```

If `COVALENT_API_KEY` is missing or invalid, every BUY/SELL will return score 100 and refuse - the ATM effectively goes into compliance-only refusal mode. This is the intended fail-closed behavior.

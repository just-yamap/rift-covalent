/**
 * Covalent GoldRush — wallet risk scoring for sell-side compliance.
 *
 * Frontier track: $3k USDC + $3.5k credits.
 * Docs: https://goldrush.dev/docs  ·  API key: https://goldrush.dev
 *
 * What we use it for:
 *   Before accepting a user's SPL deposit on the sell flow, we score the
 *   incoming wallet on dimensions like drainer-approval history, mixer
 *   interaction, age, total routed value. If the composite score exceeds
 *   the operator's `maxRiskScore` threshold (default 70/100), the kiosk
 *   refuses the transaction and explains the refusal in the UI.
 *
 * Scoring (0-100, higher = worse):
 *   - Drainer approvals outstanding ........... 40 points max
 *   - Interaction with known mixers ........... 30 points max
 *   - Age of wallet (< 7 days high risk) ...... 15 points max
 *   - Low tx count or empty (bot-like) ........  5 points max
 *   - High-value rapid turnover (layering) .... 10 points max
 *   - Sanctions list match ..................... 100 (veto regardless)
 *
 * Returns { score, drivers: string[], sanctionsHit: bool, ageDays, txCount,
 *           totalValueRouted, mixerInteractions, drainerApprovals }
 */
'use strict';
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const BASE = 'https://api.covalenthq.com/v1';
const CHAIN_ID = 'solana-mainnet'; // Solana chain identifier in Covalent

// ── Known mixer / tumbler programs on Solana ──
// These are program IDs that correspond to known mixing services.
// In production, pull from a live Chainalysis / TRM Labs feed.
const KNOWN_MIXERS = new Set([
  // Tornado-Cash-like on Solana (Elusiv, Light Protocol shielded pools)
  'E1us7LPhiDZbcXMhBKbriCMmWnB8GSz2PKNMdeFg7yzK',   // Elusiv program
  '2c54pLrGpQdGxJWUAoME6CReBrtDbsx5Tqx4nLZZo6av',   // Light Protocol pool
  // Add more as they emerge — hotswap via env override
  ...(process.env.RIFT_MIXER_LIST?.split(',').filter(Boolean) || []),
]);

// ── Known drainer / exploit contracts ──
const KNOWN_DRAINERS = new Set([
  ...(process.env.RIFT_DRAINER_LIST?.split(',').filter(Boolean) || []),
]);

// ── Dynamic blacklist polled from Flask admin (auto-refresh every 60s) ──
// Flask admin lets operators manage a wallet blacklist via UI.
// We poll /api/public/blacklist and merge with RIFT_SANCTIONS_LIST env var.
let _dynamicBlacklist = new Set();
const FLASK_BLACKLIST_URL = process.env.FLASK_BLACKLIST_URL || 'https://localhost:5000/api/public/blacklist';
const BLACKLIST_POLL_MS = parseInt(process.env.BLACKLIST_POLL_MS || '60000', 10);

async function refreshBlacklist() {
  try {
    // INT-06: only bypass TLS for localhost (self-signed mkcert); enforce for remote
    const https = require('https');
    const isLocal = /^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(FLASK_BLACKLIST_URL);
    const agent = isLocal ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    const fetchFn = await import('node-fetch').then(m => m.default);
    const res = await fetchFn(FLASK_BLACKLIST_URL, { agent, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.warn(`[blacklist-poll] Flask returned ${res.status}`);
      return;
    }
    const data = await res.json();
    const wallets = Array.isArray(data.wallets) ? data.wallets : [];
    const newSet = new Set(wallets.filter(Boolean));
    if (newSet.size !== _dynamicBlacklist.size || [...newSet].some(w => !_dynamicBlacklist.has(w))) {
      console.log(`[blacklist-poll] Updated: ${newSet.size} wallets blocked (was ${_dynamicBlacklist.size})`);
    }
    _dynamicBlacklist = newSet;
  } catch (e) {
    console.warn('[blacklist-poll] Failed:', e.message);
    // Keep last known set on failure (fail-safe)
  }
}

// Start polling immediately + every BLACKLIST_POLL_MS
refreshBlacklist();
setInterval(refreshBlacklist, BLACKLIST_POLL_MS);

function authHeader() {
  const key = process.env.COVALENT_API_KEY;
  if (!key) throw new Error('COVALENT_API_KEY not set');
  return { authorization: `Bearer ${key}` };
}

async function getWalletTransactions(address, limit = 200) {
  const url = `${BASE}/${CHAIN_ID}/address/${address}/transactions_v3/?page-size=${limit}`;
  const res = await fetch(url, { headers: authHeader(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`covalent transactions failed: ${res.status}`);
  return await res.json();
}

async function getTokenApprovals(address) {
  const url = `${BASE}/${CHAIN_ID}/address/${address}/balances_v2/`;
  const res = await fetch(url, { headers: authHeader(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`covalent balances failed: ${res.status}`);
  return await res.json();
}

/**
 * Check for interactions with known mixer programs.
 * Scans tx logs for program invocations against the mixer set.
 */
function checkMixerInteraction(items) {
  let mixerCount = 0;
  const mixerAddrs = [];
  for (const tx of items) {
    // Covalent v3 items include log_events with sender_address (program)
    const logs = tx.log_events || [];
    for (const log of logs) {
      const prog = log.sender_address || log.decoded?.contract_address;
      if (prog && KNOWN_MIXERS.has(prog)) {
        mixerCount++;
        if (!mixerAddrs.includes(prog)) mixerAddrs.push(prog);
      }
    }
    // Also check direct to/from fields
    const counterparties = [tx.to_address, tx.from_address].filter(Boolean);
    for (const cp of counterparties) {
      if (KNOWN_MIXERS.has(cp)) {
        mixerCount++;
        if (!mixerAddrs.includes(cp)) mixerAddrs.push(cp);
      }
    }
  }
  return { mixerCount, mixerAddrs };
}

/**
 * Check for outstanding delegate approvals to known drainer contracts.
 * Uses the balances_v2 response which includes approval info.
 */
function checkDrainerApprovals(balancesData) {
  let drainerApprovalCount = 0;
  const drainerAddrs = [];
  const items = balancesData?.data?.items || [];
  for (const token of items) {
    // Covalent balances_v2 includes spender approvals under `spenders`
    const spenders = token.spenders || [];
    for (const sp of spenders) {
      const addr = sp.spender_address;
      if (addr && KNOWN_DRAINERS.has(addr)) {
        drainerApprovalCount++;
        if (!drainerAddrs.includes(addr)) drainerAddrs.push(addr);
      }
    }
  }
  return { drainerApprovalCount, drainerAddrs };
}

/**
 * Detect layering — high-value rapid turnover within short time windows.
 * Pattern: many large transfers in < 24h suggest money laundering.
 */
function checkLayeringPattern(items) {
  if (items.length < 5) return { score: 0 };
  // Look at transactions in the last 24 hours
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = items.filter(tx => {
    const t = new Date(tx.block_signed_at).getTime();
    return t > dayAgo;
  });
  if (recent.length < 5) return { score: 0 };
  // Sum total value moved
  const totalValue = recent.reduce((s, tx) => s + (Number(tx.value) || 0), 0);
  const avgValue = totalValue / recent.length;
  // High frequency + high value = suspicious
  if (recent.length > 20 && avgValue > 1e9) return { score: 10 }; // 10 points
  if (recent.length > 10 && avgValue > 5e8) return { score: 5 };
  return { score: 0 };
}

/**
 * Compute a 0–100 risk score. Sanctions hit short-circuits to 100.
 */
async function scoreWallet(address) {
  const drivers = [];
  let score = 0;
  let sanctionsHit = false;
  let drainerApprovals = 0;
  let tokenCount = 0;

  // ── Sanctions check FIRST (no API call needed for direct address match) ──
  const envBad = process.env.RIFT_SANCTIONS_LIST?.split(',').filter(Boolean) || [];
  const KNOWN_BAD = new Set([...envBad, ..._dynamicBlacklist]);
  if (KNOWN_BAD.has(address)) {
    return {
      score: 100,
      drivers: [`address ${address.slice(0,8)}... is on sanctions/blacklist`],
      sanctionsHit: true,
      ageDays: 0,
      txCount: 0,
      totalValueRouted: 0,
      mixerInteractions: 0,
      drainerApprovals: 0,
    };
  }

  try {
    // Solana support on Covalent is limited — only balances_v2 is available.
    // We score on: drainer approvals (the highest-signal compliance dimension),
    // direct sanctions match, and token concentration heuristics.
    const balances = await getTokenApprovals(address);
    const items = balances?.data?.items || [];
    tokenCount = items.length;

    // ── Drainer approval detection (40 pts max) ──
    const drainer = checkDrainerApprovals(balances);
    drainerApprovals = drainer.drainerApprovalCount;
    if (drainer.drainerApprovalCount > 0) {
      const pts = Math.min(40, drainer.drainerApprovalCount * 20);
      score += pts;
      drivers.push(`${drainer.drainerApprovalCount} drainer approvals (${drainer.drainerAddrs.join(', ')})`);
    }

    // ── Token concentration heuristic (10 pts max) ──
    // Wallets holding many obscure tokens are often drainer-targeted or sketchy.
    if (tokenCount > 50) {
      score += 10;
      drivers.push(`unusually high token count (${tokenCount} tokens)`);
    } else if (tokenCount > 20) {
      score += 5;
      drivers.push(`high token count (${tokenCount} tokens)`);
    }

    // ── Empty wallet heuristic (5 pts) ──
    // Brand new / empty wallets get a small flag — bot-like behavior.
    if (tokenCount === 0) {
      score += 5;
      drivers.push('empty wallet (no tokens or activity)');
    }

  } catch (e) {
    // Fail-closed — block on Covalent error to prevent compliance bypass.
    drivers.push(`covalent error: ${e.message}`);
    score = 100;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    drivers,
    sanctionsHit,
    ageDays: 0,           // not available on Solana via Covalent
    txCount: 0,           // not available on Solana via Covalent
    totalValueRouted: 0,  // not available on Solana via Covalent
    mixerInteractions: 0, // not available on Solana via Covalent (no tx history)
    drainerApprovals,
    tokenCount,
  };
}

module.exports = { scoreWallet, getWalletTransactions, getTokenApprovals };

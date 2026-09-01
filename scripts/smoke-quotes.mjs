#!/usr/bin/env node
/**
 * Route-matrix smoke test: quotes every live listed token against USDC
 * (both directions, ~$5 notional where oracle prices exist, else a small
 * unit amount) through the FULL quote path (pathfinder included) and
 * reports route, output, and cost vs oracle. Replaces hand-testing every
 * asset after a deploy.
 *
 * Usage: node scripts/smoke-quotes.mjs [apiBase]
 * Exit code 1 if any pair errors (for CI / post-deploy hooks).
 */

const API = process.argv[2] ?? 'https://atomicswap-aggregator-production.up.railway.app';
const USDC_SYMBOL = 'USDC';
const CONCURRENCY = 3;

const assetsRes = await fetch(`${API}/api/assets`);
if (!assetsRes.ok) {
  console.error(`assets fetch failed: ${assetsRes.status}`);
  process.exit(1);
}
const { assets } = await assetsRes.json();
const usdc = assets.find((a) => a.symbol === USDC_SYMBOL);
const tokens = assets.filter(
  (a) => a.status === 'live' && a.sacAddress && a.symbol !== USDC_SYMBOL
);
console.log(`${tokens.length} live tokens vs ${USDC_SYMBOL} — ${tokens.length * 2} quotes\n`);

/** ~$5 of a token in base units, from a $-price guess via a probe quote. */
function unitsFor(t) {
  // $5 of USDC-side is exact; for the token side, quote $5 USDC -> token
  // first and reuse the output as the reverse input (keeps both
  // directions at comparable notional without needing oracle coverage).
  return null; // resolved inline below
}

const results = [];
async function quote(tokenIn, tokenOut, amountIn, label) {
  const url = `${API}/api/quote?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const d = await res.json();
    if (d.error) return { label, ok: false, error: d.error };
    return {
      label,
      ok: true,
      out: d.netAmountOut,
      route: d.multiHop?.label ?? d.segments?.map((s) => s.venue).join('+') ?? '?',
      vsOracleBps: d.vsOracleBps ?? null,
    };
  } catch (e) {
    return { label, ok: false, error: e?.message ?? 'fetch failed' };
  }
}

const FIVE_USDC = '50000000'; // $5 at 7 decimals

const jobs = tokens.map((t) => async () => {
  // Direction 1: $5 USDC -> token
  const buy = await quote(usdc.sacAddress, t.sacAddress, FIVE_USDC, `USDC->${t.symbol}`);
  results.push(buy);
  // Direction 2: sell back whatever $5 bought (comparable notional)
  if (buy.ok && BigInt(buy.out) > 0n) {
    results.push(
      await quote(t.sacAddress, usdc.sacAddress, buy.out, `${t.symbol}->USDC`)
    );
  } else {
    results.push({ label: `${t.symbol}->USDC`, ok: false, error: 'skipped (buy leg failed)' });
  }
});

// bounded concurrency
let idx = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < jobs.length) await jobs[idx++]();
  })
);

results.sort((a, b) => a.label.localeCompare(b.label));
let failures = 0;
for (const r of results) {
  if (r.ok) {
    const cost =
      typeof r.vsOracleBps === 'number' ? `${r.vsOracleBps}bps vs oracle` : 'no oracle';
    console.log(`OK    ${r.label.padEnd(18)} via ${r.route.padEnd(30)} ${cost}`);
  } else {
    failures++;
    console.log(`FAIL  ${r.label.padEnd(18)} ${r.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} pairs quoting${failures ? ` — ${failures} FAILURES` : ''}`);
process.exit(failures > 0 ? 1 : 0);

/**
 * Price-impact guard.
 *
 * The engine happily quotes any size — a 10^16 XLM request returns a
 * valid route at ~100% impact. A user who pastes one zero too many
 * should be stopped before signing, not after. Two thresholds:
 *
 *   PRICE_IMPACT_WARN_BPS  — quote carries priceImpactWarning (UI shows a
 *                            banner, trade still allowed)
 *   PRICE_IMPACT_MAX_BPS   — build endpoints refuse (400) and the quote
 *                            carries priceImpactBlocked
 *
 * Impact is execution rate vs the best small-size rate across venues —
 * unit-safe, and it excludes venue fees, so a thin-but-honest pool
 * (Solv pairs trade ~2% under NAV by construction) doesn't trip it.
 * TWAP exists precisely for sizes that would.
 */

export const PRICE_IMPACT_WARN_BPS = parseInt(process.env.PRICE_IMPACT_WARN_BPS ?? '300');
export const PRICE_IMPACT_MAX_BPS = parseInt(process.env.PRICE_IMPACT_MAX_BPS ?? '1500');

export interface ImpactFlags {
  priceImpactBps: number;
  priceImpactWarning: boolean;
  priceImpactBlocked: boolean;
  priceImpactMaxBps: number;
}

/** Normalize an impact figure: NaN/negative/undefined → 0. */
export function normalizeImpact(bps: number | null | undefined): number {
  return Number.isFinite(bps as number) && (bps as number) > 0 ? (bps as number) : 0;
}

/** Sum of per-hop impacts for a multi-hop path (each hop ≥ 0). */
export function sumHopImpact(hops: Array<{ route: { priceImpactBps?: number } }>): number {
  return hops.reduce((s, h) => s + normalizeImpact(h.route.priceImpactBps), 0);
}

export function impactFlags(bps: number | null | undefined): ImpactFlags {
  const impact = normalizeImpact(bps);
  return {
    priceImpactBps: impact,
    priceImpactWarning: impact > PRICE_IMPACT_WARN_BPS,
    priceImpactBlocked: impact > PRICE_IMPACT_MAX_BPS,
    priceImpactMaxBps: PRICE_IMPACT_MAX_BPS,
  };
}

/**
 * Message to refuse a build with, or null when the trade is allowed.
 * Callers wrap it in their own 400 error type.
 */
export function impactViolation(bps: number | null | undefined): string | null {
  const impact = normalizeImpact(bps);
  if (impact <= PRICE_IMPACT_MAX_BPS) return null;
  return (
    `Price impact ${(impact / 100).toFixed(1)}% exceeds the ${(PRICE_IMPACT_MAX_BPS / 100).toFixed(0)}% safety cap — ` +
    `reduce the amount or use a TWAP order. No funds were moved.`
  );
}

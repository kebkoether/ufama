/**
 * Depth-point quote cache — the hybrid quoting layer.
 *
 * The routing engine and pathfinder used to fire one on-chain simulation
 * per (pool, amount) they were curious about: every depth level, every
 * candidate path, every hop, every re-quote. A multi-hop search burned
 * hundreds of RPC round-trips and many seconds of wall clock, almost all
 * of it asking the same pools slightly different numbers.
 *
 * Design: memoize every simulated (amountIn → amountOut) point per
 * (pool, direction). A new amount is answered WITHOUT a simulation only
 * when fresh cached points bracket it tightly (within RATIO on the amount
 * axis); otherwise the exact amount is simulated once and becomes a new
 * point. Consequences:
 *   - never MORE simulations than the uncached behavior — the worst case
 *     is exactly one sim per novel amount, same as before;
 *   - within one pathfinder search, candidate paths share hops (most
 *     routes cross the same XLM/USDC pool at similar chained amounts), so
 *     the second candidate onward quotes from memory;
 *   - across the quote → re-quote → build sequence the UI performs, and
 *     across users, the point set densifies and quoting approaches zero
 *     RPC traffic until the TTL rolls over.
 *
 * Why interpolation is safe to hand to execution paths: every AMM curve
 * is CONCAVE (marginal price only worsens with size), so a chord between
 * two sampled points lies BELOW the true curve — interpolated outputs are
 * conservative lower bounds with only curvature-sized error. Slightly
 * below the smallest point we scale by its average rate (same property)
 * minus a one-unit-rate shave (venue fee flooring can beat real-valued
 * scaling by a stroop at dust sizes). ABOVE the largest point we always
 * simulate: any flat or sloped extension is either non-conservative or so
 * pessimistic it would misrank the venue. We deliberately do NOT
 * reimplement venue formulas — Aqua alone runs constant-product,
 * stableswap AND concentrated pools, and a sampled point is right by
 * construction for all of them.
 *
 * Staleness: TTL defaults to one ledger (~5s). A quote can always be a
 * ledger stale by the time the user signs — exactly the exposure quotes
 * had before this cache — and per-leg min_out enforcement on-chain
 * remains the actual guardrail.
 */

/** Simulate the venue's own quote for one amount (on-chain truth). */
export type PointSampler = (amountIn: bigint) => Promise<bigint>;

export interface CurvePoint {
  amountIn: bigint;
  amountOut: bigint;
  ts: number;
}

const TTL_MS = parseInt(process.env.QUOTE_CURVE_TTL_MS ?? '5000');
const MAX_KEYS = parseInt(process.env.QUOTE_CURVE_MAX ?? '500');
/**
 * Max amount-axis ratio across which we trust a chord (or a one-sided
 * flank). 1.6 keeps curvature error negligible for real pools while
 * still letting the engine's ladder levels bracket the pathfinder's
 * chained hop amounts.
 */
const RATIO_NUM = 16n;
const RATIO_DEN = 10n;

export class QuoteCurveCache {
  /** key → points sorted ascending by amountIn (fresh ones only used) */
  private points = new Map<string, CurvePoint[]>();
  private inFlight = new Map<string, Promise<bigint>>();

  constructor(private ttlMs: number = TTL_MS) {}

  /**
   * Quote `amountIn` for `key`: from cached points when they bound it
   * tightly, otherwise via one exact `sampler` simulation (memoized).
   * Returns 0n when the venue itself answers 0.
   */
  async quote(
    key: string,
    amountIn: bigint,
    sampler: PointSampler
  ): Promise<bigint> {
    if (amountIn <= 0n) return 0n;

    const fresh = this.freshPoints(key);
    const interpolated = QuoteCurveCache.readOff(fresh, amountIn);
    if (interpolated !== null) return interpolated;

    // Novel territory — simulate this exact amount (single-flight per
    // key+amount so concurrent candidate verification doesn't stampede).
    const flightKey = `${key}|${amountIn}`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;

    const p = (async () => {
      try {
        let failed = false;
        const out = await sampler(amountIn).catch(() => {
          failed = true;
          return 0n;
        });
        // A FAILED simulation means "don't know", not "zero". Caching it
        // as a point poisoned quotes and route selection for a whole TTL
        // whenever the RPC hiccuped (observed in production as transient
        // 20x-low quotes and failed builds right after deploy). Genuine
        // zeros — the venue itself answered 0 — still memoize.
        if (!failed) {
          this.insert(key, { amountIn, amountOut: out, ts: Date.now() });
        }
        return out;
      } finally {
        this.inFlight.delete(flightKey);
      }
    })();
    this.inFlight.set(flightKey, p);
    return p;
  }

  /**
   * Answer from cached points alone, or null if they don't bound
   * `amountIn` tightly enough. Exposed static for tests.
   */
  static readOff(points: CurvePoint[], amountIn: bigint): bigint | null {
    if (points.length === 0 || amountIn <= 0n) return null;

    // Exact hit
    for (const pt of points) {
      if (pt.amountIn === amountIn) return pt.amountOut;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const withinRatio = (a: bigint, b: bigint) =>
      a <= (b * RATIO_NUM) / RATIO_DEN && b <= (a * RATIO_NUM) / RATIO_DEN;

    // Slightly below the smallest point: average-rate scaling minus one
    // unit-rate (integer fee flooring guard).
    if (amountIn < first.amountIn) {
      if (!withinRatio(amountIn, first.amountIn)) return null;
      if (first.amountOut === 0n) return 0n;
      const scaled = (amountIn * first.amountOut) / first.amountIn;
      const unitRate = (first.amountOut + first.amountIn - 1n) / first.amountIn;
      return scaled > unitRate ? scaled - unitRate : 0n;
    }

    // Above the largest point: always simulate. A sloped extension can
    // OVER-estimate (a chord's slope exceeds the marginal rate past its
    // right endpoint on a concave curve) and a flat clamp under-estimates
    // so hard it would misrank the venue — neither is a quote.
    if (amountIn > last.amountIn) return null;

    // Bracketed: chord, but only across a tight bracket.
    for (let i = 1; i < points.length; i++) {
      const lo = points[i - 1];
      const hi = points[i];
      if (amountIn > lo.amountIn && amountIn < hi.amountIn) {
        if (!withinRatio(lo.amountIn, hi.amountIn)) return null;
        // A zero endpoint means the venue failed/emptied at that size —
        // no chord through it.
        if (lo.amountOut === 0n || hi.amountOut === 0n) return null;
        const span = hi.amountIn - lo.amountIn;
        const rise = hi.amountOut - lo.amountOut;
        if (rise < 0n) return null; // inconsistent samples — resimulate
        return lo.amountOut + ((amountIn - lo.amountIn) * rise) / span;
      }
    }
    return null;
  }

  private freshPoints(key: string): CurvePoint[] {
    const all = this.points.get(key);
    if (!all) return [];
    const cutoff = Date.now() - this.ttlMs;
    const fresh = all.filter((p) => p.ts >= cutoff);
    if (fresh.length !== all.length) {
      if (fresh.length === 0) this.points.delete(key);
      else this.points.set(key, fresh);
    }
    return fresh;
  }

  private insert(key: string, point: CurvePoint): void {
    const list = this.points.get(key) ?? [];
    // Replace any stale/duplicate point at the same amount.
    const kept = list.filter((p) => p.amountIn !== point.amountIn);
    kept.push(point);
    kept.sort((a, b) => (a.amountIn < b.amountIn ? -1 : a.amountIn > b.amountIn ? 1 : 0));
    this.points.set(key, kept);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.points.size <= MAX_KEYS) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.points) {
      if (v.every((p) => p.ts < cutoff)) this.points.delete(k);
      if (this.points.size <= MAX_KEYS) return;
    }
    for (const k of this.points.keys()) {
      this.points.delete(k);
      if (this.points.size <= MAX_KEYS) return;
    }
  }

  /** Test/ops introspection. */
  stats() {
    let pts = 0;
    for (const v of this.points.values()) pts += v.length;
    return { keys: this.points.size, points: pts, inFlight: this.inFlight.size };
  }
}

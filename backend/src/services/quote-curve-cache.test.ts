import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuoteCurveCache, CurvePoint } from './quote-curve-cache.js';

/**
 * A real constant-product venue for ground truth: out = R_out·x' / (R_in + x')
 * with a 0.1% input fee. Concave in x, like every AMM curve — the cache's
 * conservativeness claims are tested against it.
 */
const R_IN = 46_801_674_304_847n;
const R_OUT = 4_823_118_624_272n;
function cpmmTruth(amountIn: bigint): bigint {
  const afterFee = (amountIn * 9990n) / 10000n;
  return (R_OUT * afterFee) / (R_IN + afterFee);
}

function pt(amountIn: bigint, ts = Date.now()): CurvePoint {
  return { amountIn, amountOut: cpmmTruth(amountIn), ts };
}

describe('readOff (interpolation rules)', () => {
  const points = [
    pt(100_0000000n),
    pt(150_0000000n),
    pt(1_000_0000000n),
    pt(1_500_0000000n),
  ];

  it('returns exact hits verbatim', () => {
    for (const p of points) {
      expect(QuoteCurveCache.readOff(points, p.amountIn)).toBe(p.amountOut);
    }
  });

  it('interpolates only across tight brackets, else asks for a sim', () => {
    // 120 sits between 100 and 150 (ratio 1.5 ≤ 1.6) → chord
    expect(QuoteCurveCache.readOff(points, 120_0000000n)).not.toBeNull();
    // 500 sits between 150 and 1000 (ratio 6.7 > 1.6) → null (simulate)
    expect(QuoteCurveCache.readOff(points, 500_0000000n)).toBeNull();
  });

  it('never over-quotes the true concave curve where it answers', () => {
    const probes = [
      70_0000000n, 99_9999999n, 110_0000000n, 120_0000000n, 149_9999999n,
      1_100_0000000n, 1_250_0000000n, 1_499_9999999n, 1_600_0000000n,
      2_000_0000000n,
    ];
    for (const x of probes) {
      const est = QuoteCurveCache.readOff(points, x);
      if (est === null) continue;
      const truth = cpmmTruth(x);
      expect(est <= truth, `over-quoted at ${x}: ${est} > ${truth}`).toBe(true);
      expect(est >= 0n).toBe(true);
    }
  });

  it('stays close to truth inside a bracket (chord error, not a haircut)', () => {
    const x = 125_0000000n;
    const est = QuoteCurveCache.readOff(points, x)!;
    const truth = cpmmTruth(x);
    const errBps = Number(((truth - est) * 10000n) / truth);
    expect(errBps).toBeLessThan(5);
  });

  it('below the smallest point: average rate minus a unit-rate shave', () => {
    // Dust guard: at tiny sizes venue fee flooring can undercut real-
    // valued scaling — the shave keeps us a lower bound (10 stroops
    // against this pool floors to 0 output).
    const single = [pt(100_0000000n)];
    const dust = QuoteCurveCache.readOff(single, 10n)!;
    expect(dust <= cpmmTruth(10n)).toBe(true);
    // ...but not a haircut at meaningful sizes just below the point:
    const near = QuoteCurveCache.readOff(single, 80_0000000n)!;
    const truth = cpmmTruth(80_0000000n);
    expect(near <= truth).toBe(true);
    expect(truth - near <= truth / 1000n + 2n).toBe(true);
  });

  it('above the largest point: always null (simulate — no extrapolation)', () => {
    const last = points[points.length - 1];
    expect(QuoteCurveCache.readOff(points, (last.amountIn * 11n) / 10n)).toBeNull();
    expect(QuoteCurveCache.readOff(points, last.amountIn * 3n)).toBeNull();
  });

  it('refuses chords through zero or inconsistent endpoints', () => {
    const withZero = [pt(100_0000000n), { amountIn: 150_0000000n, amountOut: 0n, ts: Date.now() }];
    expect(QuoteCurveCache.readOff(withZero, 120_0000000n)).toBeNull();
    const shrinking = [
      pt(100_0000000n),
      { amountIn: 150_0000000n, amountOut: pt(100_0000000n).amountOut - 5n, ts: Date.now() },
    ];
    expect(QuoteCurveCache.readOff(shrinking, 120_0000000n)).toBeNull();
  });

  it('returns null for empty points and non-positive amounts', () => {
    expect(QuoteCurveCache.readOff([], 100n)).toBeNull();
    expect(QuoteCurveCache.readOff(points, 0n)).toBeNull();
    expect(QuoteCurveCache.readOff(points, -5n)).toBeNull();
  });
});

describe('QuoteCurveCache memoization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('simulates a novel amount once, then serves nearby amounts free', async () => {
    const cache = new QuoteCurveCache(5_000);
    const sampler = vi.fn(async (amt: bigint) => cpmmTruth(amt));

    const a = await cache.quote('k', 1_000_0000000n, sampler);
    expect(a).toBe(cpmmTruth(1_000_0000000n));
    expect(sampler).toHaveBeenCalledTimes(1);

    // Same amount again: memoized exact point.
    await cache.quote('k', 1_000_0000000n, sampler);
    expect(sampler).toHaveBeenCalledTimes(1);

    // Larger amount: above every point → simulated exactly (quote
    // quality beats cache hits), and now a bracket exists.
    const bigger = await cache.quote('k', 1_500_0000000n, sampler);
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(bigger).toBe(cpmmTruth(1_500_0000000n));

    // In between the two points (ratio 1.5 ≤ 1.6): chord — no sim.
    const mid = await cache.quote('k', 1_200_0000000n, sampler);
    expect(sampler).toHaveBeenCalledTimes(2);
    expect(mid > 0n && mid <= cpmmTruth(1_200_0000000n)).toBe(true);
  });

  it('never simulates more than the uncached path (one sim per novel amount)', async () => {
    const cache = new QuoteCurveCache(5_000);
    const sampler = vi.fn(async (amt: bigint) => cpmmTruth(amt));
    const amounts = [100_0000000n, 1_000_0000000n, 10_000_0000000n];
    for (const amt of amounts) await cache.quote('k', amt, sampler);
    expect(sampler.mock.calls.length).toBeLessThanOrEqual(amounts.length);
  });

  it('single-flights concurrent quotes for the same key+amount', async () => {
    const cache = new QuoteCurveCache(5_000);
    const sampler = vi.fn(async (amt: bigint) => cpmmTruth(amt));
    await Promise.all([
      cache.quote('k', 1_000_0000000n, sampler),
      cache.quote('k', 1_000_0000000n, sampler),
      cache.quote('k', 1_000_0000000n, sampler),
    ]);
    expect(sampler).toHaveBeenCalledTimes(1);
  });

  it('re-simulates after the TTL expires', async () => {
    const cache = new QuoteCurveCache(5_000);
    const sampler = vi.fn(async (amt: bigint) => cpmmTruth(amt));
    await cache.quote('k', 1_000_0000000n, sampler);
    vi.advanceTimersByTime(6_000);
    await cache.quote('k', 1_000_0000000n, sampler);
    expect(sampler).toHaveBeenCalledTimes(2);
  });

  it('memoizes zero answers (dead pool is not re-probed within TTL)', async () => {
    const cache = new QuoteCurveCache(5_000);
    const sampler = vi.fn(async () => 0n);
    expect(await cache.quote('dead', 1_000_0000000n, sampler)).toBe(0n);
    expect(await cache.quote('dead', 1_000_0000000n, sampler)).toBe(0n);
    expect(sampler).toHaveBeenCalledTimes(1);
  });

  it('keys are independent (different pools never share points)', async () => {
    const cache = new QuoteCurveCache(5_000);
    const sampler = vi.fn(async (amt: bigint) => cpmmTruth(amt));
    await cache.quote('pool-a', 1_000_0000000n, sampler);
    await cache.quote('pool-b', 1_000_0000000n, sampler);
    expect(sampler).toHaveBeenCalledTimes(2);
  });
});

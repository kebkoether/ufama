/**
 * Routing-engine unit tests with synthetic venues — no RPC, no network.
 * Each fake venue is a deterministic output curve so the allocator's
 * behaviour (ordering, splitting, conservation, failure handling) can be
 * asserted exactly.
 */
import { describe, it, expect } from 'vitest';
import { RoutingEngine } from './engine.js';
import { VenueRegistry } from '../venues/index.js';
import type { VenueAdapter, Quote, DepthQuote, SwapInstruction } from '../venues/adapter.js';

const A = 'CAAAA_TOKEN_IN';
const B = 'CBBBB_TOKEN_OUT';
const ONE = 10_000_000n; // 1.0 at 7 decimals

/** out(amount) curve → adapter. `curve` returns 0n to simulate a failed sim. */
function fakeVenue(
  name: string,
  venueId: number,
  curve: (amountIn: bigint) => bigint,
  opts: { executable?: boolean; available?: boolean } = {}
): VenueAdapter {
  return {
    name,
    venueId,
    executable: opts.executable ?? true,
    async isAvailable() {
      return opts.available ?? true;
    },
    async getQuote(tokenIn, tokenOut, amountIn): Promise<Quote> {
      const amountOut = curve(amountIn);
      return {
        venue: name,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        effectiveBps:
          amountOut > 0n ? Number(((amountIn - amountOut) * 10000n) / amountIn) : 9999,
        gasCost: 0n,
      };
    },
    async getDepthQuotes(_i, _o, amounts): Promise<DepthQuote[]> {
      return amounts.map((amountIn) => {
        const amountOut = curve(amountIn);
        return {
          amountIn,
          amountOut,
          marginalBps:
            amountOut > 0n ? Number(((amountIn - amountOut) * 10000n) / amountIn) : Infinity,
        };
      });
    },
    async buildSwapInstruction(_i, _o, amountIn, minAmountOut): Promise<SwapInstruction> {
      return { venueContractId: 'C_' + name, venueId, amountIn, minAmountOut };
    },
  };
}

/** Constant-product pool: reserves rIn/rOut, fee in bps. */
function cpmm(rIn: bigint, rOut: bigint, feeBps = 30n) {
  return (x: bigint): bigint => {
    const xf = (x * (10_000n - feeBps)) / 10_000n;
    return (rOut * xf) / (rIn + xf);
  };
}

function engineWith(...venues: VenueAdapter[]) {
  const reg = new VenueRegistry();
  for (const v of venues) reg.register(v);
  return new RoutingEngine(reg);
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('RoutingEngine.computeRoute', () => {
  it('single venue: allocation conserves input and reports its output', async () => {
    const deep = cpmm(1_000_000n * ONE, 1_000_000n * ONE);
    const eng = engineWith(fakeVenue('Deep', 1, deep));
    const amount = 5_000n * ONE;
    const route = await eng.computeRoute(A, B, amount, 50);
    expect(route.segments).toHaveLength(1);
    expect(sum(route.segments.map((s) => s.amountIn))).toBe(amount);
    // ladder interpolation may shave a hair; never over-promises vs the pool
    expect(route.totalExpectedOut).toBeLessThanOrEqual(deep(amount));
    expect(route.totalExpectedOut).toBeGreaterThan((deep(amount) * 99n) / 100n);
    expect(route.instructions[0].minAmountOut).toBe(
      (route.segments[0].expectedAmountOut * 9950n) / 10000n
    );
  });

  it('segments always sum EXACTLY to amountIn (contract invariant)', async () => {
    const eng = engineWith(
      fakeVenue('X', 1, cpmm(300_000n * ONE, 300_000n * ONE)),
      fakeVenue('Y', 2, cpmm(120_000n * ONE, 119_000n * ONE))
    );
    for (const amount of [777n, 123_456_789n, 40_000n * ONE + 3n]) {
      const route = await eng.computeRoute(A, B, amount, 50);
      expect(sum(route.segments.map((s) => s.amountIn))).toBe(amount);
      expect(sum(route.instructions.map((i) => i.amountIn))).toBe(amount);
    }
  });

  it('prefers the cheaper venue and splits once its marginal price worsens', async () => {
    // Thin but tight pool vs deep but wider-fee pool.
    const thinTight = cpmm(50_000n * ONE, 50_000n * ONE, 5n);
    const deepWide = cpmm(5_000_000n * ONE, 5_000_000n * ONE, 60n);
    const eng = engineWith(fakeVenue('Thin', 1, thinTight), fakeVenue('Deep', 2, deepWide));

    const small = await eng.computeRoute(A, B, 100n * ONE, 50);
    expect(small.segments.map((s) => s.venueName)).toEqual(['Thin']);

    const big = await eng.computeRoute(A, B, 100_000n * ONE, 50);
    const names = big.segments.map((s) => s.venueName).sort();
    expect(names).toEqual(['Deep', 'Thin']);
    // The split must beat either venue alone.
    expect(big.totalExpectedOut).toBeGreaterThan(thinTight(100_000n * ONE));
    expect(big.totalExpectedOut).toBeGreaterThan(deepWide(100_000n * ONE));
  });

  it('dust that no venue can turn into output yields an empty route, not a zero-output segment', async () => {
    const eng = engineWith(fakeVenue('Pool', 1, cpmm(1_000_000n * ONE, 1_000_000n * ONE)));
    const route = await eng.computeRoute(A, B, 1n, 50);
    expect(route.segments).toHaveLength(0);
    expect(route.totalExpectedOut).toBe(0n);
  });

  it('drops a venue whose quotes are all zero instead of routing through it', async () => {
    const eng = engineWith(
      fakeVenue('Dead', 1, () => 0n),
      fakeVenue('Live', 2, cpmm(1_000_000n * ONE, 1_000_000n * ONE))
    );
    const route = await eng.computeRoute(A, B, 1_000n * ONE, 50);
    expect(route.segments.map((s) => s.venueName)).toEqual(['Live']);
  });

  it('throws when no venue is available', async () => {
    const eng = engineWith(fakeVenue('Off', 1, cpmm(ONE, ONE), { available: false }));
    await expect(eng.computeRoute(A, B, ONE, 50)).rejects.toThrow(/No venues available/);
  });

  it('executableOnly excludes non-executable venues unless classic DEX is explicitly included', async () => {
    const eng = engineWith(
      fakeVenue('SwapBook', 0, cpmm(1_000_000n * ONE, 1_000_000n * ONE, 0n), { executable: false }),
      fakeVenue('StellarDEX', 3, cpmm(1_000_000n * ONE, 1_000_000n * ONE, 0n), { executable: false }),
      fakeVenue('Aqua', 1, cpmm(1_000_000n * ONE, 990_000n * ONE))
    );
    const onlyExec = await eng.computeRoute(A, B, 1_000n * ONE, 50, { executableOnly: true });
    expect(onlyExec.segments.map((s) => s.venueName)).toEqual(['Aqua']);

    const withClassic = await eng.computeRoute(A, B, 1_000n * ONE, 50, {
      executableOnly: true,
      includeClassicDex: true,
    });
    expect(withClassic.segments.map((s) => s.venueName)).toContain('StellarDEX');
    expect(withClassic.segments.map((s) => s.venueName)).not.toContain('SwapBook');
  });

  it('a failed middle depth level never becomes a phantom better-than-spot tranche', async () => {
    // Pool answers normally except at exactly the $1,000 ladder level,
    // where the simulation "fails" (0). The regression this guards: the
    // next level's marginal was diffed against 0, attributing the whole
    // cumulative output to one slice → fake arbitrage.
    const honest = cpmm(1_000_000n * ONE, 1_000_000n * ONE);
    const flaky = (x: bigint) => (x === 1_000n * ONE ? 0n : honest(x));
    const eng = engineWith(fakeVenue('Flaky', 1, flaky));
    const route = await eng.computeRoute(A, B, 5_000n * ONE, 50);
    expect(route.totalExpectedOut).toBeLessThanOrEqual(honest(5_000n * ONE));
    expect(route.priceImpactBps).toBeGreaterThanOrEqual(0);
  });

  it('price impact grows with size and is zero-floored', async () => {
    const eng = engineWith(fakeVenue('Pool', 1, cpmm(100_000n * ONE, 100_000n * ONE)));
    const s = await eng.computeRoute(A, B, 10n * ONE, 50);
    const m = await eng.computeRoute(A, B, 1_000n * ONE, 50);
    const l = await eng.computeRoute(A, B, 50_000n * ONE, 50);
    expect(s.priceImpactBps).toBeGreaterThanOrEqual(0);
    expect(m.priceImpactBps).toBeGreaterThan(s.priceImpactBps);
    expect(l.priceImpactBps).toBeGreaterThan(m.priceImpactBps);
    // 50k into a 100k pool is a brutal trade — must read as thousands of bps
    expect(l.priceImpactBps).toBeGreaterThan(2000);
  });

  it('mixed-decimal pairs: ladder is rescaled and bps fields stay unit-safe', async () => {
    // 18-dec token in, 7-dec token out, 1:1 value. Output = in / 1e11.
    const scale = 10n ** 11n;
    const curve = (x: bigint) => ((x * 9990n) / 10000n) / scale;
    const eng = engineWith(fakeVenue('Sushi', 2, curve));
    const amount = 10n ** 18n; // 1.0 token
    const route = await eng.computeRoute(A, B, amount, 50, {}, { in: 18, out: 7 });
    expect(route.totalExpectedOut).toBeGreaterThan(0n);
    expect(route.totalExpectedOut).toBeLessThanOrEqual(curve(amount));
    // blended cost ≈ 10 bps fee, not ~10^11 "bps"
    expect(route.blendedBps).toBeGreaterThanOrEqual(0);
    expect(route.blendedBps).toBeLessThan(100);
  });
});

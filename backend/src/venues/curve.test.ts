/**
 * Curve venue adapter — unit tests with a fake RPC client. Verifies pool
 * ranking (min-side depth, same rule as the on-chain adapter), index
 * direction passed to get_dy, the cache-key direction, and the adapter
 * contract fallback.
 */
import { describe, it, expect } from 'vitest';
import { scValToNative, xdr, StrKey } from '@stellar/stellar-sdk';
import { CurveAdapter, DiscoveredCurvePool } from './curve.js';
import { QuoteCurveCache } from '../services/quote-curve-cache.js';

// Real strkey contract ids: the adapter-contract fallback encodes token
// addresses as ScVals, which rejects made-up strings.
const cid = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const A = cid(1);
const B = cid(2);
const C = cid(3);
const ADAPTER = cid(9);

interface Call {
  contract: string;
  method: string;
  args: unknown[];
}

/** Fake StellarClient: get_dy pays a flat rate per pool; records calls. */
function fakeStellar(rates: Record<string, bigint>, adapterRate: bigint | null = null) {
  const calls: Call[] = [];
  return {
    calls,
    async simulateAndParse<T>(contract: string, method: string, args: xdr.ScVal[]): Promise<T | null> {
      const native = args.map((a) => scValToNative(a));
      calls.push({ contract, method, args: native });
      if (method === 'get_dy') {
        const rate = rates[contract];
        if (rate === undefined) return null;
        const dx = BigInt(native[2] as bigint);
        return ((dx * rate) / 10_000n) as unknown as T;
      }
      if (method === 'quote') {
        if (adapterRate === null) return null;
        const amt = BigInt(native[2] as bigint);
        return ((amt * adapterRate) / 10_000n) as unknown as T;
      }
      return null;
    },
  };
}

const pool = (
  poolAddress: string,
  coins: string[],
  balances: bigint[]
): DiscoveredCurvePool => ({
  poolAddress,
  coins,
  decimals: coins.map(() => 7),
  balances: balances.map((b) => b.toString()),
});

describe('CurveAdapter', () => {
  it('ranks pools by the shallower side, not the fat side', () => {
    const skewed = pool('P_SKEWED', [A, B], [1n, 10_000_000_000n]);
    const honest = pool('P_HONEST', [A, B], [1_000_000n, 1_000_000n]);
    const ranked = CurveAdapter.rankPools([skewed, honest], A, B);
    expect(ranked.map((p) => p.poolAddress)).toEqual(['P_HONEST', 'P_SKEWED']);
    // pools missing one side are dropped
    expect(CurveAdapter.rankPools([pool('P_AC', [A, C], [5n, 5n])], A, B)).toEqual([]);
  });

  it('quotes via get_dy with the pool-order indexes for the direction asked', async () => {
    const stellar = fakeStellar({ P3: 9_990n });
    const three = pool('P3', [C, A, B], [100n, 100n, 100n]);
    const venue = new CurveAdapter(ADAPTER, stellar as any, () => [three]);

    const q = await venue.getQuote(B, A, 1_000n);
    expect(q.amountOut).toBe(999n);
    const call = stellar.calls.find((c) => c.method === 'get_dy')!;
    expect(call.contract).toBe('P3');
    expect(call.args.slice(0, 2)).toEqual([2, 1]); // B is index 2, A is index 1
    expect(q.venue).toBe('Curve');
    expect(q.effectiveBps).toBe(10); // (1000-999)/1000 in bps
  });

  it('falls back to the adapter contract when discovery has no pool', async () => {
    const stellar = fakeStellar({}, 9_900n);
    const venue = new CurveAdapter(ADAPTER, stellar as any, () => []);
    const q = await venue.getQuote(A, B, 10_000n);
    expect(q.amountOut).toBe(9_900n);
    expect(stellar.calls.map((c) => c.method)).toEqual(['quote']);
  });

  it('returns zero (not an exception) when nothing can quote the pair', async () => {
    const stellar = fakeStellar({}, null);
    const venue = new CurveAdapter(ADAPTER, stellar as any, () => []);
    const q = await venue.getQuote(A, B, 10_000n);
    expect(q.amountOut).toBe(0n);
    expect(q.effectiveBps).toBe(9999);
  });

  it('uses the shared depth cache keyed per pool AND direction', async () => {
    const stellar = fakeStellar({ P2: 9_990n });
    const two = pool('P2', [A, B], [100n, 100n]);
    const venue = new CurveAdapter(ADAPTER, stellar as any, () => [two], new QuoteCurveCache());

    const d = await venue.getDepthQuotes(A, B, [1_000n, 1_000n, 1_000n]);
    expect(d.map((x) => x.amountOut)).toEqual([999n, 999n, 999n]);
    // identical amounts hit the cache: one simulation, not three
    expect(stellar.calls.filter((c) => c.method === 'get_dy')).toHaveLength(1);

    // the reverse direction is a different curve — simulates again
    await venue.getQuote(B, A, 1_000n);
    const dirs = stellar.calls.filter((c) => c.method === 'get_dy').map((c) => c.args.slice(0, 2));
    expect(dirs).toEqual([[0, 1], [1, 0]]);
  });

  it('builds a Router instruction pointing at the adapter contract (venue 4)', async () => {
    const venue = new CurveAdapter(ADAPTER, fakeStellar({}) as any, () => []);
    const ins = await venue.buildSwapInstruction(A, B, 500n, 490n);
    expect(ins).toEqual({ venueContractId: ADAPTER, venueId: 4, amountIn: 500n, minAmountOut: 490n });
    expect(venue.executable).toBe(true);
  });
});

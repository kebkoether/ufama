/**
 * SushiSwap V3 (Stellar) venue adapter.
 *
 * Execution: our on-chain adapter contract calls Sushi POOLS directly
 * (pool.swap + invoker auth) — mainnet-verified 2026-08-18.
 *
 * Quotes: Sushi's quoter contract rejects third-party quote calls
 * (#1003), so we quote from pool state instead: slot0's sqrt price gives
 * the spot rate; we apply the pool fee and treat depth conservatively.
 * The contract enforces min_amount_out at execution, so a spot-based
 * estimate with slippage margin is safe for routing.
 *
 * Pairs come from TWO sources, merged:
 *   1. Dynamic discovery (TokenDiscoveryService's Sushi pool sweep) —
 *      refreshed continuously, covers every pool Sushi itself lists.
 *   2. SUSHI_PAIRS env (JSON) as a static override/fallback:
 *      [{"tokenA":"<SAC>","tokenB":"<SAC>","pool":"<C...>","fee":3000}]
 * Env entries win on conflict (lets ops pin a specific pool).
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

const Q96 = 2n ** 96n;
const FEE_DENOM = 1_000_000n; // V3 fee units (3000 = 0.3%)

interface SushiPair {
  tokenA: string;
  tokenB: string;
  pool: string;
  fee: number;
  /** Token decimals (default 7) — sizes the depth haircut correctly for
   *  18-decimal Soroban tokens like deJTRSY/deJAAA. */
  decimalsA?: number;
  decimalsB?: number;
}

/** Live pair source (the discovery service), checked before env pairs. */
export type SushiPairsProvider = () => SushiPair[];

export class SushiSwapAdapter implements VenueAdapter {
  readonly name = 'SushiSwap';
  readonly venueId = 2;
  readonly executable = true; // mainnet-verified via direct pool.swap
  private stellar: StellarClient;
  private envPairs: SushiPair[] = [];
  private pairsProvider: SushiPairsProvider | null;
  private token0Cache = new Map<string, string>(); // pool -> token0
  /** slot0 (sqrt price) cache: quoting a depth ladder used to re-simulate
   *  slot0 once PER LEVEL, sequentially — one pool state answers them all
   *  for a ledger. Single-flight so concurrent path verification doesn't
   *  stampede the RPC. */
  private slot0Cache = new Map<string, { v: any; ts: number }>();
  private slot0InFlight = new Map<string, Promise<any | null>>();
  private static readonly SLOT0_TTL_MS = parseInt(
    process.env.QUOTE_CURVE_TTL_MS ?? '5000'
  );

  constructor(
    private adapterContractId: string,
    stellar: StellarClient,
    pairsJson?: string,
    pairsProvider?: SushiPairsProvider
  ) {
    this.stellar = stellar;
    this.pairsProvider = pairsProvider ?? null;
    try {
      if (pairsJson) this.envPairs = JSON.parse(pairsJson);
    } catch {
      console.warn('[Sushi] SUSHI_PAIRS env is not valid JSON — ignored');
    }
  }

  private allPairs(): SushiPair[] {
    const dynamic = this.pairsProvider ? this.pairsProvider() : [];
    // Env pairs win on conflict (ops override), so they go last in the
    // merged map keyed by the unordered pair.
    const merged = new Map<string, SushiPair>();
    for (const p of [...dynamic, ...this.envPairs]) {
      merged.set([p.tokenA, p.tokenB].sort().join('|'), p);
    }
    return Array.from(merged.values());
  }

  async isAvailable(): Promise<boolean> {
    return this.allPairs().length > 0;
  }

  private findPair(tokenIn: string, tokenOut: string): SushiPair | undefined {
    return this.allPairs().find(
      (p) =>
        (p.tokenA === tokenIn && p.tokenB === tokenOut) ||
        (p.tokenA === tokenOut && p.tokenB === tokenIn)
    );
  }

  /** Decimals of a given token within a pair (default 7). */
  private static decimalsFor(pair: SushiPair, token: string): number {
    if (token === pair.tokenA) return pair.decimalsA ?? 7;
    if (token === pair.tokenB) return pair.decimalsB ?? 7;
    return 7;
  }

  private async token0(pool: string): Promise<string | null> {
    const cached = this.token0Cache.get(pool);
    if (cached) return cached;
    const t0 = await this.stellar.simulateAndParse<string>(pool, 'token0', []);
    if (t0) this.token0Cache.set(pool, String(t0));
    return t0 ? String(t0) : null;
  }

  private async slot0(pool: string): Promise<any | null> {
    const hit = this.slot0Cache.get(pool);
    if (hit && Date.now() - hit.ts < SushiSwapAdapter.SLOT0_TTL_MS) return hit.v;
    const pending = this.slot0InFlight.get(pool);
    if (pending) return pending;
    const p = (async () => {
      try {
        const v = await this.stellar.simulateAndParse<any>(pool, 'slot0', []);
        if (v) this.slot0Cache.set(pool, { v, ts: Date.now() });
        return v ?? null;
      } finally {
        this.slot0InFlight.delete(pool);
      }
    })();
    this.slot0InFlight.set(pool, p);
    return p;
  }

  /** Spot quote from pool slot0: price = (sqrtP / 2^96)^2, minus pool fee. */
  private async spotQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    const pair = this.findPair(tokenIn, tokenOut);
    if (!pair) return 0n;

    const [slot0, t0] = await Promise.all([
      this.slot0(pair.pool),
      this.token0(pair.pool),
    ]);
    if (!slot0 || !t0) return 0n;
    const sqrtP = BigInt(slot0.sqrt_price_x96 ?? 0);
    if (sqrtP === 0n) return 0n;

    const feeKeep = FEE_DENOM - BigInt(pair.fee);
    // price of token1 in token0 terms = (sqrtP/Q96)^2 in RAW base units
    // (sqrtP already encodes any decimals difference between the tokens)
    if (tokenIn === t0) {
      // token0 -> token1: out = in * sqrtP^2 / Q96^2
      return (amountIn * sqrtP * sqrtP * feeKeep) / (Q96 * Q96 * FEE_DENOM);
    }
    // token1 -> token0: out = in * Q96^2 / sqrtP^2
    return (amountIn * Q96 * Q96 * feeKeep) / (sqrtP * sqrtP * FEE_DENOM);
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
    const amountOut = await this.spotQuote(tokenIn, tokenOut, amountIn);
    const effectiveBps =
      amountIn > 0n && amountOut > 0n
        ? Number(((amountIn - amountOut) * 10000n) / amountIn)
        : 9999;
    return {
      venue: this.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectiveBps,
      gasCost: 300n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    // Spot price doesn't model tick-range depth; charge a soft impact
    // haircut that grows with size so the greedy allocator doesn't dump
    // the whole order here. The contract's min_out guards execution.
    const pair = this.findPair(tokenIn, tokenOut);
    const decIn = pair ? SushiSwapAdapter.decimalsFor(pair, tokenIn) : 7;
    // 1 bp per 10,000 WHOLE input tokens — decimal-aware so 18-decimal
    // tokens aren't annihilated by a base-unit divisor tuned for 7.
    const haircutUnit = 10_000n * 10n ** BigInt(decIn);
    const quotes: DepthQuote[] = [];
    for (const amount of amounts) {
      let amountOut = await this.spotQuote(tokenIn, tokenOut, amount);
      if (amountOut > 0n) {
        const haircutBps = amount / haircutUnit;
        amountOut -= (amountOut * haircutBps) / 10000n;
      }
      const marginalBps =
        amount > 0n && amountOut > 0n
          ? Number(((amount - amountOut) * 10000n) / amount)
          : Infinity;
      quotes.push({ amountIn: amount, amountOut, marginalBps });
    }
    return quotes;
  }

  async buildSwapInstruction(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<SwapInstruction> {
    return {
      venueContractId: this.adapterContractId,
      venueId: this.venueId,
      amountIn,
      minAmountOut,
    };
  }
}

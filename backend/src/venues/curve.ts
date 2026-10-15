/**
 * Curve (StableSwap-NG on Soroban) venue adapter.
 *
 * Quotes by simulating `get_dy(i, j, dx)` DIRECTLY on the pool — the
 * venue's own math, dynamic off-peg fee included — for every pool the
 * discovery sweep found via the Curve factory registry. Falls back to
 * the on-chain adapter contract's `quote` (which resolves the pool
 * through the factory itself) when discovery has nothing for the pair.
 *
 * Execution: the ufama Router pushes token_in to the Curve adapter
 * contract, which pre-authorizes the pool's nested `transfer` pull and
 * calls `exchange` (see contracts/adapters/curve). No per-pair
 * registration needed — the adapter resolves pools from the factory;
 * admin pins remain available for ops overrides.
 *
 * Testnet reference (2026-10-15): 3-pool USDX/USDY/USDZ
 *   pool    CB6PW7DRUI5GO652L7CRUOOPAZ4IBMWKQ7RCM7SGWFFF5YQKV6PIXFXN
 *   factory CANV76QKMKSQ26WZMLGVBGML5BCXKKZN2D2Q7HWFLKAEYZ6WWOJ6MHDS
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';
import { QuoteCurveCache } from '../services/quote-curve-cache.js';

export interface DiscoveredCurvePool {
  poolAddress: string;
  /** Coin addresses in pool index order (get_dy / exchange indexes) */
  coins: string[];
  /** Per-coin decimals, same order */
  decimals: number[];
  /** Per-coin active balances (base units, as strings), same order */
  balances: string[];
  name?: string;
}
export type CurvePoolsProvider = (sacA: string, sacB: string) => DiscoveredCurvePool[];

/** Venue id registered on the Router. 3 is the backend's SDEX marker. */
export const CURVE_VENUE_ID = 4;

export class CurveAdapter implements VenueAdapter {
  readonly name = 'Curve';
  readonly venueId = CURVE_VENUE_ID;
  readonly executable = true;
  private stellar: StellarClient;

  constructor(
    private adapterContractId: string,
    stellar: StellarClient,
    private poolsProvider?: CurvePoolsProvider,
    /** Depth-point cache shared with the other venues (see Aqua adapter). */
    private curveCache?: QuoteCurveCache,
    /** Whether discovery currently knows ANY Curve pool. Unarmed (pre-
     *  launch) the venue reports unavailable, so the engine never spends
     *  simulations on it — one adapter.quote per depth level per pair
     *  would otherwise burn RPC budget answering PoolNotSet. */
    private anyPools?: () => boolean
  ) {
    this.stellar = stellar;
  }

  async isAvailable(): Promise<boolean> {
    return this.anyPools ? this.anyPools() : true;
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote> {
    const amountOut = await this.fetchQuote(tokenIn, tokenOut, amountIn);
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
      gasCost: 250n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const outputs = await Promise.all(
      amounts.map((amount) => this.fetchQuote(tokenIn, tokenOut, amount))
    );
    return amounts.map((amountIn, i) => {
      const amountOut = outputs[i];
      const marginalBps =
        amountIn > 0n && amountOut > 0n
          ? Number(((amountIn - amountOut) * 10000n) / amountIn)
          : Infinity;
      return { amountIn, amountOut, marginalBps };
    });
  }

  async buildSwapInstruction(
    _tokenIn: string,
    _tokenOut: string,
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

  /** Pools for the pair, deepest min-side balance first (same ranking
   *  the adapter contract applies, so quote and execution agree). */
  static rankPools(pools: DiscoveredCurvePool[], tokenIn: string, tokenOut: string) {
    const depth = (p: DiscoveredCurvePool) => {
      const i = p.coins.indexOf(tokenIn);
      const j = p.coins.indexOf(tokenOut);
      if (i < 0 || j < 0) return -1n;
      const bi = BigInt(p.balances[i] ?? '0');
      const bj = BigInt(p.balances[j] ?? '0');
      return bi < bj ? bi : bj;
    };
    return pools
      .filter((p) => depth(p) >= 0n)
      .sort((a, b) => (depth(b) > depth(a) ? 1 : depth(b) < depth(a) ? -1 : 0));
  }

  private async fetchQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
    const pools = CurveAdapter.rankPools(
      this.poolsProvider?.(tokenIn, tokenOut) ?? [],
      tokenIn,
      tokenOut
    ).slice(0, 2);

    for (const pool of pools) {
      const i = pool.coins.indexOf(tokenIn);
      const j = pool.coins.indexOf(tokenOut);
      if (this.curveCache) {
        const out = await this.curveCache.quote(
          `curve|${pool.poolAddress}|${i}>${j}`,
          amountIn,
          (amt) => this.simulateGetDy(pool.poolAddress, i, j, amt)
        );
        if (out > 0n) return out;
        continue;
      }
      const dy = await this.simulateGetDy(pool.poolAddress, i, j, amountIn);
      if (dy > 0n) return dy;
    }

    // Last resort: the adapter contract resolves the pool via the factory
    if (!this.adapterContractId) return 0n;
    const onChain = await this.stellar.simulateAndParse<bigint>(
      this.adapterContractId,
      'quote',
      [
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(amountIn),
      ]
    );
    return onChain ? BigInt(onChain) : 0n;
  }

  /** One get_dy simulation — the pool's own math. */
  private async simulateGetDy(pool: string, i: number, j: number, dx: bigint): Promise<bigint> {
    const dy = await this.stellar.simulateAndParse<bigint>(pool, 'get_dy', [
      StellarClient.toU32(i),
      StellarClient.toU32(j),
      StellarClient.toI128(dx),
    ]);
    return dy ? BigInt(dy) : 0n;
  }
}

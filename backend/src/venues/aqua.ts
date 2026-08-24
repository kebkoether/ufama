/**
 * Aqua AMM venue adapter.
 *
 * Integrates with the Aquarius DEX on Stellar (Soroban-native AMM).
 * Quotes by simulating estimate_swap DIRECTLY on pools from the
 * discovery sweep — works for EVERY discovered pair, no registration.
 * (Aqua's REST estimate endpoint 404s — it never existed; the old
 * REST-first path silently zeroed every non-registered pair.) Falls
 * back to the on-chain adapter's registered pool when discovery has
 * nothing. NOTE: on-chain EXECUTION still requires the pair registered
 * on the adapter contract (scripts/register-aqua-pools.sh).
 *
 * Mainnet Router: CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK
 * Testnet Router: CDGX6Q3ZZIDSX2N3SHBORWUIEG2ZZEBAAMYARAXTT7M5L6IXKNJMT3GB
 * API: https://amm-api.aqua.network/api/external/v1
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { StellarClient } from '../stellar/client.js';

export interface DiscoveredAquaPool {
  poolAddress: string;
  tokenAddresses: string[];
  txCount: number;
  totalVolume: number;
}
export type AquaPoolsProvider = (sacA: string, sacB: string) => DiscoveredAquaPool[];

export class AquaAdapter implements VenueAdapter {
  readonly name = 'Aqua';
  readonly venueId = 1;
  readonly executable = true;
  private stellar: StellarClient;

  constructor(
    private adapterContractId: string,
    private aquaApiUrl: string,
    stellar: StellarClient,
    private poolsProvider?: AquaPoolsProvider
  ) {
    this.stellar = stellar;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.aquaApiUrl}/pools`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      // API down, but we can still try on-chain simulation
      return true;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<Quote> {
    const amountOut = await this.fetchQuote(tokenIn, tokenOut, amountIn);

    const effectiveBps =
      amountIn > 0n && amountOut > 0n
        ? Number(((amountIn - amountOut) * 10000n) / amountIn)
        : Infinity;

    return {
      venue: this.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectiveBps: effectiveBps === Infinity ? 9999 : effectiveBps,
      gasCost: 200n,
    };
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const quotePromises = amounts.map((amount) =>
      this.fetchQuote(tokenIn, tokenOut, amount)
    );
    const outputs = await Promise.all(quotePromises);

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

  /**
   * Fetch a swap quote: simulate estimate_swap on the best discovered
   * pool for the pair (highest lifetime volume first, next pool as
   * fallback), then the adapter's registered pool as a last resort.
   */
  private async fetchQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<bigint> {
    const pools = (this.poolsProvider?.(tokenIn, tokenOut) ?? [])
      .filter((p) => p.tokenAddresses.length >= 2)
      .sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0))
      .slice(0, 2);
    for (const pool of pools) {
      const inIdx = pool.tokenAddresses.indexOf(tokenIn);
      const outIdx = pool.tokenAddresses.indexOf(tokenOut);
      if (inIdx < 0 || outIdx < 0) continue;
      const est = await this.stellar.simulateAndParse<bigint>(
        pool.poolAddress,
        'estimate_swap',
        [
          StellarClient.toU32(inIdx),
          StellarClient.toU32(outIdx),
          StellarClient.toU128(amountIn),
        ]
      );
      if (est && BigInt(est) > 0n) return BigInt(est);
    }

    // Last resort: the adapter contract's registered pool
    const onChainResult = await this.stellar.simulateAndParse<bigint>(
      this.adapterContractId,
      'quote',
      [
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(amountIn),
      ]
    );
    return onChainResult ? BigInt(onChainResult) : 0n;
  }

}

/**
 * Stellar DEX (SDEX) venue adapter.
 *
 * Queries the native Stellar CLOB (central limit order book) via the
 * Horizon API. No Soroban adapter contract is needed — the SDEX is
 * built into the Stellar protocol itself, and trades execute as
 * classic path_payment operations.
 *
 * Uses:
 *   - server.orderbook() for depth/liquidity queries
 *   - server.strictSendPaths() for exact-input path quotes
 *
 * Horizon docs: https://developers.stellar.org/docs/data/horizon
 */

import { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
import { TOKENS } from '../stellar/tokens.js';
import { QuoteCurveCache } from '../services/quote-curve-cache.js';

// Horizon SDK types
import { Horizon, Asset } from '@stellar/stellar-sdk';

export class StellarDexAdapter implements VenueAdapter {
  readonly name = 'StellarDEX';
  readonly venueId = 3; // 0=SwapBook, 1=Aqua, 2=Sushi, 3=SDEX
  // SDEX legs are classic path_payment ops, not Router-executable contracts.
  readonly executable = false;

  private horizon: Horizon.Server;

  constructor(
    horizonUrl: string,
    /** Depth-point cache — one Horizon path query per novel size instead
     *  of one per depth level per hop. Orderbook fills are concave in
     *  size (deeper levels only worsen the marginal price), so the
     *  cache's chord interpolation stays a conservative lower bound. */
    private curveCache?: QuoteCurveCache
  ) {
    this.horizon = new Horizon.Server(horizonUrl);
  }

  /** One strictSendPaths query — Horizon's own best-path answer. */
  private async fetchPathOut(
    assetIn: Asset,
    assetOut: Asset,
    amountIn: bigint
  ): Promise<bigint> {
    const paths = await this.horizon
      .strictSendPaths(assetIn, this.toDisplayAmount(amountIn), [assetOut])
      .call();
    if (!paths.records || paths.records.length === 0) return 0n;
    const best = paths.records.reduce((a, b) =>
      parseFloat(a.destination_amount) > parseFloat(b.destination_amount) ? a : b
    );
    return this.fromDisplayAmount(best.destination_amount);
  }

  private async quoteOut(
    tokenIn: string,
    tokenOut: string,
    assetIn: Asset,
    assetOut: Asset,
    amountIn: bigint
  ): Promise<bigint> {
    if (this.curveCache) {
      return this.curveCache.quote(
        `sdex|${tokenIn}|${tokenOut}`,
        amountIn,
        (amt) => this.fetchPathOut(assetIn, assetOut, amt)
      );
    }
    return this.fetchPathOut(assetIn, assetOut, amountIn).catch(() => 0n);
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Quick health check — fetch the root endpoint
      await this.horizon.ledgers().order('desc').limit(1).call();
      return true;
    } catch {
      return false;
    }
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<Quote> {
    const assetIn = this.resolveAsset(tokenIn);
    const assetOut = this.resolveAsset(tokenOut);

    if (!assetIn || !assetOut) {
      return this.emptyQuote(tokenIn, tokenOut, amountIn);
    }

    try {
      const amountOut = await this.quoteOut(tokenIn, tokenOut, assetIn, assetOut, amountIn);
      if (amountOut <= 0n) {
        return this.emptyQuote(tokenIn, tokenOut, amountIn);
      }
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
        gasCost: 100n, // Classic ops are cheap
      };
    } catch (error) {
      console.warn('StellarDEX quote error:', error);
      return this.emptyQuote(tokenIn, tokenOut, amountIn);
    }
  }

  async getDepthQuotes(
    tokenIn: string,
    tokenOut: string,
    amounts: bigint[]
  ): Promise<DepthQuote[]> {
    const assetIn = this.resolveAsset(tokenIn);
    const assetOut = this.resolveAsset(tokenOut);

    if (!assetIn || !assetOut) {
      return amounts.map((a) => ({ amountIn: a, amountOut: 0n, marginalBps: Infinity }));
    }

    // Query paths for each depth level (point-cached: only novel sizes
    // reach Horizon; the rest interpolate).
    const quotes: DepthQuote[] = [];
    let prevAmountOut = 0n;

    for (const amount of amounts) {
      try {
        const amountOut = await this.quoteOut(tokenIn, tokenOut, assetIn, assetOut, amount);
        if (amountOut <= 0n) {
          quotes.push({ amountIn: amount, amountOut: prevAmountOut, marginalBps: Infinity });
          continue;
        }
        const marginalOut = amountOut - prevAmountOut;
        const marginalIn = quotes.length > 0 ? amount - amounts[quotes.length - 1] : amount;

        const marginalBps =
          marginalIn > 0n && marginalOut > 0n
            ? Number(((marginalIn - marginalOut) * 10000n) / marginalIn)
            : Infinity;

        quotes.push({ amountIn: amount, amountOut, marginalBps });
        prevAmountOut = amountOut;
      } catch {
        quotes.push({ amountIn: amount, amountOut: prevAmountOut, marginalBps: Infinity });
      }
    }

    return quotes;
  }

  async buildSwapInstruction(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<SwapInstruction> {
    // SDEX swaps use classic path_payment_strict_send operations.
    // The Router contract doesn't invoke these — the frontend builds
    // a separate classic operation and bundles it into the same tx.
    // We return a marker instruction so the router knows about this leg.
    return {
      venueContractId: 'SDEX', // Marker — not a real contract
      venueId: this.venueId,
      amountIn,
      minAmountOut,
    };
  }

  // ─── Helpers ──────────────────────────────────────────

  /**
   * Resolve a token symbol or SAC address to a classic Stellar Asset.
   */
  private resolveAsset(symbolOrAddress: string): Asset | null {
    // Try by symbol
    const upper = symbolOrAddress.toUpperCase();
    const tokenConfig = TOKENS[upper];
    if (tokenConfig && tokenConfig.issuer) {
      return new Asset(tokenConfig.symbol, tokenConfig.issuer);
    }

    // Try to find by SAC address
    const byAddress = Object.values(TOKENS).find(
      (t) => t.sacAddress === symbolOrAddress && t.issuer
    );
    if (byAddress) {
      return new Asset(byAddress.symbol, byAddress.issuer);
    }

    // Handle XLM — by symbol OR by its well-known SAC address (the routing
    // pipeline passes SAC addresses; missing this returned 0-quotes for
    // every XLM pair on SDEX)
    if (
      upper === 'XLM' ||
      upper === 'NATIVE' ||
      symbolOrAddress === 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
    ) {
      return Asset.native();
    }

    return null;
  }

  /**
   * Convert base units (7 decimals) to display string for Horizon.
   */
  private toDisplayAmount(baseUnits: bigint): string {
    const whole = baseUnits / 10000000n;
    const frac = baseUnits % 10000000n;
    const fracStr = frac.toString().padStart(7, '0');
    return `${whole}.${fracStr}`;
  }

  /**
   * Convert display string from Horizon to base units.
   */
  private fromDisplayAmount(display: string): bigint {
    const [whole, frac = ''] = display.split('.');
    const fracPadded = frac.padEnd(7, '0').slice(0, 7);
    return BigInt(whole + fracPadded);
  }

  private emptyQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Quote {
    return {
      venue: this.name,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: 0n,
      effectiveBps: 9999,
      gasCost: 100n,
    };
  }
}

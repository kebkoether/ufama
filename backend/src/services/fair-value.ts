/**
 * Fair-value pricing for quote honesty: what is this token worth in USD
 * according to the oracles, independent of any pool?
 *
 * Sources, in order:
 *   1. RedStone's Stellar multi-feed adapter — keys assets by their own
 *      contract address, covers the RWA roster (deJAAA, deJTRSY, USDY,
 *      PYUSD, SolvBTC, xSolvBTC, stablebonds), 8 decimals.
 *   2. Reflector's external-markets oracle — keyed by ticker symbol
 *      (XLM, USDC, EURC, USDT, BTC, ETH, ...), 14 decimals.
 *
 * Read-only simulations, cached 2 minutes. A token neither oracle covers
 * prices as null and callers degrade gracefully (the UI falls back to
 * price impact).
 */

import { xdr, Address } from '@stellar/stellar-sdk';
import { StellarClient } from '../stellar/client.js';

const REDSTONE_ADAPTER =
  'CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF';
const REDSTONE_DECIMALS = 8;
const REFLECTOR_EXTERNAL =
  'CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN';
const REFLECTOR_DECIMALS = 14;
const TTL_MS = 120_000;

/** Symbols whose Reflector feed name differs from our display symbol. */
const REFLECTOR_ALIASES: Record<string, string> = {
  USDT0: 'USDT', // bridged Tether — USDT is its fair-value feed
};

/** A USD reading with its provenance — the RFQ screen shows NAV age. */
export interface UsdQuote {
  price: number;
  source: 'redstone' | 'reflector';
  /** Feed timestamp, seconds since epoch (ms feeds normalized). */
  timestamp: number;
}

export class FairValueService {
  private cache = new Map<string, { quote: UsdQuote | null; at: number }>();

  constructor(private stellar: StellarClient) {}

  /** USD price for a token, or null if no oracle covers it. */
  async priceUsd(sac: string, symbol: string): Promise<number | null> {
    return (await this.quoteUsd(sac, symbol))?.price ?? null;
  }

  /** USD price with source + feed timestamp, or null if uncovered. */
  async quoteUsd(sac: string, symbol: string): Promise<UsdQuote | null> {
    const hit = this.cache.get(sac);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.quote;

    // RedStone first (address-keyed — no symbol ambiguity)
    let quote = await this.lastprice(
      REDSTONE_ADAPTER,
      xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Stellar'),
        new Address(sac).toScVal(),
      ]),
      REDSTONE_DECIMALS,
      'redstone'
    );
    if (quote === null && symbol) {
      const alias = REFLECTOR_ALIASES[symbol] ?? symbol;
      quote = await this.lastprice(
        REFLECTOR_EXTERNAL,
        xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol('Other'),
          xdr.ScVal.scvSymbol(alias),
        ]),
        REFLECTOR_DECIMALS,
        'reflector'
      );
    }
    this.cache.set(sac, { quote, at: Date.now() });
    return quote;
  }

  /** SEP-40 lastprice via read-only simulation; null on any failure. */
  private async lastprice(
    oracle: string,
    asset: xdr.ScVal,
    decimals: number,
    source: UsdQuote['source']
  ): Promise<UsdQuote | null> {
    try {
      const res = await this.stellar.simulateAndParse<{ price: bigint; timestamp?: bigint }>(
        oracle,
        'lastprice',
        [asset]
      );
      if (!res || res.price === undefined) return null;
      const price = Number(res.price) / 10 ** decimals;
      if (!(price > 0)) return null;
      let ts = Number(res.timestamp ?? 0);
      if (ts > 100_000_000_000) ts = Math.floor(ts / 1000); // ms feeds
      return { price, source, timestamp: ts };
    } catch {
      return null;
    }
  }

  /**
   * Quote honesty in one number: how far below oracle fair value the
   * net output lands, in bps (negative = better than fair). null when
   * either token lacks a feed.
   */
  async vsOracleBps(opts: {
    tokenInSac: string;
    tokenOutSac: string;
    symbolIn: string;
    symbolOut: string;
    amountIn: bigint;
    netAmountOut: bigint;
    decimalsIn: number;
    decimalsOut: number;
  }): Promise<number | null> {
    const [pIn, pOut] = await Promise.all([
      this.priceUsd(opts.tokenInSac, opts.symbolIn),
      this.priceUsd(opts.tokenOutSac, opts.symbolOut),
    ]);
    if (!pIn || !pOut) return null;
    const inUnits = Number(opts.amountIn) / 10 ** opts.decimalsIn;
    const outUnits = Number(opts.netAmountOut) / 10 ** opts.decimalsOut;
    const fairOut = (inUnits * pIn) / pOut;
    if (!(fairOut > 0)) return null;
    return Math.round(((fairOut - outUnits) / fairOut) * 10000 * 10) / 10;
  }
}

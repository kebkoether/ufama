'use client';

/**
 * P2P order-book ladder for the selected pair. Shows resting fixed-price
 * orders on both sides, aggregated by price level:
 *   - asks: makers selling BASE for QUOTE (price = minOut_quote / in_base)
 *   - bids: makers selling QUOTE for BASE (price = in_quote / minOut_base)
 * Market-pegged orders have no fixed level; they're summarized as a count
 * under the ladder. Polls while visible.
 */

import { useState, useEffect, useCallback } from 'react';
import { getOrders } from '@/lib/api';
import { fromBaseUnits } from '@/lib/units';

interface Level {
  price: number;
  /** Size in BASE tokens at this level */
  size: number;
}

interface BookSide {
  levels: Level[];
  marketPegged: number;
}

interface Props {
  baseSymbol: string;
  quoteSymbol: string;
  baseSac: string;
  quoteSac: string;
  baseDecimals: number;
  quoteDecimals: number;
}

const POLL_MS = 15_000;

function aggregate(raw: Array<{ price: number; size: number }>): Level[] {
  const byPrice = new Map<string, Level>();
  for (const r of raw) {
    if (!isFinite(r.price) || r.price <= 0 || r.size <= 0) continue;
    const key = r.price.toPrecision(5);
    const existing = byPrice.get(key);
    if (existing) existing.size += r.size;
    else byPrice.set(key, { price: Number(key), size: r.size });
  }
  return [...byPrice.values()];
}

export default function OrderBook({
  baseSymbol,
  quoteSymbol,
  baseSac,
  quoteSac,
  baseDecimals,
  quoteDecimals,
}: Props) {
  const [asks, setAsks] = useState<BookSide>({ levels: [], marketPegged: 0 });
  const [bids, setBids] = useState<BookSide>({ levels: [], marketPegged: 0 });
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [askOrders, bidOrders] = await Promise.all([
        getOrders(baseSac, quoteSac).catch(() => []),
        getOrders(quoteSac, baseSac).catch(() => []),
      ]);
      const askFixed = askOrders.filter((o: any) => o.priceMode !== 1);
      const bidFixed = bidOrders.filter((o: any) => o.priceMode !== 1);
      setAsks({
        levels: aggregate(
          askFixed.map((o: any) => {
            const size = fromBaseUnits(o.amountInRemaining, baseDecimals);
            const wantTotal = fromBaseUnits(o.minAmountOut, quoteDecimals);
            const fullSize = fromBaseUnits(o.amountIn, baseDecimals);
            // min_out is quoted against the FULL order; price is per unit
            return { price: fullSize > 0 ? wantTotal / fullSize : 0, size };
          })
        ).sort((a, b) => a.price - b.price),
        marketPegged: askOrders.length - askFixed.length,
      });
      setBids({
        levels: aggregate(
          bidFixed.map((o: any) => {
            const pay = fromBaseUnits(o.amountInRemaining, quoteDecimals);
            const payFull = fromBaseUnits(o.amountIn, quoteDecimals);
            const wantBase = fromBaseUnits(o.minAmountOut, baseDecimals);
            // maker pays QUOTE, wants BASE — their price is what they pay per BASE
            const price = wantBase > 0 ? payFull / wantBase : 0;
            return { price, size: price > 0 ? pay / price : 0 };
          })
        ).sort((a, b) => b.price - a.price),
        marketPegged: bidOrders.length - bidFixed.length,
      });
      setLoaded(true);
    } catch {
      // keep the previous snapshot on transient failures
    }
  }, [baseSac, quoteSac, baseDecimals, quoteDecimals]);

  useEffect(() => {
    setLoaded(false);
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const bestAsk = asks.levels[0]?.price;
  const bestBid = bids.levels[0]?.price;
  const empty = asks.levels.length === 0 && bids.levels.length === 0;
  const pegged = asks.marketPegged + bids.marketPegged;
  const fmt = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
  const fmtSize = (n: number) =>
    n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 5 : 2 });

  const row = (level: Level, color: string, maxSize: number) => (
    <div
      key={`${color}-${level.price}`}
      style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '3px 8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}
    >
      <div
        style={{
          position: 'absolute', top: 0, bottom: 0, right: 0,
          width: `${Math.min(100, (level.size / maxSize) * 100)}%`,
          background: `${color}14`, borderRadius: '3px',
        }}
      />
      <span style={{ color, zIndex: 1 }}>{fmt(level.price)}</span>
      <span style={{ color: '#8a8f9c', zIndex: 1 }}>{fmtSize(level.size)}</span>
    </div>
  );

  const maxSize = Math.max(
    ...asks.levels.map((l) => l.size),
    ...bids.levels.map((l) => l.size),
    1e-9
  );

  return (
    <div style={{ background: '#161b26', borderRadius: '12px', padding: '14px', border: '1px solid #252a3a' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#8a8f9c', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Order Book · {baseSymbol}/{quoteSymbol}
        </div>
        <div style={{ fontSize: '10px', color: '#3a3f4c' }}>price in {quoteSymbol} · size in {baseSymbol}</div>
      </div>

      {!loaded ? (
        <div style={{ fontSize: '12px', color: '#565b68', padding: '8px' }}>Loading book…</div>
      ) : empty ? (
        <div style={{ fontSize: '12px', color: '#565b68', padding: '8px' }}>
          No resting orders for this pair yet — yours could be the first.
          {pegged > 0 && ` (${pegged} market-pegged order${pegged > 1 ? 's' : ''} waiting)`}
        </div>
      ) : (
        <div>
          {/* asks: lowest at the bottom, nearest the spread */}
          <div style={{ display: 'flex', flexDirection: 'column-reverse' }}>
            {asks.levels.slice(0, 6).map((l) => row(l, '#dc2626', maxSize))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', margin: '2px 0', borderTop: '1px solid #252a3a', borderBottom: '1px solid #252a3a', fontSize: '11px' }}>
            <span style={{ color: '#8a8f9c' }}>
              {bestBid && bestAsk
                ? `spread ${(((bestAsk - bestBid) / bestAsk) * 10000).toFixed(1)} bps`
                : 'one-sided book'}
            </span>
            <span style={{ color: '#565b68' }}>
              {bestBid && bestAsk ? `mid ${fmt((bestAsk + bestBid) / 2)}` : ''}
            </span>
          </div>
          <div>
            {bids.levels.slice(0, 6).map((l) => row(l, '#16a34a', maxSize))}
          </div>
          {pegged > 0 && (
            <div style={{ fontSize: '10px', color: '#565b68', marginTop: '6px', padding: '0 8px' }}>
              +{pegged} market-pegged order{pegged > 1 ? 's' : ''} tracking oracle mid
            </div>
          )}
        </div>
      )}
    </div>
  );
}

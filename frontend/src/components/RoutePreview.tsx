'use client';

interface RouteSegment {
  venue: string;
  amountIn: string;
  expectedOut: string;
  effectiveBps: number;
}

interface RoutePreviewProps {
  route: {
    segments: RouteSegment[];
    amountIn: string;
    blendedBps: number;
    /** True price impact vs small-size spot rate (unit-safe) */
    priceImpactBps?: number;
    /** Symbols + decimals attached by SwapWidget for labeling amounts */
    tokenInSymbol?: string;
    tokenOutSymbol?: string;
    tokenInDecimals?: number;
    tokenOutDecimals?: number;
    multiHop?: {
      label: string;
      hopCount: number;
      hops: Array<{
        fromSymbol: string;
        toSymbol: string;
        venues: Array<{ venue: string; pct: number }>;
      }>;
    };
  };
}

const VENUE_COLORS: Record<string, string> = {
  SwapBook: '#6366f1',
  StellarDEX: '#4fc3f7',
  Aqua: '#06b6d4',
  SushiSwap: '#ec4899',
  Curve: '#eab308',
};

import { formatUnits } from '@/lib/units';

function fmtAmount(raw: string, decimals: number): string {
  return formatUnits(raw, decimals);
}

function TokenNode({ symbol }: { symbol: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        background: '#1e2433',
        border: '1px solid #2a3040',
        borderRadius: '999px',
        padding: '5px 12px',
        fontSize: '13px',
        fontWeight: 600,
        color: '#e1e4ea',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: '#6366f1',
          display: 'inline-block',
        }}
      />
      {symbol}
    </div>
  );
}

/**
 * One hop's connector: a straight venue-labeled arrow, or — when the hop
 * splits liquidity across venues — arrows that diverge and rejoin, one
 * per venue, colored and labeled with each venue's share.
 */
function HopArrow({ venues }: { venues: Array<{ venue: string; pct: number }> }) {
  const W = 120;
  const split = venues.length > 1;
  const H = split ? 64 : 40;
  const mid = H / 2;
  const color = (v: string) => VENUE_COLORS[v] || '#8a8f9c';
  return (
    <div style={{ position: 'relative', width: W, height: H, flexShrink: 0 }}>
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          {venues.map((v, i) => (
            <marker
              key={i}
              id={`arr-${v.venue}-${i}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0.5 L7.5,4 L0,7.5" fill="none" stroke={color(v.venue)} strokeWidth="1.6" strokeLinecap="round" />
            </marker>
          ))}
        </defs>
        {split ? (
          venues.slice(0, 2).map((v, i) => {
            const off = i === 0 ? -14 : 14;
            return (
              <path
                key={i}
                d={`M4,${mid} C ${W * 0.3},${mid + off} ${W * 0.7},${mid + off} ${W - 6},${mid}`}
                fill="none"
                stroke={color(v.venue)}
                strokeWidth="1.8"
                markerEnd={`url(#arr-${v.venue}-${i})`}
              />
            );
          })
        ) : (
          <path
            d={`M4,${mid} L${W - 6},${mid}`}
            stroke={color(venues[0]?.venue ?? '')}
            strokeWidth="1.8"
            markerEnd={`url(#arr-${venues[0]?.venue}-0)`}
          />
        )}
      </svg>
      {/* venue labels ride their arrows */}
      {split ? (
        venues.slice(0, 2).map((v, i) => (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              top: i === 0 ? 0 : H - 16,
              fontSize: '10px',
              fontWeight: 600,
              color: color(v.venue),
              whiteSpace: 'nowrap',
            }}
          >
            {v.venue} {v.pct}%
          </span>
        ))
      ) : (
        <span
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            top: mid - 18,
            fontSize: '10px',
            fontWeight: 600,
            color: color(venues[0]?.venue ?? ''),
            whiteSpace: 'nowrap',
          }}
        >
          {venues[0]?.venue}
        </span>
      )}
    </div>
  );
}

function MultiHopFlow({
  hops,
}: {
  hops: NonNullable<RoutePreviewProps['route']['multiHop']>['hops'];
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        overflowX: 'auto',
        padding: '6px 2px 10px',
      }}
    >
      <TokenNode symbol={hops[0].fromSymbol} />
      {hops.map((h, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <HopArrow venues={h.venues} />
          <TokenNode symbol={h.toSymbol} />
        </span>
      ))}
    </div>
  );
}

export default function RoutePreview({ route }: RoutePreviewProps) {
  // A venue that contributes nothing is noise, not information —
  // "0% via SwapBook" must never render.
  const segments = (route.segments ?? []).filter((s) => {
    try { return BigInt(s.amountIn) > 0n; } catch { return false; }
  });
  if (segments.length === 0) return null;

  const totalIn = parseInt(route.amountIn);
  const inSym = route.tokenInSymbol ?? '';
  const outSym = route.tokenOutSymbol ?? '';

  return (
    <div
      style={{
        background: '#131722',
        border: '1px solid #1a1f2e',
        borderRadius: '16px',
        padding: '16px 18px',
      }}
    >
      <div
        style={{
          fontSize: '12px',
          fontWeight: 600,
          color: '#565b68',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '12px',
        }}
      >
        Route
      </div>

      {/* Multi-hop: the route as a venue-labeled flow diagram */}
      {route.multiHop && route.multiHop.hops?.length > 0 && (
        <>
          <MultiHopFlow hops={route.multiHop.hops} />
          <div style={{ fontSize: '11px', color: '#565b68', marginBottom: '4px' }}>
            {route.multiHop.hopCount} transactions to sign — each step price-protected on-chain
          </div>
        </>
      )}

      {!route.multiHop && (
        <>
      {/* Visual split bar */}
      <div
        style={{
          display: 'flex',
          height: '6px',
          borderRadius: '3px',
          overflow: 'hidden',
          gap: '2px',
          marginBottom: '14px',
        }}
      >
        {segments.map((seg, i) => {
          const pct = (parseInt(seg.amountIn) / totalIn) * 100;
          return (
            <div
              key={i}
              style={{
                width: `${pct}%`,
                background: VENUE_COLORS[seg.venue] || '#565b68',
                borderRadius: '3px',
                minWidth: '4px',
              }}
            />
          );
        })}
      </div>

      {/* Segment rows: venue, share, and in → out amounts in TOKEN units.
          (Amounts previously carried a hardcoded "$" — 10,000 XLM read as
          "$10,000". Per-segment effectiveBps was also dropped: it compared
          token-in units to token-out units, meaningless off stable pairs.) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {segments.map((seg, i) => {
          const pct = (parseInt(seg.amountIn) / totalIn) * 100;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: VENUE_COLORS[seg.venue] || '#565b68',
                  }}
                />
                <span style={{ fontSize: '13px', color: '#e1e4ea', fontWeight: 500 }}>
                  {seg.venue}
                </span>
                <span style={{ fontSize: '12px', color: '#565b68' }}>
                  {pct.toFixed(0)}%
                </span>
              </div>
              <span style={{ fontSize: '13px', color: '#8a8f9c' }}>
                {fmtAmount(seg.amountIn, route.tokenInDecimals ?? 7)}{inSym ? ` ${inSym}` : ''}
                <span style={{ color: '#565b68' }}> → </span>
                {fmtAmount(seg.expectedOut, route.tokenOutDecimals ?? 7)}{outSym ? ` ${outSym}` : ''}
              </span>
            </div>
          );
        })}
      </div>

        </>
      )}

      {/* Footer: true price impact (falls back to hiding when unavailable) */}
      {route.priceImpactBps !== undefined && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: '1px solid #1a1f2e',
          }}
        >
          <span style={{ fontSize: '12px', color: '#565b68' }}>Price impact</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#6366f1' }}>
            ~{Math.max(0, route.priceImpactBps).toFixed(1)} bps
          </span>
        </div>
      )}
    </div>
  );
}

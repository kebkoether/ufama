'use client';

/**
 * RFQ panel: the taker's view of one request.
 *
 *   idle      → what RFQ does, in two lines
 *   open      → countdown + reference strip (NAV, AMM, standing book) +
 *               quote cards as they land; best card highlighted
 *   closed    → cards still acceptable during their grace window, or the
 *               two fallbacks (standing order at NAV / AMM route)
 *   done      → handled by the widget's tx status card
 *
 * Every price is shown as basis points versus NAV from the same anchor
 * the contract enforces (positive vsNavBps = you receive less than NAV).
 */

import { formatUnits } from '@/lib/units';
import type { RfqRequest, RfqQuote, RfqPhase } from '@/lib/rfq';

interface Props {
  request: RfqRequest | null;
  phase: RfqPhase;
  error: string | null;
  secondsLeft: number;
  quotes: RfqQuote[];
  now: number;
  tokenIn: string;
  tokenOut: string;
  decimalsIn: number;
  decimalsOut: number;
  busy: boolean;
  /** Standing-order fallback allowed for this pair (server corridor). */
  standingAllowed: boolean;
  onAcceptQuote: (quoteId: string) => void;
  onAcceptBook: () => void;
  onUseAmm: () => void;
  onPostStanding: () => void;
  onCancel: () => void;
}

/** "NAV −5 bps" when the taker receives less than NAV, "NAV +2 bps" when more. */
export function navLabel(vs: number | null): string {
  if (vs === null) return 'no NAV ref';
  if (Math.abs(vs) < 0.05) return 'at NAV';
  return vs > 0 ? `NAV −${vs.toFixed(1)} bps` : `NAV +${(-vs).toFixed(1)} bps`;
}

function navColor(vs: number | null): string {
  if (vs === null) return '#8a8f9c';
  if (vs <= 0) return '#22c55e';
  if (vs <= 10) return '#a3e635';
  if (vs <= 50) return '#eab308';
  return '#ef4444';
}

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        fontSize: '11px',
        fontWeight: 600,
        color,
        background: `${color}1a`,
        border: `1px solid ${color}44`,
        borderRadius: '999px',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

function ageLabel(sec: number | null): string {
  if (sec === null) return '';
  if (sec < 90) return `${sec}s old`;
  if (sec < 5400) return `${Math.round(sec / 60)} min old`;
  return `${(sec / 3600).toFixed(1)} h old`;
}

const card: React.CSSProperties = {
  background: '#161b26',
  borderRadius: '12px',
  padding: '12px 14px',
  border: '1px solid #252a3a',
};

export default function RfqPanel(p: Props) {
  const { request: r, phase, quotes } = p;
  const fmtOut = (raw: string) => formatUnits(raw, p.decimalsOut);
  const fmtIn = (raw: string) => formatUnits(raw, p.decimalsIn);

  if (phase === 'idle' || !r) {
    return (
      <div style={{ ...card, background: 'rgba(99, 102, 241, 0.06)', border: '1px solid rgba(99, 102, 241, 0.15)' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#6366f1', marginBottom: '4px' }}>REQUEST FOR QUOTE</div>
        <div style={{ fontSize: '13px', color: '#8a8f9c', lineHeight: 1.5 }}>
          Makers answer within seconds with firm prices pinned to NAV. Accept one and both legs
          settle in a single transaction — <strong style={{ color: '#e1e4ea' }}>no escrow</strong>,{' '}
          <strong style={{ color: '#22c55e' }}>0.5 bps</strong> fee. Nobody answers? Post a
          standing order at NAV or take the DEX route.
        </div>
        {phase === 'idle' && p.error && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#ef4444' }}>{p.error}</div>
        )}
      </div>
    );
  }

  const ref = r.reference;
  const collecting = phase === 'open' && p.secondsLeft > 0;
  const best = quotes[0];
  const bookOut = ref.bookAmountOut ? BigInt(ref.bookAmountOut) : null;
  const bookPartial = ref.bookAmountInUsed && BigInt(ref.bookAmountInUsed) < BigInt(r.amountIn);
  const ammOut = ref.ammAmountOut ? BigInt(ref.ammAmountOut) : null;
  const bestOut = best ? BigInt(best.amountOut) : null;
  const bookBeatsBest = bookOut !== null && !bookPartial && (bestOut === null || bookOut > bestOut);
  const ammBeatsBest = ammOut !== null && (bestOut === null || ammOut > bestOut) && !bookBeatsBest;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Reference strip */}
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center' }}>
        <div style={{ fontSize: '12px', color: '#8a8f9c' }}>
          <span style={{ color: '#565b68' }}>NAV </span>
          {ref.navPrice !== null ? (
            <>
              <strong style={{ color: '#e1e4ea' }}>
                1 {p.tokenIn} = {ref.navPrice.toLocaleString('en-US', { maximumSignificantDigits: 6 })} {p.tokenOut}
              </strong>
              <span style={{ color: '#565b68' }}>
                {' '}· {ref.navSource === 'swapbook' ? 'on-chain feed' : ref.navSource}
                {ref.navAgeSec !== null ? ` · ${ageLabel(ref.navAgeSec)}` : ''}
              </span>
            </>
          ) : (
            <span style={{ color: '#eab308' }}>no oracle feed for this pair — quotes show raw output only</span>
          )}
        </div>
        {ref.oracleOnChain && (
          <Chip text="NAV band enforced on-chain" color="#6366f1" />
        )}
        {ref.issuerNavAmountOut && (
          <div style={{ fontSize: '12px', color: '#8a8f9c', flexBasis: '100%' }}>
            <span style={{ color: '#565b68' }}>Issuer NAV </span>
            <strong style={{ color: '#e1e4ea' }}>
              {fmtOut(ref.issuerNavAmountOut)} {p.tokenOut}
            </strong>
            <span style={{ color: '#565b68' }}>
              {' '}· {ref.issuerNavSource}
              {ref.issuerNavAgeSec !== null ? ` · ${ageLabel(ref.issuerNavAgeSec)}` : ''}
              {ref.issuerVsOracleBps !== null
                ? ` · oracle ${Math.abs(ref.issuerVsOracleBps) < 0.05 ? 'matches' : ref.issuerVsOracleBps > 0 ? `−${ref.issuerVsOracleBps.toFixed(1)} bps vs issuer` : `+${(-ref.issuerVsOracleBps).toFixed(1)} bps vs issuer`}`
                : ''}
            </span>
          </div>
        )}
        <div style={{ marginLeft: 'auto', fontSize: '12px', color: collecting ? '#6366f1' : '#565b68', fontWeight: 600 }}>
          {collecting
            ? `Collecting quotes · ${p.secondsLeft}s`
            : phase === 'accepting'
            ? 'Settling…'
            : phase === 'done'
            ? 'Settled'
            : `Request closed · ${quotes.length} live quote${quotes.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {p.error && phase === 'error' && (
        <div style={{ ...card, borderColor: 'rgba(239,68,68,0.35)', color: '#ef4444', fontSize: '13px' }}>{p.error}</div>
      )}

      {/* Maker quote cards */}
      {quotes.map((q, i) => {
        const secs = Math.max(0, Math.ceil((q.expiresAt - p.now) / 1000));
        const isBest = i === 0 && !bookBeatsBest && !ammBeatsBest;
        return (
          <div
            key={q.id}
            style={{
              ...card,
              border: isBest ? '1px solid #22c55e' : '1px solid #252a3a',
              background: isBest ? 'rgba(34,197,94,0.06)' : '#161b26',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#e1e4ea' }}>{q.makerLabel}</span>
                <Chip text="firm" color="#6366f1" />
                {isBest && <Chip text="best" color="#22c55e" />}
                {q.maxNavDevBps > 0 && <Chip text={`±${q.maxNavDevBps} bps band`} color="#8a8f9c" />}
              </div>
              <div style={{ marginTop: '4px', fontSize: '15px', fontWeight: 700, color: '#e1e4ea' }}>
                {fmtOut(q.amountOut)} {p.tokenOut}
              </div>
              <div style={{ marginTop: '2px', fontSize: '12px', display: 'flex', gap: '10px', alignItems: 'center' }}>
                <span style={{ color: navColor(q.vsNavBps), fontWeight: 600 }}>{navLabel(q.vsNavBps)}</span>
                <span style={{ color: '#565b68' }}>
                  {q.maker.slice(0, 4)}…{q.maker.slice(-4)} · expires in {secs}s
                </span>
              </div>
            </div>
            <button
              onClick={() => p.onAcceptQuote(q.id)}
              disabled={p.busy}
              style={{
                padding: '10px 14px',
                borderRadius: '10px',
                border: 'none',
                background: p.busy ? '#1a1f2e' : 'linear-gradient(135deg, #16a34a, #15803d)',
                color: p.busy ? '#565b68' : 'white',
                fontSize: '13px',
                fontWeight: 600,
                cursor: p.busy ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Accept
            </button>
          </div>
        );
      })}

      {/* Standing-book card */}
      {bookOut !== null && (
        <div
          style={{
            ...card,
            border: bookBeatsBest ? '1px solid #22c55e' : '1px solid #252a3a',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#e1e4ea' }}>Standing orders</span>
              <Chip text={`${ref.bookFills} order${ref.bookFills === 1 ? '' : 's'}`} color="#8a8f9c" />
              {bookBeatsBest && <Chip text="best" color="#22c55e" />}
            </div>
            <div style={{ marginTop: '4px', fontSize: '15px', fontWeight: 700, color: '#e1e4ea' }}>
              {fmtOut(ref.bookAmountOut!)} {p.tokenOut}
              {bookPartial && (
                <span style={{ fontSize: '12px', fontWeight: 400, color: '#eab308' }}>
                  {' '}for {fmtIn(ref.bookAmountInUsed!)} {p.tokenIn} — remainder escrows
                </span>
              )}
            </div>
            <div style={{ marginTop: '2px', fontSize: '12px', color: navColor(ref.bookVsNavBps), fontWeight: 600 }}>
              {navLabel(ref.bookVsNavBps)}
            </div>
          </div>
          {p.standingAllowed && (
            <button
              onClick={p.onAcceptBook}
              disabled={p.busy}
              style={{
                padding: '10px 14px',
                borderRadius: '10px',
                border: '1px solid #6366f1',
                background: 'transparent',
                color: '#e1e4ea',
                fontSize: '13px',
                fontWeight: 600,
                cursor: p.busy ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Fill
            </button>
          )}
        </div>
      )}

      {/* AMM card */}
      {ammOut !== null && (
        <div
          style={{
            ...card,
            border: ammBeatsBest ? '1px solid #22c55e' : '1px solid #252a3a',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#e1e4ea' }}>DEX route</span>
              <Chip text={ref.ammVenues.join(' + ') || 'AMM'} color="#8a8f9c" />
              {ammBeatsBest && <Chip text="best" color="#22c55e" />}
            </div>
            <div style={{ marginTop: '4px', fontSize: '15px', fontWeight: 700, color: '#e1e4ea' }}>
              {fmtOut(ref.ammAmountOut!)} {p.tokenOut}
            </div>
            <div style={{ marginTop: '2px', fontSize: '12px', color: navColor(ref.ammVsNavBps), fontWeight: 600 }}>
              {navLabel(ref.ammVsNavBps)} <span style={{ color: '#565b68', fontWeight: 400 }}>· venue fees included</span>
            </div>
          </div>
          <button
            onClick={p.onUseAmm}
            disabled={p.busy}
            style={{
              padding: '10px 14px',
              borderRadius: '10px',
              border: '1px solid #2a3040',
              background: 'transparent',
              color: '#e1e4ea',
              fontSize: '13px',
              fontWeight: 600,
              cursor: p.busy ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Swap now
          </button>
        </div>
      )}

      {/* Waiting / nobody answered */}
      {quotes.length === 0 && collecting && (
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#8a8f9c' }}>
          <span
            style={{
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              border: '2px solid #6366f1',
              borderTopColor: 'transparent',
              display: 'inline-block',
              animation: 'ufamaSpin 0.7s linear infinite',
            }}
          />
          Waiting for makers… firm quotes land here as they arrive.
          <style>{`@keyframes ufamaSpin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {quotes.length === 0 && !collecting && phase !== 'accepting' && phase !== 'done' && (
        <div style={{ ...card, fontSize: '13px', color: '#8a8f9c', lineHeight: 1.5 }}>
          <div style={{ color: '#e1e4ea', fontWeight: 600, marginBottom: '4px' }}>No maker answered in time.</div>
          {p.standingAllowed ? (
            <>
              Post a <strong style={{ color: '#e1e4ea' }}>standing order</strong>
              {ref.oracleOnChain ? ' pegged to NAV' : ''} below — it rests on-chain until a
              counterparty fills it, and can auto-route to DEXs on a timer.
            </>
          ) : (
            <>Standing orders are not open for this pair yet. Try again, or take the DEX route.</>
          )}
          <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {p.standingAllowed && (
              <button
                onClick={p.onPostStanding}
                disabled={p.busy}
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #6366f1', background: 'rgba(99,102,241,0.1)', color: '#e1e4ea', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
              >
                Post standing order{ref.oracleOnChain ? ' at NAV' : ''}
              </button>
            )}
            {ammOut !== null && (
              <button
                onClick={p.onUseAmm}
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #2a3040', background: 'transparent', color: '#e1e4ea', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
              >
                Take the DEX route
              </button>
            )}
            <button
              onClick={p.onCancel}
              style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #2a3040', background: 'transparent', color: '#8a8f9c', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            >
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

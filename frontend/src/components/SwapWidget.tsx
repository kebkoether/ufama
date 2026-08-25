'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { toBaseUnits, fromBaseUnits, formatUnits } from '@/lib/units';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
import { useWallet } from '@/context/WalletContext';
import { getQuote as fetchQuote, buildPeerSwap, getOraclePrice } from '@/lib/api';

// ─── Token Data ─────────────────────────────────────────

interface Token {
  symbol: string;
  name: string;
  color: string;
  letterBg: string;
  status: 'live' | 'coming_soon';
  /** SAC contract address (preferred API identifier when present) */
  sacAddress?: string;
  /** Classic asset issuer — used to match Horizon trustline balances */
  issuer?: string;
  /** Curated registry entries are verified; venue-discovered ones are not */
  verified?: boolean;
  /** Aggregate venue volume — powers hot-first ordering */
  venueVolume?: number;
  /** Token decimals (7 for SACs; Soroban-native tokens can differ) */
  decimals?: number;
  /** Curated tokens: issuer's verified home domain (SEP-1) */
  homeDomain?: string;
  /** Has a registered venue pool → allowed in the TWAP tab */
  twapEligible?: boolean;
}

/**
 * Curated fallback list — replaced at runtime by /api/assets, which
 * aggregates the curated registry with every token discovered from venue
 * liquidity (Aqua pools today; Sushi once their API is verified).
 */
const TOKENS: Token[] = [
  { symbol: 'USDC', name: 'USD Coin', color: '#2775ca', letterBg: '#2775ca', status: 'live', verified: true },
  { symbol: 'PYUSD', name: 'PayPal USD', color: '#0070e0', letterBg: '#003087', status: 'live', verified: true },
  { symbol: 'USDY', name: 'Ondo USDY', color: '#5865f2', letterBg: '#1a1a6e', status: 'live', verified: true },
  { symbol: 'USDT0', name: 'Tether', color: '#26a17b', letterBg: '#26a17b', status: 'coming_soon', verified: true },
  { symbol: 'SolvBTC', name: 'Solv BTC', color: '#f7931a', letterBg: '#f7931a', status: 'coming_soon', verified: true },
];

const CURATED_STYLE: Record<string, { color: string; letterBg: string }> =
  Object.fromEntries(TOKENS.map((t) => [t.symbol, { color: t.color, letterBg: t.letterBg }]));

/** Deterministic color for venue-discovered tokens. */
function hashColor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 55%, 48%)`;
}

function assetToToken(asset: any): Token {
  const style = CURATED_STYLE[asset.symbol] ?? {
    color: hashColor(asset.symbol),
    letterBg: hashColor(asset.symbol),
  };
  return {
    symbol: asset.symbol,
    name: asset.name,
    color: style.color,
    letterBg: style.letterBg,
    status: asset.status,
    sacAddress: asset.sacAddress || undefined,
    issuer: asset.issuer || undefined,
    decimals: asset.decimals ?? 7,
    homeDomain: asset.homeDomain || undefined,
    verified: asset.verified ?? asset.source === 'curated',
    venueVolume: asset.venueVolume ?? 0,
    twapEligible: asset.twapEligible ?? false,
  };
}

// Fallback P2P corridor — replaced at runtime by the backend's p2pAllowed
// (P2P_ALLOWED_TOKENS env), so the corridor is a server-side product knob.
const P2P_ALLOWED_FALLBACK = ['USDC', 'USDT0'];

// Horizon serves wallet balances directly (public CORS API) — one call
// per wallet covers XLM + every classic trustline.
const HORIZON_URL = (process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? '').startsWith('Public Global')
  ? 'https://horizon.stellar.org'
  : 'https://horizon-testnet.stellar.org';

function formatBalance(raw: string): string {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return '--';
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

// ─── Token Icon ─────────────────────────────────────────

function TokenIcon({ symbol, color, size = 28 }: { symbol: string; color: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `linear-gradient(145deg, ${color}, ${color}aa)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.36,
        fontWeight: 700,
        color: 'white',
        flexShrink: 0,
        boxShadow: `0 2px 8px ${color}33`,
      }}
    >
      {symbol === 'USDC' ? '$' : symbol === 'PYUSD' ? 'P' : symbol === 'USDY' ? 'Y' : symbol.charAt(0)}
    </div>
  );
}

// ─── Token Dropdown ─────────────────────────────────────

function TokenDropdown({
  selected,
  tokens,
  onSelect,
  exclude,
}: {
  selected: string;
  tokens: Token[];
  onSelect: (symbol: string) => void;
  exclude?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // brief ✓ feedback after copying a contract address
  const [copiedKey, setCopiedKey] = useState('');

  const selectedToken = tokens.find((t) => t.symbol === selected) || tokens[0];
  // Exclude the token on the other side; filter by search query.
  // With a query, MATCH QUALITY ranks first (exact symbol, then symbol
  // prefix, then symbol substring, then name match) — searching "deJAAA"
  // must put deJAAA on top, not below whatever has more volume. Without
  // a query the list keeps its volume-sorted (hot first) order.
  const q = query.trim().toLowerCase();
  // Bounded edit distance for typo tolerance ("solvebtc" → SolvBTC).
  const editDistLe = (a: string, b: string, max: number): boolean => {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  };
  const matchRank = (t: Token): number => {
    const sym = t.symbol.toLowerCase();
    if (sym === q) return 0;
    if (sym.startsWith(q)) return 1;
    // paste-a-contract-address search: exact hygiene tool — a C… (SAC)
    // or G… (issuer) prefix of 6+ chars pins the one true token
    if (q.length >= 6 && /^[cg][a-z2-7]+$/.test(q)) {
      if (t.sacAddress?.toLowerCase().startsWith(q)) return 0;
      if (t.issuer?.toLowerCase().startsWith(q)) return 0;
    }
    if (sym.includes(q)) return 2;
    if (t.name.toLowerCase().includes(q)) return 3;
    if (q.length >= 3) {
      const tol = q.length >= 6 ? 2 : 1;
      // whole-symbol typo tolerance: 'solvebtc' → SolvBTC
      if (editDistLe(sym, q, tol)) return 4;
      // PREFIX-window tolerance for mid-typing: 'solve' is one typo away
      // from the first 5-6 chars of 'solvbtc', so the token never
      // vanishes while the user is still typing toward it
      if (editDistLe(sym.slice(0, q.length), q, tol)) return 4;
      if (editDistLe(sym.slice(0, Math.min(sym.length, q.length + 1)), q, tol)) return 4;
    }
    return 5;
  };
  const available = tokens
    .filter((t) => t.symbol !== exclude && (!q || matchRank(t) < 5))
    .sort((a, b) => {
      if (!q) return 0;
      const ra = matchRank(a);
      const rb = matchRank(b);
      if (ra !== rb) return ra - rb;
      // within a tier, shorter symbols are the closer match
      return a.symbol.length - b.symbol.length;
    });

  return (
    <div ref={ref} style={{ position: 'relative', zIndex: open ? 50 : 1 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: '#1e2433',
          border: open ? '1px solid #6366f1' : '1px solid #2a3040',
          borderRadius: '12px',
          padding: '8px 12px 8px 8px',
          cursor: 'pointer',
          color: '#e1e4ea',
          fontSize: '15px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <TokenIcon symbol={selectedToken.symbol} color={selectedToken.color} size={26} />
        {selectedToken.symbol}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ marginLeft: '2px', opacity: 0.5, transform: open ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: '#1a1f2e',
            border: '1px solid #252a3a',
            borderRadius: '14px',
            padding: '4px',
            minWidth: '220px',
            maxHeight: '320px',
            overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search token…"
            style={{
              width: 'calc(100% - 8px)',
              margin: '4px',
              padding: '9px 12px',
              background: '#0d1117',
              border: '1px solid #252a3a',
              borderRadius: '10px',
              color: '#e1e4ea',
              fontSize: '13px',
              outline: 'none',
            }}
          />
          {available.length === 0 && (
            <div style={{ padding: '12px', fontSize: '13px', color: '#565b68', textAlign: 'center' }}>
              No tokens match “{query}”
            </div>
          )}
          {available.map((token, idx) => {
            const isComingSoon = token.status === 'coming_soon';
            const isHot = !q && idx < 10 && (token.venueVolume ?? 0) > 0;
            return (
              <button
                key={token.sacAddress || `${token.symbol}-${idx}`}
                title={[
                  token.homeDomain ? `Verified issuer: ${token.homeDomain}` : undefined,
                  token.sacAddress ? `Contract: ${token.sacAddress}` : undefined,
                  token.issuer ? `Issuer: ${token.issuer}` : undefined,
                ]
                  .filter(Boolean)
                  .join('\n') || undefined}
                onClick={() => { if (!isComingSoon) { onSelect(token.symbol); setOpen(false); } }}
                disabled={isComingSoon}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '10px 12px',
                  background: token.symbol === selected ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                  border: 'none',
                  borderRadius: '10px',
                  cursor: isComingSoon ? 'default' : 'pointer',
                  color: isComingSoon ? '#3a3f4c' : '#e1e4ea',
                  fontSize: '14px',
                  opacity: isComingSoon ? 0.5 : 1,
                }}
                onMouseEnter={(e) => { if (!isComingSoon) e.currentTarget.style.background = 'rgba(99,102,241,0.08)'; }}
                onMouseLeave={(e) => { if (!isComingSoon) e.currentTarget.style.background = token.symbol === selected ? 'rgba(99,102,241,0.1)' : 'transparent'; }}
              >
                <TokenIcon symbol={token.symbol} color={token.color} size={32} />
                <div style={{ textAlign: 'left', flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '14px' }}>
                    {token.symbol}
                    {isHot && <span style={{ marginLeft: '6px', fontSize: '11px' }} title="High venue volume">🔥</span>}
                  </div>
                  <div style={{ fontSize: '12px', color: isComingSoon ? '#3a3f4c' : '#8a8f9c' }}>{token.name}</div>
                </div>
                {token.sacAddress && (
                  // span, not button — rows are <button>s and nesting
                  // buttons is invalid HTML
                  <span
                    role="button"
                    title={copiedKey === token.sacAddress ? 'Copied!' : `Copy contract address\n${token.sacAddress}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard?.writeText(token.sacAddress!).then(() => {
                        setCopiedKey(token.sacAddress!);
                        setTimeout(() => setCopiedKey(''), 1200);
                      });
                    }}
                    style={{
                      fontSize: '12px',
                      padding: '3px 6px',
                      borderRadius: '5px',
                      color: copiedKey === token.sacAddress ? '#22c55e' : '#565b68',
                      background: 'transparent',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#8a8f9c'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = copiedKey === token.sacAddress ? '#22c55e' : '#565b68'; }}
                  >
                    {copiedKey === token.sacAddress ? '✓' : '⧉'}
                  </span>
                )}
                {isComingSoon && (
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: '#565b68',
                    background: 'rgba(86, 91, 104, 0.15)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                  }}>
                    SOON
                  </span>
                )}
                {token.homeDomain && (
                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#22c55e', background: 'rgba(34, 197, 94, 0.1)', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                    ✓ {token.homeDomain}
                  </span>
                )}
                {!isComingSoon && token.verified === false && (
                  // Venue-discovered listing (not curated) — verify the
                  // issuer before trading unfamiliar tokens.
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 600,
                    color: '#8a8f9c',
                    background: 'rgba(138, 143, 156, 0.12)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    whiteSpace: 'nowrap',
                  }}>
                    DEX
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Input Panel ────────────────────────────────────────

function InputPanel({
  label,
  sublabel,
  onSublabelClick,
  value,
  onChange,
  readOnly,
  token,
  tokens,
  onTokenSelect,
  excludeToken,
  accent,
}: {
  onSublabelClick?: () => void;
  label: string;
  sublabel?: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  token: string;
  tokens: Token[];
  onTokenSelect: (s: string) => void;
  excludeToken?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: '#0d1117',
        borderRadius: '16px',
        padding: '16px 18px',
        border: '1px solid #161b26',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {accent && (
            <div style={{ width: '3px', height: '14px', borderRadius: '2px', background: accent }} />
          )}
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#8a8f9c' }}>
            {label}
          </span>
        </div>
        {sublabel && (
          <span
            onClick={onSublabelClick}
            title={onSublabelClick ? 'Use full balance' : undefined}
            style={{
              fontSize: '12px',
              color: onSublabelClick ? '#8a8f9c' : '#565b68',
              cursor: onSublabelClick ? 'pointer' : 'default',
              textDecoration: onSublabelClick ? 'underline dotted' : 'none',
            }}
          >
            {sublabel}
          </span>
        )}
      </div>

      {/* Amount + Token row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {readOnly ? (
          value === '…' ? (
            <span style={{ flex: 1, display: 'flex', gap: '7px', alignItems: 'center', height: '34px' }}>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: '9px',
                    height: '9px',
                    borderRadius: '50%',
                    background: '#6366f1',
                    display: 'inline-block',
                    animation: `ufamaDotHop 0.9s ${i * 0.15}s ease-in-out infinite`,
                  }}
                />
              ))}
              <style>{`@keyframes ufamaDotHop {
                0%, 55%, 100% { transform: translateY(0); opacity: 0.55; }
                25% { transform: translateY(-9px); opacity: 1; }
              }`}</style>
            </span>
          ) : (
          <span
            style={{
              flex: 1,
              fontSize: '28px',
              fontWeight: 600,
              color: value && value !== '0.00' ? '#e1e4ea' : '#3a3f4c',
              letterSpacing: '-0.5px',
            }}
          >
            {value || '0.00'}
          </span>
          )
        ) : (
          <input
            type="number"
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder="0.00"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: '28px',
              fontWeight: 600,
              color: '#e1e4ea',
              letterSpacing: '-0.5px',
              width: '100%',
              minWidth: 0,
            }}
          />
        )}
        <TokenDropdown
          selected={token}
          tokens={tokens}
          onSelect={onTokenSelect}
          exclude={excludeToken}
        />
      </div>
    </div>
  );
}

// ─── Main Widget ────────────────────────────────────────

interface SwapWidgetProps {
  onRouteComputed: (route: any) => void;
}

export default function SwapWidget({ onRouteComputed }: SwapWidgetProps) {
  const [tokenIn, setTokenIn] = useState('USDC');
  const [tokenOut, setTokenOut] = useState('PYUSD');
  const [amountIn, setAmountIn] = useState('');
  const [mode, setMode] = useState<'instant' | 'p2p' | 'twap'>('instant');
  const [instantSlippageBps, setInstantSlippageBps] = useState(50);
  // TWAP controls
  const [twapDurationMin, setTwapDurationMin] = useState(360); // 6h default
  const [twapLimitPrice, setTwapLimitPrice] = useState('');
  const [twapMaxSlicePct, setTwapMaxSlicePct] = useState(10);
  const [twapFeeBps, setTwapFeeBps] = useState<number | null>(null);

  useEffect(() => {
    if (mode !== 'twap' || twapFeeBps !== null) return;
    import('@/lib/api').then(({ getTwapFee }) =>
      getTwapFee().then((f) => { if (f) setTwapFeeBps(f.feeBps); })
    );
  }, [mode, twapFeeBps]);

  const [loading, setLoading] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [p2pPlan, setP2pPlan] = useState<any>(null);
  const [priceMode, setPriceMode] = useState<'fixed' | 'market'>('fixed');
  const [maxSlippageBps, setMaxSlippageBps] = useState(50); // 0.50% default
  const [autoRouteMinutes, setAutoRouteMinutes] = useState(0); // 0 = no timer
  const [oraclePrice, setOraclePrice] = useState<number | null>(null);
  const { connected: walletConnected, address: walletAddress, connect: connectWallet, signTransaction } = useWallet();

  // Aggregated token universe from the backend (curated + venue-discovered),
  // hot-first: sorted by venue volume so the tokens people actually trade sit
  // at the top of the dropdown. Falls back to the curated list offline.
  const [allTokens, setAllTokens] = useState<Token[]>(TOKENS);
  const [quoteNote, setQuoteNote] = useState<string>('');
  // Best-route search still running (stage-2) — drives the pulse UI
  const [searching, setSearching] = useState(false);
  const quoteSeq = useRef(0);

  // Decimal-aware conversions — Sushi-discovered Soroban tokens (deJTRSY,
  // deJAAA, ...) are 18 decimals, not the SAC-standard 7.
  const decimalsOf = useCallback(
    (symbol: string) => allTokens.find((t) => t.symbol === symbol)?.decimals ?? 7,
    [allTokens]
  );
  const [p2pAllowed, setP2pAllowed] = useState<string[]>(P2P_ALLOWED_FALLBACK);

  // Wallet balances by symbol, from Horizon. XLM matches the native line;
  // classic assets match on (code, issuer) against the token universe.
  const [balances, setBalances] = useState<Record<string, string>>({});
  const fetchBalances = useCallback(async () => {
    if (!walletAddress) {
      setBalances({});
      return;
    }
    try {
      const res = await fetch(`${HORIZON_URL}/accounts/${walletAddress}`);
      if (!res.ok) return; // unfunded accounts 404 — keep whatever we had
      const data = await res.json();
      const next: Record<string, string> = {};
      for (const b of data.balances ?? []) {
        if (b.asset_type === 'native') {
          next['XLM'] = b.balance;
        } else if (b.asset_code) {
          const match = allTokens.find(
            (t) => t.symbol === b.asset_code && t.issuer === b.asset_issuer
          );
          if (match) next[match.symbol] = b.balance;
        }
      }
      // Soroban-native tokens (no classic issuer — e.g. deJAAA, deJTRSY)
      // have no Horizon trustline; their balances come from the backend,
      // which simulates token.balance() on-chain.
      try {
        const sres = await fetch(`${API_BASE}/api/balances/${walletAddress}`);
        if (sres.ok) {
          const sdata = await sres.json();
          for (const b of sdata.balances ?? []) {
            if (b.symbol && b.balance !== undefined) next[b.symbol] = b.balance;
          }
        }
      } catch {
        // Soroban balance fetch is best-effort
      }
      setBalances(next);
    } catch {
      // Network hiccup — leave the previous snapshot in place
    }
  }, [walletAddress, allTokens]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  const balanceLabel = useCallback(
    (symbol: string): string => {
      if (!walletAddress) return 'Balance: --';
      if (balances[symbol] !== undefined) return `Balance: ${formatBalance(balances[symbol])}`;
      // Connected + known classic asset but no trustline → genuinely zero.
      const t = allTokens.find((x) => x.symbol === symbol);
      if (symbol === 'XLM' || t?.issuer) return 'Balance: 0';
      return 'Balance: --';
    },
    [walletAddress, balances, allTokens]
  );

  // Click-the-balance → fill the sell field with the FULL balance (all
  // digits, no display rounding — one click, no dust left behind). XLM
  // keeps a 2 XLM buffer for the base reserve + transaction fees.
  const fillMaxBalance = useCallback(() => {
    const raw = balances[tokenIn];
    if (raw === undefined) return;
    let max = raw;
    if (tokenIn === 'XLM') {
      const n = parseFloat(raw) - 2;
      if (n <= 0) return;
      max = n.toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
    }
    setAmountIn(max);
    setQuote(null);
    setP2pPlan(null);
  }, [balances, tokenIn]);
  // Load the live token universe. RETRIES matter: a single failed fetch
  // (e.g. the backend restarting right after a deploy) used to strand the
  // UI on the 6-token curated fallback until a hard refresh. Retry with
  // backoff, and refresh when the tab regains focus.
  const assetsLoaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const load = async (attempt: number) => {
      try {
        const { getAssetsFull } = await import('@/lib/api');
        const { assets, p2pAllowed: corridor } = await getAssetsFull();
        if (cancelled) return;
        if (Array.isArray(assets) && assets.length > 0) {
          const mapped = assets.map(assetToToken);
          mapped.sort((a, b) => (b.venueVolume ?? 0) - (a.venueVolume ?? 0));
          setAllTokens(mapped);
          assetsLoaded.current = true;
        }
        if (Array.isArray(corridor) && corridor.length > 0) setP2pAllowed(corridor);
      } catch {
        if (!cancelled && attempt < 6) {
          setTimeout(() => load(attempt + 1), 2000 * (attempt + 1));
        }
      }
    };
    load(0);
    const onFocus = () => {
      if (!assetsLoaded.current) load(0);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const p2pTokens = allTokens.filter((t) => p2pAllowed.includes(t.symbol));
  const twapTokens = allTokens.filter((t) => t.twapEligible);
  const p2pLive = (symbol: string) =>
    p2pTokens.find((t) => t.symbol === symbol)?.status === 'live';

  // Prefer SAC addresses when calling the API — discovered tokens aren't
  // resolvable by symbol on the backend.
  const tokenParam = useCallback(
    (symbol: string) => allTokens.find((t) => t.symbol === symbol)?.sacAddress || symbol,
    [allTokens]
  );

  // Determine if either side is a volatile asset (needs oracle pricing)
  const isVolatilePair = tokenIn === 'SolvBTC' || tokenOut === 'SolvBTC';

  // Fetch oracle price when in P2P + Market mode with a volatile pair
  useEffect(() => {
    if (mode === 'p2p' && priceMode === 'market' && isVolatilePair) {
      const btcSide = tokenIn === 'SolvBTC' ? tokenIn : tokenOut;
      const stableSide = tokenIn === 'SolvBTC' ? tokenOut : tokenIn;
      getOraclePrice(btcSide, stableSide).then((data) => {
        if (data.available && data.price) setOraclePrice(data.price);
      }).catch(() => {});
    }
  }, [mode, priceMode, tokenIn, tokenOut, isVolatilePair]);

  const [submitting, setSubmitting] = useState(false);

  // ─── Auto-quote: fetch as user types (debounced) ──────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchQuoteDebounced = useCallback(
    (amount: string, tIn: string, tOut: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!amount || parseFloat(amount) <= 0) {
        setQuote(null);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        const seq = ++quoteSeq.current;
        const publish = (data: any) => {
          setQuote(data);
          // Symbols ride along so RoutePreview can label amounts correctly
          onRouteComputed({
            ...data,
            tokenInSymbol: tIn,
            tokenOutSymbol: tOut,
            tokenInDecimals: decimalsOf(tIn),
            tokenOutDecimals: decimalsOf(tOut),
          });
        };
        try {
          setLoading(true);
          setSearching(true);
          setQuoteNote('');
          const baseAmount = toBaseUnits(amount, decimalsOf(tIn));
          let gotFull = false;
          // Stage 1: direct route — on screen in one engine pass.
          fetchQuote(tokenParam(tIn), tokenParam(tOut), baseAmount, undefined, { fast: true })
            .then((d) => {
              if (seq === quoteSeq.current && !gotFull) publish(d);
            })
            .catch(() => {}); // fast stage failing is fine; stage 2 decides
          // Stage 2: full best-route search (direct vs multi-hop).
          const data = await fetchQuote(tokenParam(tIn), tokenParam(tOut), baseAmount);
          gotFull = true;
          if (seq !== quoteSeq.current) return;
          publish(data);
        } catch (error: any) {
          if (seq !== quoteSeq.current) return;
          console.error('Quote error:', error);
          setQuote(null);
          setQuoteNote(
            String(error?.message ?? '').includes('No route')
              ? 'No route — no venue has enough liquidity for this pair at this size.'
              : 'Quote unavailable — try again in a moment.'
          );
        } finally {
          if (seq === quoteSeq.current) {
            setLoading(false);
            setSearching(false);
          }
        }
      }, 400); // 400ms debounce
    },
    [onRouteComputed, tokenParam]
  );

  // Trigger auto-quote when amount/tokens change in instant mode
  useEffect(() => {
    if (mode === 'instant' || mode === 'twap') {
      // TWAP reuses the instant quote as a full-size market estimate
      fetchQuoteDebounced(amountIn, tokenIn, tokenOut);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [amountIn, tokenIn, tokenOut, mode, fetchQuoteDebounced]);

  const handleSwapTokens = useCallback(() => {
    const prev = tokenIn;
    setTokenIn(tokenOut);
    setTokenOut(prev);
    setQuote(null);
    setP2pPlan(null);
  }, [tokenIn, tokenOut]);

  const handleP2pCheck = useCallback(async () => {
    if (!amountIn || parseFloat(amountIn) <= 0) return;
    setLoading(true);
    try {
      const baseAmount = toBaseUnits(amountIn, decimalsOf(tokenIn));
      const data = await buildPeerSwap({
        sourceAddress: walletAddress || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        tokenIn,
        tokenOut,
        amountIn: baseAmount,
        minAmountOut: priceMode === 'market' ? '0' : baseAmount,
        priceMode: priceMode === 'market' ? 1 : 0,
        maxSlippageBps: priceMode === 'market' ? maxSlippageBps : undefined,
        autoRouteMinutes: autoRouteMinutes > 0 ? autoRouteMinutes : undefined,
      });
      setP2pPlan(data.plan);
    } catch (error) {
      console.error('P2P match check error:', error);
    } finally {
      setLoading(false);
    }
  }, [amountIn, tokenIn, tokenOut, walletAddress, priceMode, maxSlippageBps, autoRouteMinutes]);

  // Place a TWAP order: build → sign (escrows total) → submit
  const handleTwapSubmit = useCallback(async () => {
    if (!walletAddress || !amountIn || parseFloat(amountIn) <= 0) return;
    setSubmitting(true);
    try {
      const { buildTwap, submitTransaction } = await import('@/lib/api');
      const baseAmount = toBaseUnits(amountIn, decimalsOf(tokenIn));
      const { xdr, plan } = await buildTwap({
        sourceAddress: walletAddress,
        tokenIn: tokenParam(tokenIn),
        tokenOut: tokenParam(tokenOut),
        amountIn: baseAmount,
        durationMinutes: twapDurationMin,
        limitPrice: twapLimitPrice || undefined,
        maxSlippageBps: twapLimitPrice ? undefined : maxSlippageBps,
        maxSlicePct: twapMaxSlicePct,
      });
      const signed = await signTransaction(xdr);
      await submitTransaction(signed);
      alert(
        `TWAP started: ${parseFloat(amountIn).toLocaleString()} ${tokenIn} over ` +
        `${twapDurationMin >= 60 ? `${twapDurationMin / 60}h` : `${twapDurationMin}m`}. ` +
        `Proceeds stream to your wallet as slices fill — track it on the Orders page.`
      );
      setAmountIn('');
      fetchBalances();
    } catch (error: any) {
      console.error('TWAP submit error:', error);
      alert(`Failed to start TWAP: ${error?.message || 'Unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  }, [walletAddress, amountIn, tokenIn, tokenOut, twapDurationMin, twapLimitPrice, twapMaxSlicePct, maxSlippageBps, tokenParam, signTransaction, fetchBalances]);

  // Submit the P2P order (sign + send the transaction)
  const handleP2pSubmit = useCallback(async () => {
    if (!walletAddress || !p2pPlan) return;
    setSubmitting(true);
    try {
      const baseAmount = toBaseUnits(amountIn, decimalsOf(tokenIn));
      const data = await buildPeerSwap({
        sourceAddress: walletAddress,
        tokenIn,
        tokenOut,
        amountIn: baseAmount,
        minAmountOut: priceMode === 'market' ? '0' : baseAmount,
        priceMode: priceMode === 'market' ? 1 : 0,
        maxSlippageBps: priceMode === 'market' ? maxSlippageBps : undefined,
        autoRouteMinutes: autoRouteMinutes > 0 ? autoRouteMinutes : undefined,
      });

      if (data.xdrs && data.xdrs.length > 0) {
        // Sign each transaction via the wallet context (enforces the
        // app's expected network before every signature)
        const { submitTransaction } = await import('@/lib/api');
        for (const xdrStr of data.xdrs) {
          const signed = await signTransaction(xdrStr);
          await submitTransaction(signed);
        }
        alert('Order placed successfully! Check the Orders tab to see it.');
        setP2pPlan(null);
        setAmountIn('');
        fetchBalances();
      } else {
        alert('Order plan ready but no transactions to sign yet. The smart contracts need SAC addresses configured to build real transactions.');
      }
    } catch (error: any) {
      console.error('P2P submit error:', error);
      alert(`Failed to submit: ${error?.message || 'Unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  }, [walletAddress, p2pPlan, amountIn, tokenIn, tokenOut, priceMode, maxSlippageBps, autoRouteMinutes, signTransaction, fetchBalances]);

  // Handle instant swap execution
  const handleInstantSwap = useCallback(async () => {
    if (!walletAddress || !quote) return;
    setSubmitting(true);
    try {
      const { buildSwap, submitTransaction } = await import('@/lib/api');
      const baseAmount = toBaseUnits(amountIn, decimalsOf(tokenIn));
      // The backend picks the best execution: Soroban route (Aqua/Sushi via
      // the Router contract) or a classic SDEX path payment — either way
      // it's one XDR to sign.
      const data = await buildSwap({
        sourceAddress: walletAddress,
        tokenIn: tokenParam(tokenIn),
        tokenOut: tokenParam(tokenOut),
        amountIn: baseAmount,
        slippage: instantSlippageBps,
      });
      const { kind, route } = data;
      let via: string;
      if (kind === 'blend' && Array.isArray(data.legs)) {
        // Split execution: SDEX chunk (classic tx) + AMM chunk (Router tx).
        // Two signatures; each leg carries its own min-out, so a rejected
        // or failed second leg means "partially executed", never a worse
        // price than quoted.
        let done = 0;
        try {
          for (const leg of data.legs) {
            const signed = await signTransaction(leg.xdr);
            await submitTransaction(signed);
            done++;
          }
        } catch (err: any) {
          if (done > 0) {
            alert(
              `Partially executed: part 1 of your swap filled, part 2 was ` +
              `cancelled or failed (${err?.message || 'unknown error'}). ` +
              `The unswapped portion is still in your wallet.`
            );
            setQuote(null);
            fetchBalances();
            return;
          }
          throw err;
        }
        via = (route?.segments || []).map((s: any) => s.venue).join(' + ') + ' (split for better price)';
      } else {
        if (!data.xdr) throw new Error('Backend returned no transaction to sign');
        const signed = await signTransaction(data.xdr);
        await submitTransaction(signed);
        via = kind === 'classic'
          ? 'Stellar DEX (classic)'
          : (route?.segments || []).map((s: any) => s.venue).join(' + ') || 'DEX route';
      }
      alert(`Swap submitted via ${via}. Check your wallet balance.`);
      setAmountIn('');
      setQuote(null);
      fetchBalances();
    } catch (error: any) {
      console.error('Swap error:', error);
      alert(`Failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  }, [walletAddress, quote, amountIn, tokenIn, tokenOut, tokenParam, signTransaction, instantSlippageBps, fetchBalances]);

  const formatOutput = (raw: string) => {
    if (!raw) return '0.00';
    return formatUnits(raw, decimalsOf(tokenOut));
  };

  return (
    <div
      style={{
        background: '#131722',
        border: '1px solid #1a1f2e',
        borderRadius: '20px',
      }}
    >
      {/* Mode tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1a1f2e' }}>
        {([
          { key: 'instant' as const, label: 'Instant Swap', desc: 'Fills now via DEXs · venue fees only' },
          { key: 'p2p' as const, label: 'P2P Match', desc: 'Wait for a peer · 0.5 bps only' },
          { key: 'twap' as const, label: 'TWAP', desc: 'Spread over time · keeper-run' },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setMode(tab.key);
              setQuote(null);
              setP2pPlan(null);
              if (tab.key === 'p2p') {
                // Coerce selections into the (server-configured) P2P corridor
                const nextIn = p2pAllowed.includes(tokenIn) ? tokenIn : p2pAllowed[0];
                const fallbackOut = p2pAllowed.find((s) => s !== nextIn) ?? p2pAllowed[0];
                const nextOut =
                  p2pAllowed.includes(tokenOut) && tokenOut !== nextIn ? tokenOut : fallbackOut;
                setTokenIn(nextIn);
                setTokenOut(nextOut);
              }
              if (tab.key === 'twap' && twapTokens.length >= 2) {
                // Coerce into TWAP-eligible tokens (registered venue pools)
                const eligible = (s: string) => twapTokens.some((t) => t.symbol === s);
                const nextIn = eligible(tokenIn) ? tokenIn : twapTokens[0].symbol;
                const nextOut =
                  eligible(tokenOut) && tokenOut !== nextIn
                    ? tokenOut
                    : twapTokens.find((t) => t.symbol !== nextIn)?.symbol ?? tokenOut;
                setTokenIn(nextIn);
                setTokenOut(nextOut);
              }
            }}
            style={{
              flex: 1,
              padding: '14px 16px 12px',
              background: 'transparent',
              border: 'none',
              borderBottom: mode === tab.key ? '2px solid #6366f1' : '2px solid transparent',
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: 600, color: mode === tab.key ? '#e1e4ea' : '#565b68' }}>
              {tab.label}
            </div>
            <div style={{ fontSize: '11px', color: mode === tab.key ? '#6366f1' : '#3a3f4c', marginTop: '2px' }}>
              {tab.desc}
            </div>
          </button>
        ))}
      </div>

      <div style={{ padding: '18px' }}>
        {/* Selling */}
        <InputPanel
          label="Selling"
          sublabel={balanceLabel(tokenIn)}
          onSublabelClick={balances[tokenIn] !== undefined ? fillMaxBalance : undefined}
          value={amountIn}
          onChange={(v) => { setAmountIn(v); setP2pPlan(null); }}
          token={tokenIn}
          tokens={mode === 'p2p' ? p2pTokens : mode === 'twap' ? twapTokens : allTokens}
          onTokenSelect={(s) => { setTokenIn(s); if (s === tokenOut) setTokenOut(tokenIn); setQuote(null); setP2pPlan(null); }}
          excludeToken={tokenOut}
          accent="#ef4444"
        />

        {/* Direction arrow */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '-6px 0', position: 'relative', zIndex: 2 }}>
          <button
            onClick={handleSwapTokens}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: '#1a1f2e',
              border: '3px solid #131722',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: '#8a8f9c',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#252a3a'; e.currentTarget.style.color = '#e1e4ea'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#1a1f2e'; e.currentTarget.style.color = '#8a8f9c'; }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v10M7 12l3-3M7 12l-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Buying */}
        <InputPanel
          label={mode === 'instant' ? 'Buying' : 'Buying (estimated)'}
          sublabel={loading ? 'Fetching...' : balanceLabel(tokenOut)}
          value={
            (mode === 'instant' || mode === 'twap') && !quote && loading
              ? '…'
              : (mode === 'instant' || mode === 'twap') && quote
              ? `${mode === 'twap' ? '~' : ''}${formatOutput(quote.netAmountOut)}`
              : mode === 'p2p' && amountIn && parseFloat(amountIn) > 0
              ? p2pPlan
                ? formatOutput(p2pPlan.summary?.instantFillAmount || '0')
                : `~${parseFloat(amountIn).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : ''
          }
          readOnly
          token={tokenOut}
          tokens={mode === 'p2p' ? p2pTokens : mode === 'twap' ? twapTokens : allTokens}
          onTokenSelect={(s) => { setTokenOut(s); if (s === tokenIn) setTokenIn(tokenOut); setQuote(null); setP2pPlan(null); }}
          excludeToken={tokenIn}
          accent="#22c55e"
        />

        {/* Instant options: slippage tolerance */}
        {mode === 'instant' && (
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#161b26', borderRadius: '12px', border: '1px solid #252a3a' }}>
            <span style={{ fontSize: '12px', color: '#8a8f9c' }}>Slippage tolerance</span>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              {[25, 50, 100].map((bps) => (
                <button
                  key={bps}
                  onClick={() => setInstantSlippageBps(bps)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: '7px',
                    border: instantSlippageBps === bps ? '1px solid #6366f1' : '1px solid #1a1f2e',
                    background: instantSlippageBps === bps ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    color: instantSlippageBps === bps ? '#e1e4ea' : '#565b68',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {(bps / 100).toFixed(2)}%
                </button>
              ))}
              {/* Custom tolerance — same unit as the presets (percent),
                  converted to bps internally. */}
              <input
                type="number"
                step={0.05}
                min={0.01}
                max={10}
                value={
                  [25, 50, 100].includes(instantSlippageBps)
                    ? ''
                    : instantSlippageBps / 100
                }
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v) && v >= 0.01 && v <= 10) {
                    setInstantSlippageBps(Math.round(v * 100));
                  }
                }}
                placeholder="custom %"
                title="Custom slippage tolerance, in percent"
                style={{
                  width: '72px', padding: '5px 8px', background: '#0d1117',
                  border: '1px dashed #2a3040', borderRadius: '7px',
                  color: '#e1e4ea', fontSize: '11px', outline: 'none',
                  textAlign: 'center',
                }}
              />
            </div>
          </div>
        )}

        {/* TWAP Options: duration, limit, participation */}
        {mode === 'twap' && (
          <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ background: '#161b26', borderRadius: '12px', padding: '14px', border: '1px solid #252a3a' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#8a8f9c', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Execution window
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {([
                  { min: 30, label: '30m' },
                  { min: 60, label: '1h' },
                  { min: 360, label: '6h' },
                  { min: 1440, label: '24h' },
                  { min: 4320, label: '3d' },
                ]).map((opt) => (
                  <button
                    key={opt.min}
                    onClick={() => setTwapDurationMin(opt.min)}
                    style={{
                      flex: 1,
                      minWidth: '52px',
                      padding: '10px 8px',
                      borderRadius: '10px',
                      border: twapDurationMin === opt.min ? '1px solid #6366f1' : '1px solid #1a1f2e',
                      background: twapDurationMin === opt.min ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                      cursor: 'pointer',
                      color: twapDurationMin === opt.min ? '#e1e4ea' : '#565b68',
                      fontSize: '13px',
                      fontWeight: 600,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', color: '#8a8f9c', marginBottom: '6px' }}>
                    Limit price <span style={{ color: '#3a3f4c' }}>(min {tokenOut}/{tokenIn} · blank = market ± oracle)</span>
                  </div>
                  <input
                    type="number"
                    value={twapLimitPrice}
                    onChange={(e) => setTwapLimitPrice(e.target.value)}
                    placeholder="e.g. 0.9995"
                    style={{
                      width: '100%', background: '#0d1117', border: '1px solid #1a1f2e',
                      borderRadius: '8px', padding: '8px 10px', color: '#e1e4ea',
                      fontSize: '13px', outline: 'none',
                    }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#8a8f9c', marginBottom: '6px' }}>Max slice</div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {[5, 10, 25].map((pct) => (
                      <button
                        key={pct}
                        onClick={() => setTwapMaxSlicePct(pct)}
                        style={{
                          padding: '8px 10px', borderRadius: '8px',
                          border: twapMaxSlicePct === pct ? '1px solid #6366f1' : '1px solid #1a1f2e',
                          background: twapMaxSlicePct === pct ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                          color: twapMaxSlicePct === pct ? '#e1e4ea' : '#565b68',
                          fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: '10px', fontSize: '11px', color: '#565b68', lineHeight: 1.5 }}>
                Your total escrows on-chain and executes in slices over the window.
                Pace, price floor, and slice cadence are enforced by the contract —
                the keeper can only run it slower, never at a worse price. Proceeds
                stream to your wallet; cancel anytime for an instant refund of the rest.
                {twapFeeBps !== null && (
                  <>
                    {' '}Execution fee:{' '}
                    <strong style={{ color: '#8a8f9c' }}>
                      {(twapFeeBps / 100).toFixed(2)}% per slice
                    </strong>{' '}
                    (hard-capped on-chain at 0.10%). Your limit price applies to
                    net proceeds after the fee.
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* P2P Options: Price Mode + Timer */}
        {mode === 'p2p' && (
          <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* Price Mode Toggle */}
            <div
              style={{
                background: '#161b26',
                borderRadius: '12px',
                padding: '14px',
                border: '1px solid #252a3a',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#8a8f9c', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Price Mode
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {([
                  { key: 'fixed' as const, label: 'Fixed Price', desc: 'Set your exact minimum output' },
                  { key: 'market' as const, label: 'Market Price', desc: 'Oracle-pegged with slippage tolerance' },
                ] as const).map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => { setPriceMode(opt.key); setP2pPlan(null); }}
                    style={{
                      flex: 1,
                      padding: '10px 8px',
                      borderRadius: '10px',
                      border: priceMode === opt.key ? '1px solid #6366f1' : '1px solid #1a1f2e',
                      background: priceMode === opt.key ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 600, color: priceMode === opt.key ? '#e1e4ea' : '#565b68' }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: '10px', color: priceMode === opt.key ? '#6366f1' : '#3a3f4c', marginTop: '2px' }}>
                      {opt.desc}
                    </div>
                  </button>
                ))}
              </div>

              {/* Market mode details */}
              {priceMode === 'market' && (
                <div style={{ marginTop: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '12px', color: '#8a8f9c' }}>Max slippage</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {[25, 50, 100, 200].map((bps) => (
                        <button
                          key={bps}
                          onClick={() => { setMaxSlippageBps(bps); setP2pPlan(null); }}
                          style={{
                            padding: '4px 8px',
                            borderRadius: '6px',
                            border: maxSlippageBps === bps ? '1px solid #6366f1' : '1px solid #1a1f2e',
                            background: maxSlippageBps === bps ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                            color: maxSlippageBps === bps ? '#e1e4ea' : '#565b68',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {(bps / 100).toFixed(2)}%
                        </button>
                      ))}
                    </div>
                  </div>
                  {isVolatilePair && oraclePrice && (
                    <div style={{ fontSize: '11px', color: '#8a8f9c', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                      Oracle: 1 SolvBTC = ${oraclePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Auto-Route Timer */}
            <div
              style={{
                background: '#161b26',
                borderRadius: '12px',
                padding: '14px',
                border: '1px solid #252a3a',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#8a8f9c', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Auto-Route Timer
              </div>
              <div style={{ fontSize: '12px', color: '#8a8f9c', marginBottom: '10px' }}>
                No peer match in time? Auto-route through DEX liquidity.
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {[
                  { mins: 0, label: 'No limit' },
                  { mins: 5, label: '5 min' },
                  { mins: 15, label: '15 min' },
                  { mins: 30, label: '30 min' },
                  { mins: 60, label: '1 hour' },
                ].map((opt) => (
                  <button
                    key={opt.mins}
                    onClick={() => { setAutoRouteMinutes(opt.mins); setP2pPlan(null); }}
                    style={{
                      padding: '8px 14px',
                      borderRadius: '8px',
                      border: autoRouteMinutes === opt.mins ? '1px solid #6366f1' : '1px solid #2a3040',
                      background: autoRouteMinutes === opt.mins ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255,255,255,0.03)',
                      color: autoRouteMinutes === opt.mins ? '#e1e4ea' : '#8a8f9c',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {autoRouteMinutes > 0 && (
                <div style={{ marginTop: '8px', fontSize: '11px', color: '#eab308', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M6 3v3.5l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                  After {autoRouteMinutes} min with no P2P match, your order auto-routes through DEXs at market rate.
                </div>
              )}
            </div>
          </div>
        )}

        {/* P2P Match info */}
        {mode === 'p2p' && amountIn && parseFloat(amountIn) > 0 && (
          <div
            style={{
              marginTop: '12px',
              background: 'rgba(99, 102, 241, 0.06)',
              border: '1px solid rgba(99, 102, 241, 0.15)',
              borderRadius: '12px',
              padding: '12px 14px',
              fontSize: '13px',
              color: '#8a8f9c',
              lineHeight: '1.5',
            }}
          >
            <div style={{ fontWeight: 600, color: '#6366f1', marginBottom: '4px', fontSize: '12px' }}>
              P2P MATCH
            </div>

            {p2pPlan ? (
              // Show auto-match results
              <div>
                {p2pPlan.fills && p2pPlan.fills.length > 0 ? (
                  <>
                    <div style={{ color: '#22c55e', fontWeight: 600, marginBottom: '4px' }}>
                      {p2pPlan.fills.length} matching order{p2pPlan.fills.length > 1 ? 's' : ''} found
                    </div>
                    <div style={{ marginBottom: '6px' }}>
                      <strong style={{ color: '#e1e4ea' }}>
                        {formatUnits(p2pPlan.summary.instantFillAmount, decimalsOf(tokenOut))} {tokenOut}
                      </strong>{' '}
                      fills instantly at <strong style={{ color: '#22c55e' }}>0.5 bps</strong>.
                    </div>
                    {p2pPlan.remainder && (
                      <div style={{ fontSize: '12px', color: '#eab308' }}>
                        Remaining{' '}
                        <strong>{formatUnits(p2pPlan.remainder.amountIn, decimalsOf(tokenIn))} {tokenIn}</strong>{' '}
                        will be escrowed on-chain waiting for a future match.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      No matching orders right now. Your{' '}
                      <strong style={{ color: '#e1e4ea' }}>{parseFloat(amountIn).toLocaleString()} {tokenIn}</strong>{' '}
                      will be escrowed on-chain and wait for a counterparty to match at{' '}
                      <strong style={{ color: '#22c55e' }}>0.5 bps</strong>.
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#565b68' }}>
                      *Could take minutes to days depending on demand. Cancel anytime to reclaim tokens.
                    </div>
                  </>
                )}
              </div>
            ) : (
              // Default info before checking
              <div>
                We&apos;ll check for matching orders first. Any matches fill instantly at{' '}
                <strong style={{ color: '#22c55e' }}>0.5 bps</strong>. Remainder is escrowed
                on-chain and waits for a future match. You can cancel anytime.
                <div style={{ marginTop: '6px', fontSize: '12px', color: '#565b68' }}>
                  *Cheapest option, but the wait could be minutes to days depending on demand.
                </div>
              </div>
            )}
          </div>
        )}

        {searching && mode === 'instant' && (
          <div
            style={{
              marginTop: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '12px',
              color: '#8a8f9c',
            }}
          >
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
            Searching every pool for the best route…
            <style>{`@keyframes ufamaSpin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {quoteNote && (
          <div style={{
            marginTop: '10px',
            padding: '10px 12px',
            borderRadius: '10px',
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.25)',
            color: '#eab308',
            fontSize: '13px',
          }}>
            {quoteNote}
          </div>
        )}

        {/* Quote details */}
        {quote && mode === 'instant' && (
          <div
            style={{
              marginTop: '12px',
              background: '#0d1117',
              borderRadius: '12px',
              padding: '12px 14px',
              border: '1px solid #161b26',
            }}
          >
            {(() => {
              // Live rate from the actual quote: tokenOut received per
              // tokenIn — in WHOLE tokens, not raw base units (a raw
              // ratio is off by 10^(decOut-decIn) on mixed-decimal pairs
              // like USDC/deJAAA).
              const inTokens = fromBaseUnits(String(quote.amountIn ?? 0), decimalsOf(tokenIn));
              const outTokens = fromBaseUnits(String(quote.netAmountOut ?? 0), decimalsOf(tokenOut));
              const outAmt = Number(quote.netAmountOut ?? 0);
              const rate = inTokens > 0 ? outTokens / inTokens : 0;
              const rateStr = rate > 0
                ? `1 ${tokenIn} ≈ ${rate.toLocaleString('en-US', { maximumSignificantDigits: 5 })} ${tokenOut}`
                : '—';
              // Protocol fee expressed against the output, in bps.
              const feeBps = outAmt > 0 ? (Number(quote.protocolFee ?? 0) / outAmt) * 10000 : 0;
              const impactBps = Math.max(0, quote.priceImpactBps ?? 0);
              // Total cost in OUTPUT-TOKEN units — concrete beats abstract.
              // $-prefixed only when the output token is a USD stable.
              const totalBps = impactBps + feeBps;
              const costUnits = (totalBps / 10000) * fromBaseUnits(String(outAmt), decimalsOf(tokenOut));
              const isUsdStable = ['USDC', 'PYUSD', 'USDT0', 'USDY'].includes(tokenOut);
              const costStr = costUnits > 0
                ? `≈ ${isUsdStable ? '$' : ''}${costUnits.toLocaleString('en-US', { maximumFractionDigits: costUnits < 1 ? 4 : 2 })}${isUsdStable ? '' : ' ' + tokenOut} (${totalBps.toFixed(1)} bps)`
                : `${totalBps.toFixed(1)} bps`;
              return [
                { label: 'Rate', value: rateStr },
                {
                  label: 'Our fee',
                  value: parseInt(quote.swapBookAmountOut ?? '0') > 0
                    ? `0.5 bps on P2P portion`
                    : 'None — all via DEXs',
                  color: parseInt(quote.swapBookAmountOut ?? '0') > 0 ? '#22c55e' : '#8a8f9c',
                },
                { label: 'Price impact', value: `~${impactBps.toFixed(1)} bps`, color: '#eab308' },
                { label: 'Total cost', value: costStr, color: '#6366f1', bold: true },
              ];
            })().map((row: any) => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <span style={{ fontSize: '13px', color: '#565b68' }}>{row.label}</span>
                <span style={{ fontSize: '13px', color: row.color || '#8a8f9c', fontWeight: row.bold ? 600 : 400 }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Action button */}
        {(() => {
          const hasAmount = amountIn && parseFloat(amountIn) > 0;
          const p2pPairReady =
            mode !== 'p2p' || (p2pLive(tokenIn) && p2pLive(tokenOut));
          const disabled = !hasAmount || loading || submitting || !p2pPairReady;

          // Determine button action and label
          let onClick: (() => void) | undefined;
          let label = 'Enter an amount';
          let showGreen = false; // Use green for "confirm" actions

          if (!walletConnected) {
            onClick = connectWallet;
            label = 'Connect Wallet';
          } else if (submitting) {
            label = 'Signing transaction...';
          } else if (loading) {
            label = mode === 'p2p' ? 'Checking for matches...' : 'Finding best route...';
          } else if (mode === 'twap') {
            if (!hasAmount) {
              label = 'Enter an amount';
            } else {
              onClick = handleTwapSubmit;
              showGreen = true;
              const dur = twapDurationMin >= 60 ? `${twapDurationMin / 60}h` : `${twapDurationMin}m`;
              label = `Start TWAP · escrow ${parseFloat(amountIn).toLocaleString()} ${tokenIn} over ${dur}`;
            }
          } else if (mode === 'instant') {
            if (quote && hasAmount) {
              onClick = handleInstantSwap;
              label = `Swap ${parseFloat(amountIn).toLocaleString()} ${tokenIn} → ${formatOutput(quote.netAmountOut)} ${tokenOut}`;
              showGreen = true;
            } else if (hasAmount) {
              // Auto-quoting is in progress or failed — show loading state
              label = 'Fetching quote...';
            }
          } else if (mode === 'p2p') {
            if (!p2pPairReady) {
              label = `${tokenIn === 'USDT0' || tokenOut === 'USDT0' ? 'USDT0' : 'Pair'} not live yet — P2P opens at launch`;
            } else if (!hasAmount) {
              label = 'Enter an amount';
            } else if (!p2pPlan) {
              onClick = handleP2pCheck;
              label = 'Find P2P Matches';
            } else {
              // Plan loaded — button submits the order
              onClick = handleP2pSubmit;
              showGreen = true;
              if (p2pPlan.fills?.length > 0) {
                label = p2pPlan.remainder
                  ? `Fill ${p2pPlan.fills.length} match${p2pPlan.fills.length > 1 ? 'es' : ''} + escrow remainder`
                  : `Fill ${p2pPlan.fills.length} match${p2pPlan.fills.length > 1 ? 'es' : ''} now`;
              } else {
                label = `Place Order · escrow ${parseFloat(amountIn).toLocaleString()} ${tokenIn}`;
              }
            }
          }

          return (
            <button
              onClick={onClick}
              disabled={disabled && walletConnected}
              style={{
                width: '100%',
                marginTop: '16px',
                padding: '16px',
                borderRadius: '14px',
                border: 'none',
                background: !walletConnected
                  ? 'linear-gradient(135deg, #6366f1, #7c3aed)'
                  : disabled
                  ? '#1a1f2e'
                  : showGreen
                  ? 'linear-gradient(135deg, #16a34a, #15803d)'
                  : 'linear-gradient(135deg, #6366f1, #7c3aed)',
                color: disabled && walletConnected ? '#565b68' : 'white',
                fontSize: '16px',
                fontWeight: 600,
                cursor: (disabled && walletConnected) ? 'not-allowed' : 'pointer',
                letterSpacing: '-0.2px',
                transition: 'all 0.15s ease',
              }}
            >
              {label}
            </button>
          );
        })()}

        {/* Connected wallet indicator */}
        {walletConnected && walletAddress && (
          <div style={{ textAlign: 'center', marginTop: '8px', fontSize: '12px', color: '#565b68' }}>
            Connected: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
          </div>
        )}
      </div>
    </div>
  );
}

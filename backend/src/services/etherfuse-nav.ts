/**
 * Issuer-direct NAV for the Etherfuse stablebonds (USTRY, CETES, TESOURO,
 * EUROB, GILTS, KTB). Etherfuse publishes, without a key:
 *
 *   GET https://api.etherfuse.com/lookup/tokens/cost
 *     { USTRY: { token_cost_in_usd, token_cost_in_fiat, currency,
 *                current_basis_points, current_time, sources{...} }, … }
 *   GET https://api.etherfuse.com/lookup/stablebonds
 *     { stablebonds: [{ symbol, blockchains: [{ blockchain: "stellar",
 *                       tokenIdentifier: "USTRY-G…" }] }] }
 *
 * This is the price the issuer mints and redeems at — the "at NAV" the
 * RFQ is meant to deliver. It sits beside the oracle reading (RedStone),
 * which is what the contract enforces, so a taker sees both and any gap
 * between them. Cached; one fetch per TTL; never throws.
 */

export interface IssuerNav {
  symbol: string;
  usd: number;
  fiat: number;
  currency: string;
  /** Issuer-reported current yield, bps (informational). */
  yieldBps: number | null;
  /** Issuer's timestamp, seconds since epoch. */
  timestamp: number;
  /** Stellar classic issuer the bond is bound to, when the lookup lists one. */
  stellarIssuer: string | null;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

const COST_URL = 'https://api.etherfuse.com/lookup/tokens/cost';
const BONDS_URL = 'https://api.etherfuse.com/lookup/stablebonds';

export class EtherfuseNavService {
  private cache: { at: number; bySymbol: Map<string, IssuerNav> } | null = null;
  private inflight: Promise<Map<string, IssuerNav>> | null = null;

  constructor(
    private opts: { ttlMs?: number; timeoutMs?: number; fetchImpl?: FetchLike } = {}
  ) {}

  /** Issuer NAV for a symbol (case-insensitive), or null if Etherfuse
   *  doesn't list it. `issuer` (classic G… address), when given, must
   *  match the issuer Etherfuse binds the bond to on Stellar. */
  async lookup(symbol: string, issuer?: string | null): Promise<IssuerNav | null> {
    const map = await this.table();
    const hit = map.get(symbol.toUpperCase()) ?? null;
    if (!hit) return null;
    if (issuer && hit.stellarIssuer && hit.stellarIssuer !== issuer) return null;
    return hit;
  }

  symbols(): string[] {
    return this.cache ? [...this.cache.bySymbol.keys()] : [];
  }

  private async table(): Promise<Map<string, IssuerNav>> {
    const ttl = this.opts.ttlMs ?? 5 * 60_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.bySymbol;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh()
      .then((m) => {
        this.cache = { at: Date.now(), bySymbol: m };
        return m;
      })
      .catch(() => this.cache?.bySymbol ?? new Map())
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async get(url: string): Promise<any> {
    const f = this.opts.fetchImpl ?? (fetch as unknown as FetchLike);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 6_000);
    try {
      const res = await f(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`etherfuse ${url}: not ok`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  private async refresh(): Promise<Map<string, IssuerNav>> {
    const [cost, bonds] = await Promise.all([
      this.get(COST_URL),
      this.get(BONDS_URL).catch(() => null),
    ]);
    const issuers = new Map<string, string>();
    for (const b of bonds?.stablebonds ?? []) {
      const st = (b.blockchains ?? []).find((c: any) => c.blockchain === 'stellar');
      const id = String(st?.tokenIdentifier ?? '');
      const m = id.match(/^([A-Za-z0-9]{1,12})-(G[A-Z2-7]{55})$/);
      if (m) issuers.set(String(b.symbol).toUpperCase(), m[2]);
    }
    const out = new Map<string, IssuerNav>();
    for (const [key, v] of Object.entries<any>(cost ?? {})) {
      const usd = Number(v?.token_cost_in_usd);
      if (!(usd > 0)) continue;
      const symbol = String(v.token_symbol ?? key).toUpperCase();
      const ts = Date.parse(String(v.current_time ?? ''));
      out.set(symbol, {
        symbol,
        usd,
        fiat: Number(v.token_cost_in_fiat) || usd,
        currency: String(v.currency ?? 'USD'),
        yieldBps: Number.isFinite(Number(v.current_basis_points)) ? Number(v.current_basis_points) : null,
        timestamp: Number.isFinite(ts) ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000),
        stellarIssuer: issuers.get(symbol) ?? null,
      });
    }
    return out;
  }
}

/**
 * Token Discovery Service
 *
 * Aggregates the tradeable token universe from venue liquidity instead of
 * a purely hardcoded list: any token with a real pool on Aqua or
 * SushiSwap-on-Stellar shows up in the aggregator UI automatically,
 * pointing at that venue's liquidity.
 *
 * Sources:
 *   Aqua pools API — GET {aquaApiUrl}/pools/?page=N&size=M
 *   Sushi data API — POST {sushiGraphqlUrl} query { stellarPools(chainId: -4) }
 *     (the same GraphQL endpoint sushi.com's own frontend uses; carries
 *     token symbol/name/DECIMALS — Sushi lists 18-decimal Soroban tokens
 *     like deJTRSY/deJAAA that never appear on Aqua)
 *   Each pool carries tokens_addresses (SACs), tokens_str ("CODE:ISSUER"
 *   or "native"), index (pool hash for swap_chained), address (pool
 *   contract for estimate_swap), tx_count and total_volume.
 *
 * Anti-spoof rules for the merged list:
 *   - Curated registry entries always win and are marked verified.
 *   - A curated entry with a known issuer but empty SAC gets its SAC
 *     auto-filled when a discovered token matches code AND issuer.
 *   - A discovered token whose code collides with a curated symbol but
 *     whose issuer differs is DROPPED (classic fake-USDC spam).
 *   - Pools below the tx-count floor are ignored entirely.
 */

import { TOKENS, TokenConfig } from '../stellar/tokens.js';

export interface SushiPool {
  poolAddress: string;
  /** V3 fee in parts-per-million (500 / 3000 / 10000) */
  fee: number;
  liquidityUsd: number;
  volumeUsd1d: number;
  tokenA: string;
  tokenB: string;
  decimalsA: number;
  decimalsB: number;
}

export interface AquaPool {
  poolHash: string;
  poolAddress: string;
  tokenAddresses: string[];
  tokenStrs: string[];
  poolType: string;
  fee: string;
  txCount: number;
  totalVolume: number;
}

export interface AggregatedToken {
  symbol: string;
  name: string;
  issuer: string;
  sacAddress: string;
  decimals: number;
  /** Curated tokens only: the issuer's SEP-1 home domain */
  homeDomain?: string;
  status: 'live' | 'coming_soon';
  /** Where this listing came from */
  source: 'curated' | 'aqua' | 'sushi';
  /** Curated entries are verified; venue-discovered ones are not */
  verified: boolean;
  /**
   * Aggregate venue volume across all pools containing this token
   * (Aqua's lifetime total_volume units). Free byproduct of the pool
   * sweep — used by the UI to rank the "hot" tokens first without any
   * extra queries.
   */
  venueVolume: number;
}

export class TokenDiscoveryService {
  private aquaApiUrl: string;
  private sushiGraphqlUrl: string;
  private intervalMs: number;
  private minTxCount: number;
  private minSushiLiquidityUsd: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pools: AquaPool[] = [];
  private sushiPools: SushiPool[] = [];
  /** sacAddress -> discovered token */
  private discovered: Map<string, AggregatedToken> = new Map();
  private lastRefresh: Date | null = null;

  constructor(opts: {
    aquaApiUrl: string;
    /** Sushi data GraphQL endpoint ('' disables Sushi discovery) */
    sushiGraphqlUrl?: string;
    /** Refresh interval (default: 10 min) */
    intervalMs?: number;
    /** Ignore Aqua pools with fewer transactions than this (spam floor) */
    minTxCount?: number;
    /** Ignore Sushi pools below this USD liquidity (spam floor, default $500) */
    minSushiLiquidityUsd?: number;
  }) {
    this.aquaApiUrl = opts.aquaApiUrl.replace(/\/$/, '');
    this.sushiGraphqlUrl = (opts.sushiGraphqlUrl ?? '').replace(/\/$/, '');
    this.intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
    this.minTxCount = opts.minTxCount ?? 10;
    this.minSushiLiquidityUsd = opts.minSushiLiquidityUsd ?? 500;
  }

  start(): void {
    console.log('[Discovery] Starting token discovery service');
    console.log(`[Discovery] Source: ${this.aquaApiUrl}/pools/ (min tx count: ${this.minTxCount})`);
    this.refresh().catch((err) =>
      console.error('[Discovery] Initial refresh failed:', err)
    );
    this.timer = setInterval(() => {
      this.refresh().catch((err) =>
        console.error('[Discovery] Refresh failed:', err)
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The merged token universe: curated registry first (verified), then
   * venue-discovered tokens that pass the anti-spoof rules.
   */
  getTokens(): AggregatedToken[] {
    const volumeBySac = this.volumeBySac();
    const curated: AggregatedToken[] = Object.values(TOKENS).map((t) => {
      const sac = t.sacAddress || this.autoFillSac(t) || '';
      return {
        symbol: t.symbol,
        name: t.name,
        issuer: t.issuer,
        sacAddress: sac,
        decimals: t.decimals,
        homeDomain: t.homeDomain,
        status: t.status,
        source: 'curated' as const,
        verified: true,
        venueVolume: volumeBySac.get(sac) ?? 0,
      };
    });

    const curatedSymbols = new Set(curated.map((t) => t.symbol.toUpperCase()));
    const curatedSacs = new Set(curated.map((t) => t.sacAddress).filter(Boolean));

    const extras: AggregatedToken[] = [];
    const bySymbol = new Map<string, AggregatedToken>();
    for (const token of this.discovered.values()) {
      if (curatedSacs.has(token.sacAddress)) continue; // already curated
      if (curatedSymbols.has(token.symbol.toUpperCase())) continue; // spoof guard
      const cand = { ...token, venueVolume: volumeBySac.get(token.sacAddress) ?? 0 };
      // The symbol is the app-wide identifier (selection, balances,
      // quoting) — duplicate symbols from different issuers are
      // AMBIGUOUS, not just ugly. Keep the highest-volume claimant.
      const prev = bySymbol.get(cand.symbol.toUpperCase());
      if (!prev || cand.venueVolume > prev.venueVolume) {
        bySymbol.set(cand.symbol.toUpperCase(), cand);
      }
    }
    extras.push(...bySymbol.values());
    extras.sort((a, b) => a.symbol.localeCompare(b.symbol));

    return [...curated, ...extras];
  }

  /** Sum pool volumes per token SAC (pools below the spam floor excluded). */
  private volumeBySac(): Map<string, number> {
    const map = new Map<string, number>();
    for (const pool of this.pools) {
      if (pool.txCount < this.minTxCount) continue;
      for (const sac of pool.tokenAddresses) {
        map.set(sac, (map.get(sac) ?? 0) + (pool.totalVolume || 0));
      }
    }
    return map;
  }

  /** All discovered Aqua pools (spam floor applied) — pathfinder graph. */
  getAquaPools(): AquaPool[] {
    return this.pools.filter((p) => p.txCount >= this.minTxCount);
  }

  /**
   * Best Sushi pool per discovered pair (highest USD liquidity), for the
   * Sushi venue adapter's dynamic pair table.
   */
  getSushiPairs(): Array<{
    tokenA: string;
    tokenB: string;
    pool: string;
    fee: number;
    decimalsA: number;
    decimalsB: number;
    liquidityUsd: number;
  }> {
    const best = new Map<string, SushiPool>();
    for (const p of this.sushiPools) {
      const key = [p.tokenA, p.tokenB].sort().join('|');
      const prev = best.get(key);
      if (!prev || p.liquidityUsd > prev.liquidityUsd) best.set(key, p);
    }
    return Array.from(best.values()).map((p) => ({
      tokenA: p.tokenA,
      tokenB: p.tokenB,
      pool: p.poolAddress,
      fee: p.fee,
      decimalsA: p.decimalsA,
      decimalsB: p.decimalsB,
      liquidityUsd: p.liquidityUsd,
    }));
  }

  /** All discovered pools containing both SACs (for adapter registration/quotes). */
  getPoolsForPair(sacA: string, sacB: string): AquaPool[] {
    return this.pools.filter(
      (p) => p.tokenAddresses.includes(sacA) && p.tokenAddresses.includes(sacB)
    );
  }

  getStatus(): { pools: number; sushiPools: number; discovered: number; lastRefresh: string | null } {
    return {
      pools: this.pools.length,
      sushiPools: this.sushiPools.length,
      discovered: this.discovered.size,
      lastRefresh: this.lastRefresh?.toISOString() ?? null,
    };
  }

  // ─── Internal ───────────────────────────────────────

  /** Fill a curated token's missing SAC from discovery iff issuer matches. */
  private autoFillSac(curated: TokenConfig): string | undefined {
    if (!curated.issuer) return undefined;
    for (const [sac, token] of this.discovered) {
      if (
        token.symbol.toUpperCase() === curated.symbol.toUpperCase() &&
        token.issuer === curated.issuer
      ) {
        return sac;
      }
    }
    return undefined;
  }

  private async refresh(): Promise<void> {
    // Each source keeps its previous snapshot on failure — one venue's
    // API outage never blanks the other's tokens.
    await Promise.all([
      this.refreshAqua().catch((err) =>
        console.warn('[Discovery] Aqua refresh failed:', err)
      ),
      this.refreshSushi().catch((err) =>
        console.warn('[Discovery] Sushi refresh failed:', err)
      ),
    ]);
    this.lastRefresh = new Date();
  }

  /** Sushi pool sweep via the stellarPools GraphQL query (chainId -4). */
  private async refreshSushi(): Promise<void> {
    if (!this.sushiGraphqlUrl) return;
    const res = await fetch(this.sushiGraphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        query:
          'query SP($c: ChainId!) { stellarPools(chainId: $c) { address swapFee liquidityUSD volumeUSD1d ' +
          'token0 { address symbol name decimals } token1 { address symbol name decimals } } }',
        variables: { c: -4 },
      }),
    });
    if (!res.ok) {
      console.warn(`[Discovery] Sushi GraphQL returned ${res.status}`);
      return;
    }
    const body = (await res.json()) as {
      data?: {
        stellarPools?: Array<{
          address: string;
          swapFee: number;
          liquidityUSD: number;
          volumeUSD1d: number;
          token0: { address: string; symbol: string; name: string; decimals: number };
          token1: { address: string; symbol: string; name: string; decimals: number };
        }>;
      };
      errors?: unknown;
    };
    const raw = body.data?.stellarPools;
    if (!raw) {
      console.warn('[Discovery] Sushi GraphQL: no stellarPools in response', body.errors ?? '');
      return;
    }

    const pools: SushiPool[] = [];
    const discovered = new Map<string, AggregatedToken>();
    for (const p of raw) {
      if ((p.liquidityUSD ?? 0) < this.minSushiLiquidityUsd) continue;
      pools.push({
        poolAddress: p.address,
        fee: Math.round((p.swapFee ?? 0) * 1_000_000), // 0.0005 -> 500
        liquidityUsd: p.liquidityUSD ?? 0,
        volumeUsd1d: p.volumeUSD1d ?? 0,
        tokenA: p.token0.address,
        tokenB: p.token1.address,
        decimalsA: p.token0.decimals ?? 7,
        decimalsB: p.token1.decimals ?? 7,
      });
      for (const t of [p.token0, p.token1]) {
        if (!t.address || discovered.has(t.address)) continue;
        if (!t.symbol || t.symbol.length > 32) continue;
        discovered.set(t.address, {
          symbol: t.symbol,
          name: t.name || t.symbol,
          issuer: '',
          sacAddress: t.address,
          decimals: t.decimals ?? 7,
          status: 'live',
          source: 'sushi',
          verified: false,
          venueVolume: 0,
        });
      }
    }

    this.sushiPools = pools;
    // Merge into the discovered map (Aqua entries win on SAC collision —
    // they carry issuer info; anti-spoof vs curated happens in getTokens)
    for (const [sac, token] of discovered) {
      if (!this.discovered.has(sac)) this.discovered.set(sac, token);
    }
    console.log(
      `[Discovery] Sushi: ${pools.length} pools (>= $${this.minSushiLiquidityUsd} liq) -> ${discovered.size} tokens`
    );
  }

  private async refreshAqua(): Promise<void> {
    const pools: AquaPool[] = [];
    // Aqua serves small pages regardless of the size param — follow the
    // `next` links with a generous page cap.
    let url: string | null = `${this.aquaApiUrl}/pools/?size=100`;
    let pages = 0;
    let expectedCount = 0;

    while (url && pages < 100) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        console.warn(`[Discovery] Aqua pools API returned ${response.status}`);
        return; // keep the previous snapshot
      }
      const data = (await response.json()) as {
        count?: number;
        next: string | null;
        results: Array<{
          index: string;
          address: string;
          tokens_addresses: string[];
          tokens_str: string[];
          pool_type: string;
          fee: string;
          tx_count: number | null;
          total_volume: number | null;
        }>;
      };

      for (const raw of data.results ?? []) {
        pools.push({
          poolHash: raw.index,
          poolAddress: raw.address,
          tokenAddresses: raw.tokens_addresses ?? [],
          tokenStrs: raw.tokens_str ?? [],
          poolType: raw.pool_type,
          fee: raw.fee,
          txCount: raw.tx_count ?? 0,
          totalVolume: raw.total_volume ?? 0,
        });
      }
      expectedCount = data.count ?? expectedCount;
      url = data.next;
      pages++;
    }

    if (expectedCount > 0 && pools.length < expectedCount) {
      console.warn(
        `[Discovery] Partial pool sweep: ${pools.length}/${expectedCount} (page cap hit)`
      );
    }

    const discovered = new Map<string, AggregatedToken>();
    for (const pool of pools) {
      if (pool.txCount < this.minTxCount) continue;
      for (let i = 0; i < pool.tokenAddresses.length; i++) {
        const sac = pool.tokenAddresses[i];
        if (!sac || discovered.has(sac)) continue;
        const parsed = this.parseTokenStr(pool.tokenStrs[i] ?? '');
        if (!parsed) continue;
        discovered.set(sac, {
          ...parsed,
          sacAddress: sac,
          decimals: 7,
          status: 'live',
          source: 'aqua',
          verified: false,
          venueVolume: 0, // filled from the pool sweep in getTokens()
        });
      }
    }

    this.pools = pools;
    // Rebuild: fresh Aqua entries replace stale ones; Sushi-only tokens
    // survive (Sushi's own refresh keeps them current).
    const merged = new Map<string, AggregatedToken>(discovered);
    for (const [sac, token] of this.discovered) {
      if (token.source === 'sushi' && !merged.has(sac)) merged.set(sac, token);
    }
    this.discovered = merged;
    console.log(
      `[Discovery] Aqua: ${pools.length} pools -> ${discovered.size} tokens (>=${this.minTxCount} txs)`
    );
  }

  /** tokens_str is "native", "CODE:ISSUER", or a display name. */
  private parseTokenStr(
    str: string
  ): { symbol: string; name: string; issuer: string } | null {
    if (str === 'native') {
      return { symbol: 'XLM', name: 'Stellar Lumens', issuer: '' };
    }
    const parts = str.split(':');
    if (parts.length === 2 && /^G[A-Z2-7]{55}$/.test(parts[1])) {
      return {
        symbol: parts[0],
        name: `${parts[0]} (${parts[1].slice(0, 4)}…${parts[1].slice(-4)})`,
        issuer: parts[1],
      };
    }
    // Soroban-native tokens surface as a bare display name
    if (str.length > 0 && str.length <= 32) {
      return { symbol: str.replace(/\s+/g, ''), name: str, issuer: '' };
    }
    return null;
  }
}

/**
 * Multi-hop pathfinder — the aggregator's core promise: if a route
 * exists across pools, find it and fill at the best rate.
 *
 * How it works, per quote:
 *   1. GRAPH   — edges are discovered pools (Aqua + Sushi), weighted by a
 *                liquidity proxy (Sushi liquidityUSD / Aqua lifetime volume).
 *   2. SEARCH  — DFS from tokenIn to tokenOut, up to MAX_HOPS swaps, no
 *                token revisits, branching capped to the most-liquid
 *                neighbors so 300+ pools stay tractable.
 *   3. RANK    — candidate paths are ordered by the product of cached
 *                per-edge spot rates (probed with 1-token estimate_swap
 *                simulations, 5-min TTL, lazily and concurrently).
 *   4. VERIFY  — the top candidates are quoted FOR REAL, hop by hop,
 *                through the routing engine (each hop still gets
 *                best-venue split treatment). Chained conservatively:
 *                hop N+1 is sized from hop N's slippage-protected minimum.
 *   5. COMPARE — the best path competes with the direct route; the
 *                higher net output wins. Multi-hop is a competitor, not
 *                a fallback.
 *
 * Execution: N hops = N Router transactions, returned in the blend shape
 * the frontend already signs sequentially, each leg min-out protected.
 * Atomic single-tx chains (Aqua swap_chained) are the v1.2 contract item.
 */

import { RoutingEngine } from './engine.js';
import { StellarClient } from '../stellar/client.js';
import { TokenDiscoveryService } from '../services/token-discovery.js';

const MAX_HOPS = parseInt(process.env.PATHFINDER_MAX_HOPS ?? '5');
const BRANCH_CAP = parseInt(process.env.PATHFINDER_BRANCH_CAP ?? '6');
const CANDIDATE_CAP = parseInt(process.env.PATHFINDER_CANDIDATES ?? '40');
const VERIFY_TOP = parseInt(process.env.PATHFINDER_VERIFY_TOP ?? '4');
const RATE_TTL_MS = 5 * 60 * 1000;
const PROBE_CONCURRENCY = 8;
/** Wall-clock budget for one bestRoute call (quote UX latency cap). */
const SEARCH_BUDGET_MS = parseInt(process.env.PATHFINDER_BUDGET_MS ?? '6000');

export interface LiquidityEdge {
  a: string;
  b: string;
  venue: 'aqua' | 'sushi';
  pool: string;
  /** In-venue units; only compared within the same venue for pruning */
  liquidityProxy: number;
  /** estimate_swap token indexes (aqua); sushi handled by the engine */
  tokens?: string[];
}

export interface HopQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** slippage-protected minimum handed to the next hop / min_total_out */
  minOut: bigint;
  route: Awaited<ReturnType<RoutingEngine['computeRoute']>>;
}

export interface PathResult {
  /** token chain, length hops+1, [tokenIn, ..., tokenOut] */
  path: string[];
  hops: HopQuote[];
  netAmountOut: bigint;
}

const RESULT_TTL_MS = 15_000;

export class Pathfinder {
  /** "pool|dir" -> { rate: out-per-in scaled 1e9, ts } */
  private rateCache = new Map<string, { rate: number; ts: number }>();
  /** short-lived full-result memo — repeat keystrokes and the follow-up
   *  build call reuse the same search instead of re-running it */
  private resultCache = new Map<
    string,
    { ts: number; val: { direct: any; multi: PathResult | null } }
  >();

  constructor(
    private discovery: TokenDiscoveryService,
    private engine: RoutingEngine,
    private stellar: StellarClient,
    private decimalsForSac: (sac: string) => number
  ) {}

  /** All liquidity edges from discovery (rebuilt per call — cheap). */
  private edges(): LiquidityEdge[] {
    const out: LiquidityEdge[] = [];
    for (const p of this.discovery.getAquaPools()) {
      if (p.tokenAddresses.length < 2) continue;
      // pairwise edges within the pool (2-token pools dominate)
      for (let i = 0; i < p.tokenAddresses.length; i++) {
        for (let j = i + 1; j < p.tokenAddresses.length; j++) {
          out.push({
            a: p.tokenAddresses[i],
            b: p.tokenAddresses[j],
            venue: 'aqua',
            pool: p.poolAddress,
            liquidityProxy: p.totalVolume || 0,
            tokens: p.tokenAddresses,
          });
        }
      }
    }
    for (const p of this.discovery.getSushiPairs()) {
      out.push({
        a: p.tokenA,
        b: p.tokenB,
        venue: 'sushi',
        pool: p.pool,
        liquidityProxy: 1, // sushi pairs pre-filtered by USD floor
      });
    }
    return out;
  }

  /** neighbor map: token -> edges, each list pruned to the top BRANCH_CAP */
  private adjacency(edges: LiquidityEdge[]): Map<string, LiquidityEdge[]> {
    const adj = new Map<string, LiquidityEdge[]>();
    for (const e of edges) {
      for (const t of [e.a, e.b]) {
        if (!adj.has(t)) adj.set(t, []);
        adj.get(t)!.push(e);
      }
    }
    for (const [t, list] of adj) {
      list.sort((x, y) => (y.liquidityProxy || 0) - (x.liquidityProxy || 0));
      adj.set(t, list.slice(0, BRANCH_CAP));
    }
    return adj;
  }

  /** DFS: token chains from tokenIn to tokenOut, ≤ MAX_HOPS edges. */
  private candidatePaths(tokenIn: string, tokenOut: string): string[][] {
    const adj = this.adjacency(this.edges());
    const results: string[][] = [];
    const walk = (node: string, path: string[]) => {
      if (results.length >= CANDIDATE_CAP) return;
      if (path.length - 1 >= MAX_HOPS) return;
      for (const e of adj.get(node) ?? []) {
        const next = e.a === node ? e.b : e.a;
        if (path.includes(next)) continue;
        if (next === tokenOut) {
          results.push([...path, next]);
          if (results.length >= CANDIDATE_CAP) return;
          continue;
        }
        walk(next, [...path, next]);
      }
    };
    walk(tokenIn, [tokenIn]);
    // direct pair (1 hop) is handled by the engine's own direct route —
    // drop it from candidates to avoid double work
    return results.filter((p) => p.length > 2);
  }

  /** Cached spot rate for one directed pair (best pool), 1e9-scaled. */
  private async spotRate(tin: string, tout: string): Promise<number> {
    const key = `${tin}|${tout}`;
    const hit = this.rateCache.get(key);
    if (hit && Date.now() - hit.ts < RATE_TTL_MS) return hit.rate;

    let rate = 0;
    const probeIn = 10n ** BigInt(this.decimalsForSac(tin)); // 1 whole token
    const allPools = this.discovery
      .getPoolsForPair(tin, tout)
      .sort((x, y) => (y.totalVolume || 0) - (x.totalVolume || 0));
    const pools = allPools.slice(0, 2);
    for (const p of pools) {
      const inIdx = p.tokenAddresses.indexOf(tin);
      const outIdx = p.tokenAddresses.indexOf(tout);
      if (inIdx < 0 || outIdx < 0) continue;
      try {
        const est = await this.stellar.simulateAndParse<bigint>(
          p.poolAddress,
          'estimate_swap',
          [
            StellarClient.toU32(inIdx),
            StellarClient.toU32(outIdx),
            StellarClient.toU128(probeIn),
          ]
        );
        if (est && BigInt(est) > 0n) {
          const outScaled =
            Number(BigInt(est)) / 10 ** this.decimalsForSac(tout);
          rate = outScaled; // out per 1 whole token in
        }
      } catch {
        /* try the next pool */
      }
      if (rate > 0) break;
    }
    if (rate === 0 && allPools.length > 0) {
      // Pools EXIST but the probe failed (throttled RPC, exotic pool
      // type). Rank the edge last but keep it verifiable — pruning here
      // is how a transient sim failure turned into a worse route.
      rate = 1e-9;
    }
    if (rate === 0) {
      // sushi edge (or aqua probe failed): neutral rank so the path is
      // still verifiable, just not preferred by the heuristic
      const sushi = this.discovery
        .getSushiPairs()
        .some((p) => (p.tokenA === tin && p.tokenB === tout) || (p.tokenA === tout && p.tokenB === tin));
      if (sushi) rate = 1;
    }
    this.rateCache.set(key, { rate, ts: Date.now() });
    return rate;
  }

  /** Rank paths by Σ log(edge spot rate); prunes zero-rate paths. */
  private async rankPaths(paths: string[][]): Promise<string[][]> {
    // lazily probe all needed edges with bounded concurrency
    const pairs = new Set<string>();
    for (const p of paths)
      for (let i = 0; i < p.length - 1; i++) pairs.add(`${p[i]}|${p[i + 1]}`);
    const list = [...pairs];
    for (let i = 0; i < list.length; i += PROBE_CONCURRENCY) {
      await Promise.all(
        list.slice(i, i + PROBE_CONCURRENCY).map((k) => {
          const [a, b] = k.split('|');
          return this.spotRate(a, b);
        })
      );
    }
    const scored = await Promise.all(
      paths.map(async (p) => {
        let score = 0;
        for (let i = 0; i < p.length - 1; i++) {
          const r = await this.spotRate(p[i], p[i + 1]); // cached
          if (r <= 0) return { p, score: -Infinity };
          score += Math.log(r);
        }
        return { p, score };
      })
    );
    return scored
      .filter((s) => s.score > -Infinity)
      .sort((x, y) => y.score - x.score)
      .slice(0, VERIFY_TOP)
      .map((s) => s.p);
  }

  /** Real hop-by-hop quote of one path; null if any hop has no route. */
  async quotePath(
    path: string[],
    amountIn: bigint,
    slippageBps: number
  ): Promise<PathResult | null> {
    const hops: HopQuote[] = [];
    let amt = amountIn;
    for (let i = 0; i < path.length - 1; i++) {
      const tin = path[i];
      const tout = path[i + 1];
      const route = await this.engine.computeRoute(
        tin, tout, amt, slippageBps,
        { executableOnly: true },
        { in: this.decimalsForSac(tin), out: this.decimalsForSac(tout) }
      );
      if (route.segments.length === 0 || route.netAmountOut <= 0n) return null;
      const minOut = (route.netAmountOut * BigInt(10000 - slippageBps)) / 10000n;
      if (minOut <= 0n) return null;
      hops.push({ tokenIn: tin, tokenOut: tout, amountIn: amt, minOut, route });
      amt = minOut; // conservative chaining — the plan is exactly executable
    }
    return { path, hops, netAmountOut: hops[hops.length - 1].route.netAmountOut };
  }

  /**
   * Best execution across direct AND multi-hop, by net output.
   * Returns { direct, multi } — caller picks (multi wins only if strictly
   * better, so equal-rate ties keep the simpler single-tx plan).
   */
  async bestRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    slippageBps: number
  ): Promise<{
    direct: Awaited<ReturnType<RoutingEngine['computeRoute']>>;
    multi: PathResult | null;
  }> {
    const cacheKey = `${tokenIn}|${tokenOut}|${amountIn}|${slippageBps}`;
    const hit = this.resultCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < RESULT_TTL_MS) return hit.val;

    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const direct = await this.engine.computeRoute(
      tokenIn, tokenOut, amountIn, slippageBps,
      { executableOnly: true },
      { in: this.decimalsForSac(tokenIn), out: this.decimalsForSac(tokenOut) }
    );

    let multi: PathResult | null = null;
    try {
      const candidates = this.candidatePaths(tokenIn, tokenOut);
      if (candidates.length > 0 && Date.now() < deadline) {
        const ranked = await this.rankPaths(candidates);
        // Verify all finalists CONCURRENTLY — paths are independent, so
        // wall-clock is the slowest path, not the sum of all of them.
        const quoted = await Promise.all(
          ranked.map((p) =>
            Date.now() < deadline
              ? this.quotePath(p, amountIn, slippageBps).catch(() => null)
              : Promise.resolve(null)
          )
        );
        for (const q of quoted) {
          if (q && (!multi || q.netAmountOut > multi.netAmountOut)) multi = q;
        }
      }
    } catch (err) {
      console.warn('[Pathfinder] search failed, direct-only:', err);
    }
    const val = { direct, multi };
    this.resultCache.set(cacheKey, { ts: Date.now(), val });
    if (this.resultCache.size > 500) {
      // drop expired entries opportunistically
      for (const [k, v] of this.resultCache) {
        if (Date.now() - v.ts >= RESULT_TTL_MS) this.resultCache.delete(k);
      }
    }
    return val;
  }
}

/**
 * Multi-hop pathfinder — the aggregator's core promise: if a route
 * exists across pools, find it and fill at the best rate.
 *
 * How it works, per quote:
 *   1. GRAPH   — edges are discovered pools (Aqua + Sushi), weighted by a
 *                liquidity proxy (Sushi liquidityUSD / Aqua lifetime volume).
 *   2. SEARCH  — DFS from tokenIn to tokenOut, up to MAX_HOPS swaps, no
 *                token revisits; per node the top-liquidity Aqua edges
 *                plus ALL Sushi edges (few, pre-filtered by USD floor).
 *   3. RANK    — ZERO simulations: fewest hops first, then the sum of
 *                log-liquidity along the path. (A probe-based ranker was
 *                tried and retired: its simulation burst starved the
 *                verification phase's time budget on slow RPCs, so the
 *                search returned nothing precisely when it mattered.)
 *   4. VERIFY  — the top candidates are quoted FOR REAL, hop by hop,
 *                through the routing engine (each hop still gets
 *                best-venue split treatment). Chained conservatively:
 *                hop N+1 is sized from hop N's slippage-protected minimum.
 *                The best-ranked path is ALWAYS verified to completion —
 *                the budget can trim breadth, never blind the search.
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
/** Wall-clock budget for one bestRoute call (quote UX latency cap). */
const SEARCH_BUDGET_MS = parseInt(process.env.PATHFINDER_BUDGET_MS ?? '8000');

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
        liquidityProxy: p.liquidityUsd,
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
      const aqua = list
        .filter((e) => e.venue === 'aqua')
        .sort((x, y) => (y.liquidityProxy || 0) - (x.liquidityProxy || 0))
        .slice(0, BRANCH_CAP);
      const sushi = list.filter((e) => e.venue === 'sushi');
      adj.set(t, [...aqua, ...sushi]);
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

  /**
   * Rank candidate paths WITHOUT simulations: fewest hops first, then
   * the highest liquidity along the path (sum of per-edge log-liquidity,
   * each edge scored by its best pool in either venue's own units —
   * crude across venues, but real quoting decides the final winner).
   */
  private rankPaths(paths: string[][]): string[][] {
    const adj = this.adjacency(this.edges());
    const edgeScore = (a: string, b: string): number => {
      let best = 0;
      for (const e of adj.get(a) ?? []) {
        const other = e.a === a ? e.b : e.a;
        if (other === b) best = Math.max(best, e.liquidityProxy || 0);
      }
      return best;
    };
    const scored = paths.map((p) => {
      let liq = 0;
      for (let i = 0; i < p.length - 1; i++) {
        const s = edgeScore(p[i], p[i + 1]);
        if (s <= 0) return { p, hops: p.length, liq: -Infinity };
        liq += Math.log(s + 1);
      }
      return { p, hops: p.length, liq };
    });
    return scored
      .filter((s) => s.liq > -Infinity)
      .sort((x, y) => x.hops - y.hops || y.liq - x.liq)
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
      if (process.env.PATHFINDER_DEBUG) {
        console.log(`[pf] hop ${tin.slice(0,4)}->${tout.slice(0,4)} in=${amt} out=${route.netAmountOut} segs=${route.segments.map((s) => `${s.venueName}:${s.amountIn}->${s.expectedAmountOut}`).join('|')}`);
      }
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
      if (candidates.length > 0) {
        const ranked = this.rankPaths(candidates);
        // Verify finalists CONCURRENTLY. The BEST-ranKED path always
        // runs to completion; the budget only trims the alternatives —
        // a slow RPC can narrow the search, never blind it.
        const quoted = await Promise.all(
          ranked.map((p, i) =>
            i === 0 || Date.now() < deadline
              ? this.quotePath(p, amountIn, slippageBps).catch(() => null)
              : Promise.resolve(null)
          )
        );
        for (const q of quoted) {
          if (q && (!multi || q.netAmountOut > multi.netAmountOut)) multi = q;
        }
        if (!multi && ranked.length > 0) {
          console.warn(
            `[Pathfinder] ${ranked.length} ranked paths for ${tokenIn.slice(0, 6)}→${tokenOut.slice(0, 6)} all failed verification`
          );
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

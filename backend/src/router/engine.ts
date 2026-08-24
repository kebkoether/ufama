/**
 * Smart Order Routing Engine
 *
 * Computes optimal split routes across all registered DEX venues.
 *
 * Algorithm:
 * 1. Query each venue for quotes at increasing depth levels
 * 2. Build a marginal price curve for each venue
 * 3. Greedily allocate from cheapest marginal price across venues
 * 4. Output a route (list of segments) for the Router contract
 *
 * This is the same pattern used by 1inch, Paraswap, and other
 * DEX aggregators — compute off-chain, execute on-chain.
 */

import { VenueRegistry, VenueAdapter, DepthQuote, SwapInstruction } from '../venues/index.js';

/** Depth levels to query (in token units, 7 decimal places for Stellar) */
const DEPTH_LEVELS = [
  100_0000000n,      // $100
  1_000_0000000n,    // $1,000
  5_000_0000000n,    // $5,000
  10_000_0000000n,   // $10,000
  25_000_0000000n,   // $25,000
  50_000_0000000n,   // $50,000
  100_000_0000000n,  // $100,000
  500_000_0000000n,  // $500,000
];

export interface RouteSegment {
  venueName: string;
  venueId: number;
  amountIn: bigint;
  expectedAmountOut: bigint;
  effectiveBps: number;
}

export interface Route {
  tokenIn: string;
  tokenOut: string;
  totalAmountIn: bigint;
  totalExpectedOut: bigint;
  /** DEPRECATED for display: (amountIn − amountOut)/amountIn across
   *  different token units — only meaningful for 1:1-pegged pairs.
   *  For XLM→USDC this reads ~8150 "bps" of pure exchange rate. */
  blendedBps: number;
  /** True price impact in bps: execution rate vs the best small-size
   *  ("spot") rate across venues. Unit-safe for any pair. */
  priceImpactBps: number;
  /** Protocol fee (0.5 bps) — only charged on the SwapBook P2P portion */
  protocolFee: bigint;
  /** How much of the output came from our SwapBook (P2P) */
  swapBookAmountOut: bigint;
  /** Net amount user receives after protocol fee */
  netAmountOut: bigint;
  segments: RouteSegment[];
  /** Swap instructions for the Router contract */
  instructions: SwapInstruction[];
}

interface VenueDepthProfile {
  adapter: VenueAdapter;
  /** Depth quotes sorted by amount */
  quotes: DepthQuote[];
  /** Interpolated marginal cost at each tranche */
  tranches: Tranche[];
}

interface Tranche {
  venueId: number;
  venueName: string;
  /** Start of this tranche (cumulative amount) */
  from: bigint;
  /** End of this tranche */
  to: bigint;
  /** Amount in this tranche */
  amount: bigint;
  /** Marginal bps cost in this tranche */
  marginalBps: number;
  /** Expected output for this tranche */
  expectedOut: bigint;
}

// Protocol fee per 100k of output — MUST mirror the deployed Router's
// get_fee (v1.1 defaults to ZERO; instant swaps are venue-fees-only).
// If set_fee is ever used on-chain, update ROUTER_FEE_PER_100K to match.
const FEE_NUMERATOR = BigInt(process.env.ROUTER_FEE_PER_100K ?? '0');
const FEE_DENOMINATOR = 100_000n;

export class RoutingEngine {
  constructor(private registry: VenueRegistry) {}

  /**
   * Compute the optimal route for a swap.
   *
   * @param tokenIn - SAC address of input token
   * @param tokenOut - SAC address of output token
   * @param amountIn - Total amount to swap (7 decimal places)
   * @param slippageBps - Maximum acceptable slippage in basis points
   * @param opts.executableOnly - Restrict to venues the on-chain Router can
   *   execute (required when the route becomes execute_route /
   *   route_expired_order segments). Quote-only callers may include all
   *   venues for display.
   */
  /** Optional token decimals (default 7/7) — only the informational
   *  bps fields need them; amounts are raw base units throughout. */
  async computeRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    slippageBps: number = 50, // default 0.5% slippage tolerance
    opts: { executableOnly?: boolean; includeClassicDex?: boolean } = {},
    decimals: { in: number; out: number } = { in: 7, out: 7 },
  ): Promise<Route> {
    // 1. Get all available venues
    let venues = await this.registry.getAvailable();
    if (opts.executableOnly) {
      // includeClassicDex keeps the SDEX (venue 3) in the allocation even
      // though it isn't Router-executable — used for blended execution,
      // where the SDEX portion becomes a separate classic transaction.
      venues = venues.filter(
        (v) => v.executable || (opts.includeClassicDex === true && v.venueId === 3)
      );
    }

    if (venues.length === 0) {
      throw new Error('No venues available');
    }

    // 2. Query depth quotes from all venues in parallel
    const depthLevels = DEPTH_LEVELS.filter((d) => d <= amountIn * 2n);
    if (!depthLevels.includes(amountIn)) {
      depthLevels.push(amountIn);
      depthLevels.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    const profiles = await Promise.all(
      venues.map(async (adapter) => {
        const quotes = await adapter.getDepthQuotes(
          tokenIn,
          tokenOut,
          depthLevels
        );
        const tranches = this.buildTranches(adapter, quotes, depthLevels);
        return { adapter, quotes, tranches } as VenueDepthProfile;
      })
    );

    // 3. Greedy allocation: fill from cheapest marginal price
    const segments = this.greedyAllocate(profiles, amountIn, decimals);

    // 4. Build route
    const totalExpectedOut = segments.reduce(
      (sum, s) => sum + s.expectedAmountOut,
      0n
    );

    // Protocol fee (0.5 bps) is charged on the TOTAL output, rounded up —
    // this must mirror the Router contract's calculate_fee exactly, or
    // min_total_out will be set above what the user can ever receive.
    const swapBookOut = segments
      .filter((s) => s.venueName === 'SwapBook')
      .reduce((sum, s) => sum + s.expectedAmountOut, 0n);
    const protocolFee =
      totalExpectedOut > 0n
        ? (totalExpectedOut * FEE_NUMERATOR + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR
        : 0n;
    const netAmountOut = totalExpectedOut - protocolFee;

    // Normalize the input to out-token decimals so the bps comparison is
    // unit-safe on mixed-decimal pairs (USDC 7dp vs deJAAA 18dp).
    const inScaled =
      decimals.out >= decimals.in
        ? amountIn * 10n ** BigInt(decimals.out - decimals.in)
        : amountIn / 10n ** BigInt(decimals.in - decimals.out);
    const blendedBps =
      inScaled > 0n
        ? Number(((inScaled - netAmountOut) * 10000n) / inScaled)
        : 0;

    // True price impact: execution rate vs the best small-size rate any
    // venue offers (the effective "spot"). Small residual noise from
    // ladder interpolation is clamped at 0.
    let spotRate = 0;
    for (const prof of profiles) {
      const q = prof.quotes[0];
      if (q && q.amountOut > 0n && q.amountIn > 0n) {
        const r = Number(q.amountOut) / Number(q.amountIn);
        if (r > spotRate) spotRate = r;
      }
    }
    const execRate = amountIn > 0n ? Number(totalExpectedOut) / Number(amountIn) : 0;
    const priceImpactBps =
      spotRate > 0 && execRate > 0
        ? Math.max(0, (1 - execRate / spotRate) * 10_000)
        : 0;

    // 5. Build on-chain swap instructions
    const instructions = await Promise.all(
      segments.map(async (seg) => {
        const adapter = venues.find((v) => v.venueId === seg.venueId)!;
        // Apply slippage to individual leg min_out
        const slippageMultiplier =
          BigInt(10000 - slippageBps);
        const minOut =
          (seg.expectedAmountOut * slippageMultiplier) / 10000n;
        return adapter.buildSwapInstruction(
          tokenIn,
          tokenOut,
          seg.amountIn,
          minOut
        );
      })
    );

    return {
      tokenIn,
      tokenOut,
      totalAmountIn: amountIn,
      totalExpectedOut,
      blendedBps,
      priceImpactBps,
      protocolFee,
      swapBookAmountOut: swapBookOut,
      netAmountOut,
      segments,
      instructions,
    };
  }

  /**
   * Build tranches from depth quotes.
   *
   * A tranche represents a range of amounts where the marginal cost
   * is approximately constant for a given venue.
   */
  private buildTranches(
    adapter: VenueAdapter,
    quotes: DepthQuote[],
    depthLevels: bigint[]
  ): Tranche[] {
    const tranches: Tranche[] = [];

    for (let i = 0; i < quotes.length; i++) {
      const from = i === 0 ? 0n : depthLevels[i - 1];
      const to = depthLevels[i];
      const amount = to - from;

      // Marginal output for this tranche
      const prevOut = i === 0 ? 0n : quotes[i - 1].amountOut;
      const marginalOut = quotes[i].amountOut - prevOut;
      const marginalBps =
        amount > 0n
          ? Number(((amount - marginalOut) * 10000n) / amount)
          : Infinity;

      tranches.push({
        venueId: adapter.venueId,
        venueName: adapter.name,
        from,
        to,
        amount,
        marginalBps,
        expectedOut: marginalOut,
      });
    }

    return tranches;
  }

  /**
   * Greedy allocation across venues.
   *
   * Collects all tranches from all venues, sorts by marginal cost,
   * and fills greedily until the total amount is allocated.
   */
  private greedyAllocate(
    profiles: VenueDepthProfile[],
    totalAmount: bigint,
    decimals: { in: number; out: number },
  ) {
    // Flatten all tranches and sort by marginal bps (cheapest first)
    const allTranches = profiles.flatMap((p) => p.tranches);
    allTranches.sort((a, b) => a.marginalBps - b.marginalBps);

    // Track how much we've allocated to each venue
    const venueAllocations = new Map<
      number,
      { amountIn: bigint; expectedOut: bigint; name: string }
    >();

    // Track how much of each venue's depth we've consumed
    const venueConsumed = new Map<number, bigint>();

    let remaining = totalAmount;

    for (const tranche of allTranches) {
      if (remaining <= 0n) break;
      if (tranche.marginalBps === Infinity) continue; // No liquidity

      // How much of this tranche can we use?
      const consumed = venueConsumed.get(tranche.venueId) ?? 0n;

      // Only use this tranche if we haven't already consumed past it
      if (consumed >= tranche.to) continue;

      const availableInTranche = tranche.to - (consumed > tranche.from ? consumed : tranche.from);
      const fillAmount = remaining < availableInTranche ? remaining : availableInTranche;

      if (fillAmount <= 0n) continue;

      // Pro-rate the expected output
      const expectedOut =
        tranche.amount > 0n
          ? (tranche.expectedOut * fillAmount) / tranche.amount
          : 0n;

      // Accumulate into venue allocation
      const existing = venueAllocations.get(tranche.venueId);
      if (existing) {
        existing.amountIn += fillAmount;
        existing.expectedOut += expectedOut;
      } else {
        venueAllocations.set(tranche.venueId, {
          amountIn: fillAmount,
          expectedOut,
          name: tranche.venueName,
        });
      }

      venueConsumed.set(
        tranche.venueId,
        (venueConsumed.get(tranche.venueId) ?? 0n) + fillAmount
      );
      remaining -= fillAmount;
    }

    // If we couldn't allocate everything, the remaining goes to the
    // venue with the most liquidity (best-effort)
    if (remaining > 0n && venueAllocations.size > 0) {
      const largest = [...venueAllocations.entries()].sort(
        (a, b) => (b[1].amountIn > a[1].amountIn ? 1 : -1)
      )[0];
      largest[1].amountIn += remaining;
      // Expected out for overflow is approximate
    }

    // A venue that pays nothing is not a route — drop zero-output
    // allocations entirely (previously a quoteless pair "routed" 100%
    // through SwapBook at expectedOut 0).
    for (const [venueId, alloc] of [...venueAllocations.entries()]) {
      if (alloc.expectedOut <= 0n) venueAllocations.delete(venueId);
    }

    // Convert to RouteSegments
    return [...venueAllocations.entries()].map(([venueId, alloc]) => {
      const segInScaled =
        decimals.out >= decimals.in
          ? alloc.amountIn * 10n ** BigInt(decimals.out - decimals.in)
          : alloc.amountIn / 10n ** BigInt(decimals.in - decimals.out);
      const effectiveBps =
        segInScaled > 0n
          ? Number(((segInScaled - alloc.expectedOut) * 10000n) / segInScaled)
          : 0;

      return {
        venueName: alloc.name,
        venueId,
        amountIn: alloc.amountIn,
        expectedAmountOut: alloc.expectedOut,
        effectiveBps,
      };
    });
  }
}

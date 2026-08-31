/**
 * TWAP Keeper
 *
 * Drives execution of TwapBook orders. Each tick it scans active orders
 * and, for any order behind schedule, computes a slice route over
 * Router-executable venues and submits execute_slice.
 *
 * The keeper is PERMISSIONLESS and holds no custody: pace, price floor,
 * and cadence are all enforced by the TwapBook contract. A buggy keeper
 * can only make an order slower, never worse-priced. Expired orders get
 * a permissionless expire_twap (refunds the maker's remainder).
 *
 * Slice sizing (v1): aim for the on-schedule fill level — slice =
 * min(pace deficit, order.max_slice_in, remaining). Volume-adaptive
 * sizing (participation caps vs live venue volume) is the planned v2.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { StellarClient, scEnum } from '../stellar/client.js';
import { RoutingEngine } from '../router/engine.js';

interface TwapOrderState {
  id: number;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  totalIn: bigint;
  filledIn: bigint;
  startLedger: number;
  endLedger: number;
  limitNum: bigint;
  limitDen: bigint;
  maxSliceIn: bigint;
  minSliceGap: number;
  paceToleranceBps: number;
  lastSliceLedger: number;
  status: string;
}

/** ceil(a * b / d) — mirrors the contract's rounding. */
function muldivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/** Sizing up is allowed when the market is within this many bps of
 *  oracle fair value (vsOracleBps ≤ threshold; negative = better than
 *  fair, always qualifies). */
const OPPORTUNITY_BPS = Number(process.env.TWAP_OPPORTUNITY_BPS ?? '10');

export class TwapKeeperService {
  private stellar: StellarClient;
  private twapBookContractId: string;
  private routingEngine: RoutingEngine;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private keeper: InstanceType<typeof Keypair> | null = null;
  private ticking = false;
  private fairValue?: import('./fair-value.js').FairValueService;
  private tokenMeta?: (sac: string) => { decimals: number; symbol: string };

  constructor(opts: {
    stellar: StellarClient;
    twapBookContractId: string;
    routingEngine: RoutingEngine;
    /** Tick interval (default: 30s) */
    intervalMs?: number;
    /** Keeper signing key. Omit for dry-run mode. */
    keeperSecretKey?: string;
    /** Oracle fair-value reads — enables opportunistic slice sizing. */
    fairValue?: import('./fair-value.js').FairValueService;
    /** Token decimals+symbol lookup for oracle comparisons. */
    tokenMeta?: (sac: string) => { decimals: number; symbol: string };
  }) {
    this.stellar = opts.stellar;
    this.twapBookContractId = opts.twapBookContractId;
    this.routingEngine = opts.routingEngine;
    this.intervalMs = opts.intervalMs ?? 30 * 1000;
    this.fairValue = opts.fairValue;
    this.tokenMeta = opts.tokenMeta;
    if (opts.keeperSecretKey) {
      try {
        this.keeper = Keypair.fromSecret(opts.keeperSecretKey);
      } catch {
        console.error('[TwapKeeper] keeper secret invalid — dry-run mode');
      }
    }
  }

  start(): void {
    if (!this.twapBookContractId) {
      console.log('[TwapKeeper] No TWAP_BOOK_CONTRACT_ID — keeper disabled');
      return;
    }
    console.log(`[TwapKeeper] Starting (tick: ${this.intervalMs / 1000}s, mode: ${this.keeper ? 'LIVE' : 'DRY RUN'})`);
    this.tickGuarded();
    this.timer = setInterval(() => this.tickGuarded(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tickGuarded(): void {
    if (this.ticking) return;
    this.ticking = true;
    this.tick()
      .catch((err) => console.error('[TwapKeeper] tick failed:', err))
      .finally(() => { this.ticking = false; });
  }

  private async tick(): Promise<void> {
    const activeIds = await this.stellar.simulateAndParse<Array<number | bigint>>(
      this.twapBookContractId,
      'get_active_orders',
      []
    );
    if (!activeIds || activeIds.length === 0) return;

    const currentLedger = await this.stellar.getLatestLedger();

    for (const rawId of activeIds) {
      const id = Number(rawId);
      try {
        await this.processOrder(id, currentLedger);
      } catch (err) {
        console.error(`[TwapKeeper] order #${id} failed:`, err);
      }
    }
  }

  private async fetchOrder(id: number): Promise<TwapOrderState | null> {
    const raw = await this.stellar.simulateAndParse<any>(
      this.twapBookContractId,
      'get_order',
      [StellarClient.toU64(id)]
    );
    if (!raw) return null;
    return {
      id,
      maker: String(raw.maker),
      tokenIn: String(raw.token_in),
      tokenOut: String(raw.token_out),
      totalIn: BigInt(raw.total_in ?? 0),
      filledIn: BigInt(raw.filled_in ?? 0),
      startLedger: Number(raw.start_ledger ?? 0),
      endLedger: Number(raw.end_ledger ?? 0),
      limitNum: BigInt(raw.limit_num ?? 0),
      limitDen: BigInt(raw.limit_den ?? 0),
      maxSliceIn: BigInt(raw.max_slice_in ?? 0),
      minSliceGap: Number(raw.min_slice_gap ?? 0),
      paceToleranceBps: Number(raw.pace_tolerance_bps ?? 0),
      lastSliceLedger: Number(raw.last_slice_ledger ?? 0),
      status: scEnum(raw.status),
    };
  }

  private async processOrder(id: number, currentLedger: number): Promise<void> {
    const order = await this.fetchOrder(id);
    if (!order || order.status !== 'Active') return;

    // Past the window → permissionless refund
    if (currentLedger > order.endLedger) {
      console.log(`[TwapKeeper] order #${id} expired — refunding remainder`);
      if (this.keeper) {
        await this.stellar.submitWithSigner(
          this.keeper,
          this.twapBookContractId,
          'expire_twap',
          [StellarClient.toU64(id)]
        );
      }
      return;
    }

    // Cadence: don't waste a simulation if the contract would refuse anyway
    if (
      order.lastSliceLedger > 0 &&
      currentLedger < order.lastSliceLedger + order.minSliceGap
    ) {
      return;
    }

    // Pace target. Normal flight aims for the on-schedule (pro-rata) level —
    // true TWAP behavior. But that line only reaches 100% AT end_ledger,
    // when it's too late to slice: an on-schedule-only keeper strands the
    // final slice-interval of volume in every order. So in the END-GAME —
    // when the ledgers left can't fit the gap-separated slices the
    // remainder needs — target the pace CEILING (schedule + the maker's
    // tolerance band) so the order completes inside the window. The
    // contract enforces the ceiling either way; tolerance 0 makers opt out
    // of end-game and accept the tail refund.
    const elapsed = BigInt(Math.max(0, currentLedger - order.startLedger));
    const duration = BigInt(order.endLedger - order.startLedger);
    const onSchedule = (order.totalIn * elapsed) / duration;
    const headroom = (order.totalIn * BigInt(order.paceToleranceBps)) / 10_000n;
    const remaining = order.totalIn - order.filledIn;

    const ledgersLeft = BigInt(Math.max(0, order.endLedger - currentLedger));
    const slicesNeeded = (remaining + order.maxSliceIn - 1n) / order.maxSliceIn;
    const ledgersNeeded = BigInt(order.minSliceGap) * slicesNeeded + 18n; // +~2 ticks safety
    const endGame = ledgersLeft <= ledgersNeeded;

    let slice = endGame
      ? onSchedule + headroom - order.filledIn
      : onSchedule - order.filledIn;

    // Opportunistic (VWAP-flavored) sizing: when the market currently
    // pays at/near oracle fair value, fill up to the pace CEILING
    // (schedule + the maker's tolerance band) instead of just to the
    // schedule line — capture good liquidity while it's there, drift
    // back toward schedule when pricing is poor. The contract enforces
    // the ceiling regardless; tolerance-0 makers have opted out.
    if (!endGame && this.fairValue && this.tokenMeta && order.paceToleranceBps > 0) {
      let ceiling = onSchedule + headroom - order.filledIn;
      if (ceiling > order.maxSliceIn) ceiling = order.maxSliceIn;
      if (ceiling > remaining) ceiling = remaining;
      if (ceiling > slice && ceiling > 0n) {
        try {
          const probe = await this.routingEngine.computeRoute(
            order.tokenIn,
            order.tokenOut,
            ceiling,
            50,
            { executableOnly: true }
          );
          const inMeta = this.tokenMeta(order.tokenIn);
          const outMeta = this.tokenMeta(order.tokenOut);
          const vs = await this.fairValue.vsOracleBps({
            tokenInSac: order.tokenIn,
            tokenOutSac: order.tokenOut,
            symbolIn: inMeta.symbol,
            symbolOut: outMeta.symbol,
            amountIn: ceiling,
            netAmountOut: probe.netAmountOut,
            decimalsIn: inMeta.decimals,
            decimalsOut: outMeta.decimals,
          });
          if (vs !== null && vs <= OPPORTUNITY_BPS) {
            console.log(
              `[TwapKeeper] order #${id}: market at fair (${vs}bps vs oracle) — sizing up ${slice} → ${ceiling}`
            );
            slice = ceiling;
          }
        } catch {
          // probe failed — keep the schedule-paced slice
        }
      }
    }

    if (slice <= 0n) return; // on pace (or at ceiling) — wait
    if (slice > order.maxSliceIn) slice = order.maxSliceIn;
    if (slice > remaining) slice = remaining;
    if (slice <= 0n) return;

    // Pace visibility: a widening lag means slices are failing or skipped —
    // surface it so stalls are diagnosable from logs.
    const lag = onSchedule - order.filledIn;
    if (lag * 10n > order.totalIn) {
      console.warn(
        `[TwapKeeper] order #${id}: ${lag} behind schedule (${order.filledIn}/${order.totalIn} filled, ` +
        `${ledgersLeft} ledgers left${endGame ? ', END-GAME' : ''})`
      );
    }

    // Route over Router-executable venues (venue ids match TwapBook registry)
    let route;
    try {
      route = await this.routingEngine.computeRoute(
        order.tokenIn,
        order.tokenOut,
        slice,
        50,
        { executableOnly: true }
      );
    } catch {
      console.log(`[TwapKeeper] order #${id}: no executable route for slice — retry next tick`);
      return;
    }
    if (route.instructions.length === 0) return;

    // Local floor pre-check for fixed-limit orders — skip slices that would
    // revert on-chain (saves the fee). Oracle-bound orders are enforced by
    // the contract against the live oracle.
    if (order.limitNum > 0n) {
      const minNet = muldivCeil(slice, order.limitNum, order.limitDen);
      if (route.netAmountOut < minNet) {
        console.log(
          `[TwapKeeper] order #${id}: market below limit (${route.netAmountOut} < ${minNet}) — waiting`
        );
        return;
      }
    }

    console.log(
      `[TwapKeeper] order #${id}: slice ${slice} ${order.tokenIn.slice(0, 4)}… → est ${route.netAmountOut} via ${route.segments.map((s) => s.venueName).join('+')}`
    );
    if (!this.keeper) {
      console.log(`[TwapKeeper] [DRY RUN] would execute_slice(#${id}, ${slice})`);
      return;
    }

    const result = await this.stellar.submitWithSigner(
      this.keeper,
      this.twapBookContractId,
      'execute_slice',
      [
        StellarClient.toU64(id),
        StellarClient.toI128(slice),
        StellarClient.toRouteSegments(
          route.instructions.map((i) => ({
            venueId: i.venueId,
            amountIn: i.amountIn,
            minAmountOut: i.minAmountOut,
          }))
        ),
      ]
    );
    console.log(`[TwapKeeper] order #${id} slice submitted (${result.status})`);
  }
}

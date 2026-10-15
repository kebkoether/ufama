/**
 * Soroban RPC client — handles all on-chain interactions.
 *
 * Uses @stellar/stellar-sdk to:
 * - Simulate contract calls (for quotes, no gas cost)
 * - Build and submit real transactions (for swaps)
 * - Sign and submit service transactions (keeper / oracle)
 */

import {
  Contract,
  TransactionBuilder,
  Keypair,
  Account,
  Address,
  Asset,
  Operation,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
} from '@stellar/stellar-sdk';

export interface StellarClientConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Public/secondary RPCs tried in order when the primary fails at the
   *  transport level (DNS/TLS/timeout/5xx/429). Empty = no failover. */
  fallbackRpcUrls?: string[];
  /** Per-call wall-clock cap; a hung RPC must not hang a request handler. */
  rpcTimeoutMs?: number;
}

/** How long a failed endpoint is skipped before it's retried. */
const RPC_FAILOVER_COOLDOWN_MS = parseInt(process.env.RPC_FAILOVER_COOLDOWN_MS ?? '60000');
const DEFAULT_RPC_TIMEOUT_MS = parseInt(process.env.RPC_TIMEOUT_MS ?? '12000');
/** Health-probe cap — tighter than a working call, so "degraded" shows
 *  up on the health page long before user requests start timing out. */
const RPC_PROBE_TIMEOUT_MS = parseInt(process.env.RPC_PROBE_TIMEOUT_MS ?? '3000');

interface RpcEndpoint {
  url: string;
  host: string;
  server: rpc.Server;
}

/**
 * Process-wide "endpoint is down until" map, keyed by URL. Several
 * StellarClient instances share the same endpoints (API handlers, venue
 * adapters, keepers) — one of them discovering an outage should spare
 * the others their own timeout.
 */
const endpointDownUntil = new Map<string, number>();

/**
 * Transport-level failures are the ones a different endpoint can cure.
 * Deterministic answers (account not found, simulation errors, bad XDR)
 * would just repeat elsewhere and must surface unchanged.
 */
export function isTransportError(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'RpcTimeoutError') return true;
  const status: number | undefined = e.response?.status ?? e.status;
  if (
    typeof status === 'number' &&
    (status >= 500 || status === 429 || status === 403 || status === 401)
  ) {
    return true;
  }
  const msg = String(e.message ?? e);
  if (/account not found|not found: /i.test(msg)) return false;
  return /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|network|timed? ?out|certificate|TLS|SSL|alert|aborted|Unexpected token|invalid json|status code (5\d\d|429|403)/i.test(
    msg
  );
}

class RpcTimeoutError extends Error {
  name = 'RpcTimeoutError';
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcTimeoutError(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** How long to poll for a submitted transaction before giving up. */
const SUBMIT_POLL_ATTEMPTS = 30;
const SUBMIT_POLL_INTERVAL_MS = 1000;

/**
 * Soroban unit-variant enums decode via scValToNative as one-element
 * arrays (e.g. ['Open']), not bare strings. Normalize before comparing.
 */
export function scEnum(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0];
  }
  return String(value);
}

export class StellarClient {
  private endpoints: RpcEndpoint[];
  private networkPassphrase: string;
  private rpcTimeoutMs: number;

  constructor(config: StellarClientConfig) {
    const urls = [config.rpcUrl, ...(config.fallbackRpcUrls ?? [])].filter(
      (u, i, arr) => u && arr.indexOf(u) === i
    );
    this.endpoints = urls.map((url) => ({
      url,
      host: StellarClient.hostOf(url),
      server: new rpc.Server(url),
    }));
    this.networkPassphrase = config.networkPassphrase;
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  /** Host only — provider URLs can carry the API key in the path. */
  static hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return 'configured';
    }
  }

  /** Endpoints in try-order: healthy ones first (primary leads), then
   *  those inside their failover cooldown as a last resort. */
  private orderedEndpoints(): RpcEndpoint[] {
    const now = Date.now();
    const up = this.endpoints.filter((e) => (endpointDownUntil.get(e.url) ?? 0) <= now);
    const down = this.endpoints.filter((e) => (endpointDownUntil.get(e.url) ?? 0) > now);
    return [...up, ...down];
  }

  /**
   * Run one RPC call with timeout + failover. Transport failures mark
   * the endpoint down for RPC_FAILOVER_COOLDOWN_MS and move on to the
   * next; deterministic errors propagate from the first endpoint that
   * answered. Both October-2026 outages (provider endpoint deleted, then
   * TLS rejected) would have failed over here instead of returning
   * "no liquidity" for every pair.
   */
  private async rpc<T>(label: string, fn: (s: rpc.Server) => Promise<T>): Promise<T> {
    let lastErr: unknown = new Error(`${label}: no RPC endpoints configured`);
    for (const ep of this.orderedEndpoints()) {
      try {
        const out = await withTimeout(
          fn(ep.server),
          this.rpcTimeoutMs,
          `${label} @ ${ep.host}`
        );
        if (endpointDownUntil.has(ep.url)) {
          endpointDownUntil.delete(ep.url);
          console.warn(`RPC endpoint recovered: ${ep.host}`);
        }
        return out;
      } catch (err) {
        if (!isTransportError(err)) throw err;
        lastErr = err;
        endpointDownUntil.set(ep.url, Date.now() + RPC_FAILOVER_COOLDOWN_MS);
        console.warn(
          `RPC ${label} failed at ${ep.host} (${(err as Error)?.message ?? err}) — failing over`
        );
      }
    }
    throw lastErr;
  }

  /** Latest ledger sequence — needed to compute expiry / timer offsets. */
  async getLatestLedger(): Promise<number> {
    const response = await this.rpc('getLatestLedger', (s) => s.getLatestLedger());
    return response.sequence;
  }

  /**
   * Health probe: hits the PRIMARY endpoint directly (bypassing the
   * cooldown so recovery shows promptly) with a short timeout, and
   * reports which endpoint live traffic would currently use.
   */
  async rpcStatus(): Promise<{
    primary: string;
    primaryOk: boolean;
    latencyMs: number | null;
    ledger: number | null;
    error?: string;
    active: string;
    fallbacks: string[];
  }> {
    const primary = this.endpoints[0];
    const started = Date.now();
    let primaryOk = false;
    let ledger: number | null = null;
    let error: string | undefined;
    try {
      const r = await withTimeout(
        primary.server.getLatestLedger(),
        RPC_PROBE_TIMEOUT_MS,
        'probe'
      );
      ledger = r.sequence;
      primaryOk = true;
      endpointDownUntil.delete(primary.url);
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, 200);
      endpointDownUntil.set(primary.url, Date.now() + RPC_FAILOVER_COOLDOWN_MS);
    }
    return {
      primary: primary.host,
      primaryOk,
      latencyMs: primaryOk ? Date.now() - started : null,
      ledger,
      ...(error ? { error } : {}),
      active: this.orderedEndpoints()[0].host,
      fallbacks: this.endpoints.slice(1).map((e) => e.host),
    };
  }

  /**
   * Simulate a contract call without submitting a transaction.
   * Used for getting quotes and reading state — no gas cost.
   */
  async simulateCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<xdr.ScVal | null> {
    try {
      const contract = new Contract(contractId);
      const operation = contract.call(method, ...args);

      // Simulation doesn't need a real account
      const account = new Account(Keypair.random().publicKey(), '0');
      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.rpc('simulateTransaction', (s) => s.simulateTransaction(tx));

      if (rpc.Api.isSimulationSuccess(simResult)) {
        return simResult.result?.retval ?? null;
      }

      console.warn(`Simulation failed for ${contractId}.${method}`);
      return null;
    } catch (error) {
      console.error(`simulateCall error (${contractId}.${method}):`, error);
      return null;
    }
  }

  /**
   * Simulate and return a native JS value from a contract call.
   */
  // ── Simulation gate ─────────────────────────────────
  // The pathfinder can fire dozens of concurrent simulations (spot
  // probes + depth quotes). Public Soroban RPCs rate-limit such bursts,
  // and a throttled sim used to read as "no liquidity" — quotes went
  // intermittently blind under our own load. Cap in-flight sims and
  // retry once with backoff.
  private static SIM_CONCURRENCY = parseInt(process.env.RPC_SIM_CONCURRENCY ?? '8');
  private static simInFlight = 0;
  private static simWaiters: Array<() => void> = [];

  private static async simSlot(): Promise<void> {
    if (StellarClient.simInFlight < StellarClient.SIM_CONCURRENCY) {
      StellarClient.simInFlight++;
      return;
    }
    await new Promise<void>((resolve) => StellarClient.simWaiters.push(resolve));
    StellarClient.simInFlight++;
  }

  private static simRelease(): void {
    StellarClient.simInFlight--;
    const next = StellarClient.simWaiters.shift();
    if (next) next();
  }

  async simulateAndParse<T>(
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await StellarClient.simSlot();
      try {
        const result = await this.simulateCall(contractId, method, args);
        if (result) {
          try {
            return scValToNative(result) as T;
          } catch {
            return null; // parse failure is deterministic — no retry
          }
        }
      } catch {
        /* fall through to retry */
      } finally {
        StellarClient.simRelease();
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  /** Cached network fee stats → per-op inclusion-fee bid in stroops. */
  private feeCache: { at: number; soroban: string; classic: string } | null = null;

  /**
   * Size the inclusion fee from live network traffic (p90 of recent
   * inclusion fees, doubled for headroom) so surge pricing doesn't bounce
   * user transactions with txInsufficientFee. Floors match the old fixed
   * bids; caps keep a runaway surge from bidding more than ~1 XLM
   * (Soroban, single-op) / 0.1 XLM per classic op. Stats are cached 30s;
   * if the RPC can't serve them we fall back to the floors.
   */
  private async inclusionFee(kind: 'soroban' | 'classic'): Promise<string> {
    const now = Date.now();
    if (!this.feeCache || now - this.feeCache.at > 30_000) {
      let soroban = '200';
      let classic = '10000';
      try {
        const stats = await this.rpc('getFeeStats', (s) => s.getFeeStats());
        const bid = (p90: string | undefined, floor: number, cap: number) =>
          Math.min(cap, Math.max(floor, Number(p90 ?? 0) * 2)).toString();
        soroban = bid(stats.sorobanInclusionFee?.p90, 200, 10_000_000);
        classic = bid(stats.inclusionFee?.p90, 10_000, 1_000_000);
      } catch {
        // fee stats unavailable — keep the floor bids
      }
      this.feeCache = { at: now, soroban, classic };
    }
    return kind === 'soroban' ? this.feeCache.soroban : this.feeCache.classic;
  }

  /**
   * Build a transaction for a contract call (unsigned).
   * The frontend signs this with the user's wallet.
   */
  async buildTransaction(
    sourceAddress: string,
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<string> {
    const contract = new Contract(contractId);
    const operation = contract.call(method, ...args);

    const account = await this.rpc('getAccount', (s) => s.getAccount(sourceAddress));
    const tx = new TransactionBuilder(account, {
      fee: await this.inclusionFee('soroban'),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const simResult = await this.rpc('simulateTransaction', (s) => s.simulateTransaction(tx));

    if (!rpc.Api.isSimulationSuccess(simResult)) {
      const detail =
        'error' in simResult ? ` — ${JSON.stringify(simResult.error)}` : '';
      throw new Error(`Transaction simulation failed${detail}`);
    }

    const preparedTx = rpc.assembleTransaction(tx, simResult);
    return preparedTx.build().toXDR();
  }

  /**
   * Build an unsigned CLASSIC path-payment-strict-send transaction.
   * Used when the SDEX/classic-AMM route beats the Soroban venues —
   * classic operations cannot be executed from inside a Soroban contract,
   * so the user signs this transaction directly (the Soroswap pattern).
   */
  async buildClassicPathPayment(opts: {
    sourceAddress: string;
    sendAsset: InstanceType<typeof Asset>;
    sendAmount: string; // display units, 7dp string
    destAsset: InstanceType<typeof Asset>;
    destMin: string;    // display units, 7dp string
    path: InstanceType<typeof Asset>[];
    /** Optional integrator fee: paid in destAsset from the swapper to the
     *  partner's address as a second op in the same tx (classic txs allow
     *  multiple ops; ops are atomic — swap fails, fee never leaves). The
     *  destination must hold a trustline for destAsset. */
    partnerPayment?: { destination: string; amount: string };
  }): Promise<string> {
    const account = await this.rpc('getAccount', (s) => s.getAccount(opts.sourceAddress));
    const builder = new TransactionBuilder(account, {
      fee: await this.inclusionFee('classic'),
      networkPassphrase: this.networkPassphrase,
    }).addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: opts.sendAsset,
        sendAmount: opts.sendAmount,
        destination: opts.sourceAddress, // self-swap
        destAsset: opts.destAsset,
        destMin: opts.destMin,
        path: opts.path,
      })
    );
    if (opts.partnerPayment) {
      builder.addOperation(
        Operation.payment({
          destination: opts.partnerPayment.destination,
          asset: opts.destAsset,
          amount: opts.partnerPayment.amount,
        })
      );
    }
    const tx = builder.setTimeout(300).build();
    return tx.toXDR();
  }

  /**
   * Build an unsigned changeTrust transaction so a wallet can add the
   * trustline it needs before receiving a classic-backed token. The user
   * signs and submits it like any swap leg.
   */
  async buildChangeTrust(opts: {
    sourceAddress: string;
    asset: InstanceType<typeof Asset>;
  }): Promise<string> {
    const account = await this.rpc('getAccount', (s) => s.getAccount(opts.sourceAddress));
    return new TransactionBuilder(account, {
      fee: await this.inclusionFee('classic'),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.changeTrust({ asset: opts.asset }))
      .setTimeout(300)
      .build()
      .toXDR();
  }

  /**
   * Build, sign, and submit a contract call from a service account
   * (keeper sweep, oracle updates). Returns the final tx response.
   */
  async submitWithSigner(
    signer: InstanceType<typeof Keypair>,
    contractId: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<rpc.Api.GetTransactionResponse> {
    const unsignedXdr = await this.buildTransaction(
      signer.publicKey(),
      contractId,
      method,
      args
    );
    const tx = TransactionBuilder.fromXDR(unsignedXdr, this.networkPassphrase);
    tx.sign(signer);
    return this.submitTransaction(tx.toXDR());
  }

  /**
   * Submit a signed transaction XDR. Polls for the result with a bounded
   * timeout — a hung RPC must not hang the request handler forever.
   */
  async submitTransaction(signedXdr: string): Promise<rpc.Api.GetTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const response = await this.rpc('sendTransaction', (s) => s.sendTransaction(tx));

    if (response.status === 'ERROR') {
      // Surface the actual result code (txBadSeq, txInsufficientFee,
      // txTooLate...) — the raw response dump only helps in logs.
      let code = 'unknown';
      try {
        code = response.errorResult?.result().switch().name ?? 'unknown';
      } catch {
        /* keep 'unknown' */
      }
      console.error('sendTransaction ERROR detail:', JSON.stringify(response));
      throw new Error(`Transaction rejected at send: ${code}`);
    }
    if (response.status === 'TRY_AGAIN_LATER' || response.status === 'DUPLICATE') {
      // Not accepted into the queue — polling would only time out.
      throw new Error(
        `Transaction not accepted (${response.status}) — wait a few seconds and retry`
      );
    }

    for (let attempt = 0; attempt < SUBMIT_POLL_ATTEMPTS; attempt++) {
      const getResponse = await this.rpc('getTransaction', (s) => s.getTransaction(response.hash));
      if (getResponse.status === 'FAILED') {
        // Landed on-ledger but failed — callers treat a returned response
        // as success, so this must throw with the op-level reason.
        let code = 'unknown';
        try {
          code = getResponse.resultXdr.result().switch().name;
        } catch {
          /* keep 'unknown' */
        }
        throw new Error(`Transaction failed on-ledger: ${code} (${response.hash})`);
      }
      if (getResponse.status !== 'NOT_FOUND') {
        return getResponse;
      }
      await new Promise((r) => setTimeout(r, SUBMIT_POLL_INTERVAL_MS));
    }
    throw new Error(
      `Transaction ${response.hash} not confirmed after ${SUBMIT_POLL_ATTEMPTS}s — check the explorer before retrying`
    );
  }

  // ─── Helper: ScVal builders ───────────────────────────

  static toAddress(address: string): xdr.ScVal {
    return new Address(address).toScVal();
  }

  static toI128(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'i128' });
  }

  static toU32(value: number): xdr.ScVal {
    return nativeToScVal(value, { type: 'u32' });
  }

  static toU64(value: number | bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'u64' });
  }

  static toU128(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'u128' });
  }

  /**
   * Encode Vec<RouteSegment> for the Router contract.
   * Struct fields encode as an ScMap with keys in lexicographic order:
   * amount_in < min_amount_out < venue_id.
   */
  static toRouteSegments(
    segments: Array<{ venueId: number; amountIn: bigint; minAmountOut: bigint }>
  ): xdr.ScVal {
    return xdr.ScVal.scvVec(
      segments.map((seg) =>
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('amount_in'),
            val: nativeToScVal(seg.amountIn, { type: 'i128' }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('min_amount_out'),
            val: nativeToScVal(seg.minAmountOut, { type: 'i128' }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('venue_id'),
            val: nativeToScVal(seg.venueId, { type: 'u32' }),
          }),
        ])
      )
    );
  }

  /** Encode Vec<Address> (e.g. place_order's excluded counterparties). */
  static toAddressVec(addresses: string[]): xdr.ScVal {
    return xdr.ScVal.scvVec(addresses.map((a) => new Address(a).toScVal()));
  }

  /**
   * Encode Vec<PathHop> for Router.execute_path. Field order per struct
   * is lexicographic: PathHop{legs, token_out}; PathLeg{min_amount_out,
   * venue_id, weight_bps}.
   */
  static toPathHops(
    hops: Array<{
      tokenOut: string;
      legs: Array<{ venueId: number; weightBps: number; minAmountOut: bigint }>;
    }>
  ): xdr.ScVal {
    return xdr.ScVal.scvVec(
      hops.map((h) =>
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('legs'),
            val: xdr.ScVal.scvVec(
              h.legs.map((l) =>
                xdr.ScVal.scvMap([
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol('min_amount_out'),
                    val: nativeToScVal(l.minAmountOut, { type: 'i128' }),
                  }),
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol('venue_id'),
                    val: nativeToScVal(l.venueId, { type: 'u32' }),
                  }),
                  new xdr.ScMapEntry({
                    key: xdr.ScVal.scvSymbol('weight_bps'),
                    val: nativeToScVal(BigInt(l.weightBps), { type: 'i128' }),
                  }),
                ])
              )
            ),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('token_out'),
            val: new Address(h.tokenOut).toScVal(),
          }),
        ])
      )
    );
  }

  /**
   * Encode Vec<FillSpec> for SwapBook.match_and_place. Struct fields
   * encode as an ScMap with keys in lexicographic order:
   * amount_out < fill_amount_in < order_id.
   */
  static toFillSpecs(
    fills: Array<{ orderId: number; fillAmountIn: bigint; amountOut: bigint }>
  ): xdr.ScVal {
    return xdr.ScVal.scvVec(
      fills.map((f) =>
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('amount_out'),
            val: nativeToScVal(f.amountOut, { type: 'i128' }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('fill_amount_in'),
            val: nativeToScVal(f.fillAmountIn, { type: 'i128' }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('order_id'),
            val: nativeToScVal(f.orderId, { type: 'u64' }),
          }),
        ])
      )
    );
  }
}

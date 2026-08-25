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
  private server: rpc.Server;
  private networkPassphrase: string;

  constructor(config: StellarClientConfig) {
    this.server = new rpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /** Latest ledger sequence — needed to compute expiry / timer offsets. */
  async getLatestLedger(): Promise<number> {
    const response = await this.server.getLatestLedger();
    return response.sequence;
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

      const simResult = await this.server.simulateTransaction(tx);

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

    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

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
    const account = await this.server.getAccount(opts.sourceAddress);
    const builder = new TransactionBuilder(account, {
      fee: '10000',
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
    const response = await this.server.sendTransaction(tx);

    if (response.status === 'ERROR') {
      throw new Error(`Transaction send failed: ${JSON.stringify(response)}`);
    }

    for (let attempt = 0; attempt < SUBMIT_POLL_ATTEMPTS; attempt++) {
      const getResponse = await this.server.getTransaction(response.hash);
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

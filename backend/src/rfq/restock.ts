/**
 * Maker inventory restock through the issuer's primary market.
 *
 * The maker quotes atomically at NAV ± spread; this loop keeps its bond
 * inventory topped up by buying from Etherfuse at NAV (entering a
 * stablebond is free on their side) whenever a bond balance drops below
 * a floor. One order at a time per asset, funded by signing the
 * prepared transaction Etherfuse returns with the maker key.
 *
 * Pure orchestration with injected I/O so it is unit-testable; the bot
 * wires the real Etherfuse client, Horizon and the keypair.
 */

import type { EtherfuseClient, Order } from '../services/etherfuse-client.js';

export interface RestockTarget {
  /** Bond symbol as Etherfuse names it (USTRY, CETES, TESOURO…). */
  symbol: string;
  /** Etherfuse asset id "CODE:ISSUER" for the bond on this network. */
  asset: string;
  /** Refill when the wallet holds fewer than this many bonds (display units). */
  minBalance: number;
  /** How much of the source asset to spend per refill (display units). */
  spend: string;
}

export interface RestockDeps {
  etherfuse: Pick<EtherfuseClient, 'quote' | 'createOrder' | 'order' | 'refreshFunding' | 'balances'>;
  /** Payment-account id of the maker wallet on Etherfuse. */
  paymentAccountId: string;
  /** Source asset id ("USDC:G…") to spend. */
  sourceAsset: string;
  /** Current wallet balances by symbol (display units). */
  balances: () => Promise<Record<string, number>>;
  /** Sign an unsigned envelope XDR with the maker key and submit it. Returns the hash. */
  signAndSubmit: (xdr: string) => Promise<string>;
  targets: RestockTarget[];
  /** Max slippage vs the quote's rateBeforeFees, bps (protects against a bad mid-funding reprice). */
  maxFeeBps?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface RestockResult {
  symbol: string;
  action: 'skipped' | 'ordered' | 'funded' | 'failed';
  reason?: string;
  orderId?: string;
  hash?: string;
}

export class Restocker {
  /** Orders we funded and are waiting on, by symbol. */
  private pending = new Map<string, { orderId: string; at: number }>();

  constructor(private d: RestockDeps) {}

  /** One pass over every target. Safe to call on a timer. */
  async tick(): Promise<RestockResult[]> {
    const out: RestockResult[] = [];
    const bal = await this.d.balances();
    for (const t of this.d.targets) {
      out.push(await this.one(t, bal[t.symbol] ?? bal[t.symbol.toUpperCase()] ?? 0));
    }
    return out;
  }

  private async one(t: RestockTarget, have: number): Promise<RestockResult> {
    const log = this.d.log ?? (() => {});
    const now = this.d.now ?? Date.now;
    const pend = this.pending.get(t.symbol);
    if (pend) {
      const o = await this.d.etherfuse.order(pend.orderId);
      if (o.status === 'completed' || o.status === 'failed' || o.status === 'canceled' || o.status === 'refunded') {
        this.pending.delete(t.symbol);
        log(`[restock] ${t.symbol} order ${o.id} ${o.status}${o.failure ? ` (${o.failure.code}: ${o.failure.message})` : ''}`);
        if (o.status !== 'completed') return { symbol: t.symbol, action: 'failed', orderId: o.id, reason: o.status };
      } else {
        return { symbol: t.symbol, action: 'skipped', orderId: o.id, reason: `order ${o.status}` };
      }
    }
    if (have >= t.minBalance) return { symbol: t.symbol, action: 'skipped', reason: `holds ${have} ≥ ${t.minBalance}` };

    const q = await this.d.etherfuse.quote({
      sourcePaymentAccountId: this.d.paymentAccountId,
      destinationPaymentAccountId: this.d.paymentAccountId,
      sourceAmount: t.spend,
      sourceAsset: this.d.sourceAsset,
      destinationAsset: t.asset,
      rail: 'stellar',
    });
    if (q.feeBps > (this.d.maxFeeBps ?? 25)) {
      return { symbol: t.symbol, action: 'skipped', reason: `quote fee ${q.feeBps} bps above cap` };
    }
    const order: Order = await this.d.etherfuse.createOrder(q.quoteId, `ufama maker restock ${t.symbol}`);
    log(`[restock] ${t.symbol}: ordered ${q.destinationAmount} for ${q.sourceAmount} (${q.feeBps} bps), order ${order.id}`);
    const tx = order.fundingInstructions?.destination?.preparedTransaction?.transaction;
    if (!tx) {
      // Funding instructions can arrive a moment later; try once.
      const again = await this.d.etherfuse.order(order.id);
      const tx2 = again.fundingInstructions?.destination?.preparedTransaction?.transaction;
      if (!tx2) {
        this.pending.set(t.symbol, { orderId: order.id, at: now() });
        return { symbol: t.symbol, action: 'ordered', orderId: order.id, reason: 'no prepared transaction yet' };
      }
      return this.fund(t, order.id, tx2, now);
    }
    return this.fund(t, order.id, tx, now);
  }

  private async fund(t: RestockTarget, orderId: string, xdr: string, now: () => number): Promise<RestockResult> {
    const log = this.d.log ?? (() => {});
    try {
      const hash = await this.d.signAndSubmit(xdr);
      this.pending.set(t.symbol, { orderId, at: now() });
      log(`[restock] ${t.symbol}: funded order ${orderId}, tx ${hash}`);
      return { symbol: t.symbol, action: 'funded', orderId, hash };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/tx_bad_seq|bad_seq/i.test(msg)) {
        const refreshed = await this.d.etherfuse.refreshFunding(orderId);
        const tx2 = refreshed.fundingInstructions?.destination?.preparedTransaction?.transaction;
        if (tx2) {
          const hash = await this.d.signAndSubmit(tx2);
          this.pending.set(t.symbol, { orderId, at: now() });
          return { symbol: t.symbol, action: 'funded', orderId, hash };
        }
      }
      this.pending.set(t.symbol, { orderId, at: now() });
      return { symbol: t.symbol, action: 'failed', orderId, reason: msg.slice(0, 200) };
    }
  }
}

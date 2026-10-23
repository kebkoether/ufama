/**
 * In-memory RFQ state. Requests live for seconds to a few minutes, so a
 * process-local store with TTL sweeping is the right shape (one Railway
 * instance serves the API). Everything a UI or maker needs to render is
 * kept here as strings/numbers — bigint stays at the service boundary.
 */

import { randomBytes } from 'node:crypto';

export type RequestStatus = 'open' | 'accepted' | 'settled' | 'expired' | 'cancelled';
export type QuoteStatus = 'live' | 'accepted' | 'superseded' | 'expired' | 'rejected';

export interface RfqReference {
  /** Oracle (NAV) fair value of amountIn in tokenOut base units, or null. */
  navAmountOut: string | null;
  /** Human NAV price: tokenOut per 1 tokenIn, or null. */
  navPrice: number | null;
  /** Which oracle answered and how old the reading was (seconds). */
  navSource: string | null;
  navAgeSec: number | null;
  /** Whether the SwapBook has an on-chain feed for this pair (so a quote
   *  can carry a NAV band and a standing order can be oracle-pegged). */
  oracleOnChain: boolean;
  /** Issuer-direct NAV (e.g. Etherfuse's mint/redeem price) for the
   *  same amount, when either side is an issuer-priced RWA; informational
   *  beside the oracle NAV the contract enforces. */
  issuerNavAmountOut: string | null;
  issuerNavSource: string | null;
  issuerNavAgeSec: number | null;
  /** Oracle NAV vs issuer NAV, bps (positive = oracle pays less). */
  issuerVsOracleBps: number | null;
  /** Best AMM/DEX route net output, or null when no route exists. */
  ammAmountOut: string | null;
  ammVsNavBps: number | null;
  ammVenues: string[];
  /** Standing-order (SwapBook) fills available right now. */
  bookAmountOut: string | null;
  bookAmountInUsed: string | null;
  bookVsNavBps: number | null;
  bookFills: number;
}

export interface RfqQuote {
  id: string;
  requestId: string;
  maker: string;
  /** Label of the registered maker key that posted it. */
  makerLabel: string;
  amountOut: string;
  /** Last ledger at which the quote settles (also the auth signature expiry). */
  expiryLedger: number;
  /** Wall-clock estimate of expiryLedger, for countdowns. */
  expiresAt: number;
  nonce: string;
  maxNavDevBps: number;
  /** Signed deviation vs NAV in bps (positive = taker receives less). */
  vsNavBps: number | null;
  /** The maker's signed authorization entry (base64 XDR). */
  signedAuthXdr: string;
  status: QuoteStatus;
  receivedAt: number;
}

export interface RfqRequest {
  id: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
  amountIn: string;
  createdAt: number;
  /** Wall-clock deadline for collecting quotes. */
  expiresAt: number;
  /** Ledger at request creation — makers size expiry from it. */
  ledgerAtCreate: number;
  status: RequestStatus;
  reference: RfqReference;
  quotes: RfqQuote[];
  acceptedQuoteId: string | null;
  settledHash: string | null;
}

export type RfqEvent =
  | { type: 'request.created'; request: PublicRequest }
  | { type: 'request.closed'; requestId: string; status: RequestStatus };

/** What makers and takers see (no signed XDR leaks to the public view). */
export type PublicRequest = Omit<RfqRequest, 'quotes'> & {
  quotes: Array<Omit<RfqQuote, 'signedAuthXdr'>>;
};

export function toPublic(r: RfqRequest): PublicRequest {
  const { quotes, ...rest } = r;
  return {
    ...rest,
    quotes: quotes.map(({ signedAuthXdr: _s, ...q }) => q),
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export class RfqStore {
  private requests = new Map<string, RfqRequest>();
  private listeners = new Set<(ev: RfqEvent) => void>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** How long a closed request stays readable (ms). */
    private retainMs = 10 * 60 * 1000,
    private maxRequests = 2_000
  ) {}

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(Date.now()), 5_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  insert(r: RfqRequest): void {
    if (this.requests.size >= this.maxRequests) {
      // Drop the oldest closed request first, then the oldest overall.
      let victim: RfqRequest | undefined;
      for (const x of this.requests.values()) {
        if (x.status !== 'open' && (!victim || x.createdAt < victim.createdAt)) victim = x;
      }
      if (!victim) victim = this.requests.values().next().value;
      if (victim) this.requests.delete(victim.id);
    }
    this.requests.set(r.id, r);
    this.emit({ type: 'request.created', request: toPublic(r) });
  }

  get(id: string): RfqRequest | undefined {
    return this.requests.get(id);
  }

  open(): RfqRequest[] {
    const now = Date.now();
    return [...this.requests.values()].filter((r) => r.status === 'open' && r.expiresAt > now);
  }

  openCount(): number {
    return this.open().length;
  }

  close(id: string, status: Exclude<RequestStatus, 'open'>): void {
    const r = this.requests.get(id);
    if (!r || r.status !== 'open') return;
    r.status = status;
    this.emit({ type: 'request.closed', requestId: id, status });
  }

  subscribe(fn: (ev: RfqEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  /** Expire open requests past their deadline; forget old closed ones. */
  sweep(now: number): void {
    for (const r of this.requests.values()) {
      if (r.status === 'open' && r.expiresAt <= now) {
        r.status = 'expired';
        this.emit({ type: 'request.closed', requestId: r.id, status: 'expired' });
      }
      if (r.status !== 'open' && now - Math.max(r.createdAt, r.expiresAt) > this.retainMs) {
        this.requests.delete(r.id);
      }
    }
  }

  private emit(ev: RfqEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* a broken listener must not break the others */
      }
    }
  }
}

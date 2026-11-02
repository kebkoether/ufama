/**
 * Etherfuse v2 client — the subset ufama uses: register our own Stellar
 * wallet as a payment account, read its balances, quote and order a
 * same-chain swap (USDC <-> stablebond) and manage the order.
 *
 * v2 facts this encodes (docs.etherfuse.com/v2, read 2026-10-29; v2 is
 * in beta — shapes can change, every change is announced in their
 * changelog):
 *   - Hosts: sandbox https://api.sand.etherfuse.com (Stellar testnet),
 *     production https://api.etherfuse.com. Endpoints sit at the root
 *     (no /ramp prefix).
 *   - Auth: `Authorization: <api_key>` — NO "Bearer" prefix. Keys look
 *     like api_{sand|prod}:{key_id}:{org_id}; production keys need KYB.
 *   - Quotes are synchronous and valid for 2 minutes; orders are
 *     asynchronous (status via GET or `orderUpdated` webhooks).
 *   - Stellar assets are "CODE:ISSUER"; wallets are G-addresses.
 *   - Etherfuse never signs for self-custody wallets: a swap/offramp
 *     order carries fundingInstructions.destination.preparedTransaction
 *     (unsigned XDR, our wallet as source) to sign and submit ourselves.
 *   - Errors are RFC 9457 problem+json; the `type` URL slug is the code.
 */

export type EtherfuseEnv = 'sand' | 'prod';

export const ETHERFUSE_HOSTS: Record<EtherfuseEnv, string> = {
  sand: 'https://api.sand.etherfuse.com',
  prod: 'https://api.etherfuse.com',
};

export type PaymentRail = 'spei' | 'pix' | 'stellar' | 'solana' | 'base' | 'polygon' | 'monad' | 'avalanche';

export interface RailTransferDetails {
  isDefault: boolean;
  status: 'pending' | 'ready' | 'rejected' | 'disabled';
  minAmount?: string;
  maxAmount?: string;
  rejection?: { code: string; message: string };
}

export interface PaymentAccount {
  id: string;
  status: 'pending' | 'ready' | 'rejected' | 'disabled';
  label: string;
  rails: Partial<Record<PaymentRail, { currency?: string; source: RailTransferDetails | null; destination: RailTransferDetails | null }>>;
  createdAt: string;
}

export interface WalletBalance {
  symbol: string;
  /** CODE:ISSUER on Stellar */
  identifier: string;
  balance: string;
  currency: string;
  amountInFiat: string;
  amountInUsd: string;
}

export interface Fee {
  type: 'transactionFee' | 'partnerFee' | 'walletSponsor' | 'bridge';
  amount: string;
  asset: string;
  bps: number | null;
}

export interface Quote {
  quoteId: string;
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceRail: PaymentRail;
  destinationRail: PaymentRail;
  rateAfterFees: string;
  rateBeforeFees: string;
  midMarketRate?: string;
  feeBps: number;
  feeAmount: string;
  fees: Fee[];
  createdAt: string;
  expiresAt: string;
}

export type OrderStatus = 'created' | 'funded' | 'sourcingLiquidity' | 'claimable' | 'completed' | 'failed' | 'canceled' | 'refunded';

export interface PreparedTransaction {
  /** Stellar: unsigned base64 transaction envelope XDR, our wallet as source. */
  transaction: string;
  refreshAfter: string | null;
}

export interface Order {
  id: string;
  organizationId: string;
  status: OrderStatus;
  failure?: { code: string; message: string };
  memo: string | null;
  source: { paymentAccountId: string; amount: string; asset: string; rail: PaymentRail; accountLabel: string };
  destination: { paymentAccountId: string; amount: string; asset: string; rail: PaymentRail; accountLabel: string } | null;
  fees: Fee[];
  fundingInstructions: {
    rail: PaymentRail;
    reference?: string;
    destination?: { expiresAt: string | null; address?: string; memo?: string; preparedTransaction?: PreparedTransaction };
    fundingDeadline: string;
  } | null;
  claimInstructions: unknown | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TokenAsset {
  asset: string;
  chain: string;
  currency: string | null;
  symbol: string;
  name: string;
  image: string | null;
  bridgeDestinations: string[];
}

export class EtherfuseError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Problem slug from the `type` URL, e.g. quote-unavailable. */
    public code: string,
    public instance?: string,
    public retryAfterSec?: number
  ) {
    super(message);
    this.name = 'EtherfuseError';
  }
  get retryable(): boolean {
    return ['quote-unavailable', 'internal-error', 'service-unavailable', 'rate-limit-exceeded'].includes(this.code);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class EtherfuseClient {
  readonly baseUrl: string;
  constructor(
    private opts: {
      apiKey: string;
      env: EtherfuseEnv;
      organizationId: string;
      fetchImpl?: FetchLike;
      timeoutMs?: number;
    }
  ) {
    this.baseUrl = ETHERFUSE_HOSTS[opts.env];
    if (!opts.apiKey.startsWith(`api_${opts.env}:`)) {
      throw new Error(`Etherfuse key does not match env ${opts.env} (keys look like api_${opts.env}:…)`);
    }
  }

  get organizationId(): string {
    return this.opts.organizationId;
  }

  /** Our own org; a 200 proves the key works. */
  me(): Promise<any> {
    return this.call('GET', '/me');
  }

  supportedAssets(filter: { chain?: string; currency?: string } = {}): Promise<{ markets: unknown[]; tokens: TokenAsset[] }> {
    const q = new URLSearchParams();
    if (filter.chain) q.set('chain', filter.chain);
    if (filter.currency) q.set('currency', filter.currency);
    const qs = q.toString();
    return this.call('GET', `/supported_assets${qs ? `?${qs}` : ''}`);
  }

  /** Register (idempotently) a self-custody Stellar wallet as a payment account. */
  registerStellarWallet(address: string, label: string): Promise<PaymentAccount> {
    return this.call('POST', `/organization/${this.org}/payment_account`, {
      kind: 'wallet',
      label,
      accountDetails: { kind: 'address', address, chain: 'stellar' },
    });
  }

  paymentAccount(id: string): Promise<PaymentAccount> {
    return this.call('GET', `/organization/${this.org}/payment_account/${id}`);
  }

  paymentAccounts(): Promise<{ items?: PaymentAccount[]; paymentAccounts?: PaymentAccount[] } | PaymentAccount[]> {
    return this.call('GET', `/organization/${this.org}/payment_accounts`);
  }

  balances(paymentAccountId: string): Promise<{ paymentAccountId: string; chain: string; address: string; observedAt: string; balances: WalletBalance[] }> {
    return this.call('GET', `/organization/${this.org}/payment_account/${paymentAccountId}/balances`);
  }

  /**
   * Same-chain swap quote between two stored wallets (both may be the
   * same wallet). At least one side must be a stablebond; stablecoin to
   * stablecoin is refused by Etherfuse. Valid for 2 minutes.
   */
  quote(params: {
    sourcePaymentAccountId: string;
    destinationPaymentAccountId: string;
    sourceAmount: string;
    sourceAsset: string;
    destinationAsset: string;
    rail?: PaymentRail;
    partnerFeeBpsOverride?: number;
  }): Promise<Quote> {
    return this.call('POST', `/organization/${this.org}/quote`, {
      source: { type: 'stored', id: params.sourcePaymentAccountId },
      destination: { type: 'stored', id: params.destinationPaymentAccountId },
      sourceAmount: params.sourceAmount,
      sourceAsset: params.sourceAsset,
      destinationAsset: params.destinationAsset,
      ...(params.rail ? { sourceRail: params.rail, destinationRail: params.rail } : {}),
      ...(params.partnerFeeBpsOverride !== undefined ? { partnerFeeBpsOverride: params.partnerFeeBpsOverride } : {}),
    });
  }

  createOrder(quoteId: string, memo?: string): Promise<Order> {
    return this.call('POST', `/organization/${this.org}/order`, memo ? { quoteId, memo } : { quoteId });
  }

  order(id: string): Promise<Order> {
    return this.call('GET', `/organization/${this.org}/order/${id}`);
  }

  cancelOrder(id: string): Promise<Order> {
    return this.call('POST', `/organization/${this.org}/order/${id}/cancel`);
  }

  refreshFunding(id: string): Promise<Order> {
    return this.call('POST', `/organization/${this.org}/order/${id}/funding_instructions/refresh`);
  }

  // ─── internals ──────────────────────────────────────

  private get org(): string {
    return encodeURIComponent(this.opts.organizationId);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? (fetch as unknown as FetchLike);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const res = await f(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.opts.apiKey, // no Bearer prefix (Etherfuse v2)
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const slug = typeof data?.type === 'string' ? String(data.type).split('/').pop() ?? 'error' : 'error';
        const ra = Number(res.headers.get('retry-after') ?? '');
        throw new EtherfuseError(
          data?.detail ?? data?.title ?? data?.error ?? `${res.status} ${res.statusText}`,
          res.status,
          slug,
          data?.instance,
          Number.isFinite(ra) ? ra : undefined
        );
      }
      return (data ?? {}) as T;
    } finally {
      clearTimeout(t);
    }
  }
}

/** "CODE:ISSUER" for a classic asset. */
export function stellarAssetId(code: string, issuer: string): string {
  return `${code}:${issuer}`;
}

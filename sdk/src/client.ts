import {
  Asset,
  IntegratorBuild,
  IntegratorQuote,
  RfqEvent,
  RfqPrepareResponse,
  RfqPreview,
  RfqQuote,
  RfqRequest,
  SendResult,
  Token,
  UfamaApiError,
} from './types.js';
import { parseSse } from './sse.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UfamaClientOptions {
  /** API origin. Defaults to the production backend. */
  baseUrl?: string;
  /**
   * API key. Integrator (/v1) keys and RFQ maker keys are different
   * credentials; pass whichever your role needs. Public endpoints
   * (assets, reference, taker RFQ, submit) need none.
   */
  apiKey?: string;
  fetch?: FetchLike;
  /** Per-request timeout, ms. */
  timeoutMs?: number;
}

export const PRODUCTION_URL = 'https://atomicswap-aggregator-production.up.railway.app';

/**
 * Client for every public ufama API surface. Methods are thin, typed
 * wrappers over the REST endpoints; they never touch keys. Signing
 * helpers live in `signing.ts` and take a signer you control.
 */
export class UfamaClient {
  readonly baseUrl: string;
  private apiKey?: string;
  private fetchImpl: FetchLike;
  private timeoutMs: number;

  constructor(opts: UfamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? PRODUCTION_URL).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (!this.fetchImpl) throw new Error('No fetch available: pass { fetch } (Node < 18)');
  }

  // ─── Public ─────────────────────────────────────────

  /** Tradeable universe (curated + venue-discovered) and the P2P corridor. */
  async assets(): Promise<{ assets: Asset[]; p2pAllowed: string[] }> {
    return this.get('/api/assets');
  }

  async health(): Promise<any> {
    return this.get('/api/health');
  }

  /** Submit a signed transaction through the ufama relay. */
  async submit(signedXdr: string): Promise<SendResult> {
    return this.post('/api/swap/submit', { signedXdr });
  }

  // ─── Integrator API (/v1, keyed) ───────────────────

  readonly v1 = {
    health: (): Promise<{ status: string; partner: string; network: string }> => this.get('/v1/health', true),
    tokens: (): Promise<{ tokens: Token[] }> => this.get('/v1/tokens', true),
    quote: (params: {
      assetIn: string;
      assetOut: string;
      amount: string;
      slippageBps?: number;
      feeBps?: number;
      referralAddress?: string;
    }): Promise<IntegratorQuote> => this.post('/v1/quote', params, true),
    build: (params: {
      from: string;
      assetIn: string;
      assetOut: string;
      amount: string;
      slippageBps?: number;
      feeBps?: number;
      referralAddress?: string;
    }): Promise<IntegratorBuild> => this.post('/v1/quote/build', params, true),
    send: (xdr: string): Promise<SendResult> => this.post('/v1/send', { xdr }, true),
  };

  // ─── RFQ ────────────────────────────────────────────

  readonly rfq = {
    /** Reference pricing for a pair/amount without opening a request. */
    reference: (params: { tokenIn: string; tokenOut: string; amountIn: string; taker?: string }): Promise<RfqPreview> =>
      this.get(`/api/rfq/reference?${qs(params)}`).then((r: any) => r.reference),

    // Taker side (public)
    request: (params: {
      taker: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: string;
      ttlSec?: number;
    }): Promise<RfqRequest> => this.post('/api/rfq/request', params).then((r: any) => r.request),
    get: (id: string): Promise<RfqRequest> => this.get(`/api/rfq/${enc(id)}`).then((r: any) => r.request),
    accept: (id: string, quoteId: string): Promise<{ xdr: string; quote: RfqQuote; request: RfqRequest }> =>
      this.post(`/api/rfq/${enc(id)}/accept`, { quoteId }),
    cancel: (id: string): Promise<RfqRequest> => this.post(`/api/rfq/${enc(id)}/cancel`, {}).then((r: any) => r.request),
    settled: (id: string, hash: string): Promise<RfqRequest> =>
      this.post(`/api/rfq/${enc(id)}/settled`, { hash }).then((r: any) => r.request),

    // Maker side (maker key)
    open: (): Promise<RfqRequest[]> => this.get('/api/rfq/open', true).then((r: any) => r.requests),
    prepare: (
      id: string,
      params: { maker: string; amountOut: string; ttlLedgers?: number; maxNavDevBps?: number }
    ): Promise<RfqPrepareResponse> => this.post(`/api/rfq/${enc(id)}/prepare`, params, true),
    submitQuote: (id: string, signedAuthXdr: string): Promise<RfqQuote> =>
      this.post(`/api/rfq/${enc(id)}/quote`, { signedAuthXdr }, true).then((r: any) => r.quote),

    /**
     * Server-sent events for makers: `hello` (with currently open
     * requests), `request.created`, `request.closed`. Resolves when the
     * stream ends or the signal aborts; reconnect in a loop if you want
     * it permanent (see `runMaker`).
     */
    stream: async (onEvent: (ev: RfqEvent) => void, opts: { signal?: AbortSignal } = {}): Promise<void> => {
      const res = await this.fetchImpl(`${this.baseUrl}/api/rfq/stream`, {
        headers: this.headers(true),
        signal: opts.signal,
      });
      if (!res.ok || !res.body) {
        throw new UfamaApiError(await errorText(res), res.status, '/api/rfq/stream');
      }
      for await (const frame of parseSse(res.body)) {
        let data: any;
        try {
          data = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (frame.event === 'hello') onEvent({ type: 'hello', maker: data.maker, open: data.open ?? [] });
        else if (frame.event === 'request.created' || frame.event === 'request.closed') onEvent(data as RfqEvent);
      }
    },
  };

  // ─── Internals ──────────────────────────────────────

  private headers(keyed = false): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (keyed) {
      if (!this.apiKey) throw new Error('This endpoint needs an API key: new UfamaClient({ apiKey })');
      h['x-api-key'] = this.apiKey;
    }
    return h;
  }

  private async get<T = any>(path: string, keyed = false): Promise<T> {
    return this.call('GET', path, undefined, keyed);
  }

  private async post<T = any>(path: string, body: unknown, keyed = false): Promise<T> {
    return this.call('POST', path, body, keyed);
  }

  private async call<T>(method: string, path: string, body: unknown, keyed: boolean): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(keyed),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text.slice(0, 300) };
      }
      if (!res.ok) throw new UfamaApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status, path);
      return data as T;
    } finally {
      clearTimeout(t);
    }
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  return u.toString();
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

async function errorText(res: Response): Promise<string> {
  try {
    const d = await res.json();
    return d?.error ?? `${res.status}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

import { describe, it, expect } from 'vitest';
import { EtherfuseClient, EtherfuseError, stellarAssetId } from './etherfuse-client.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { f, calls };
}

describe('EtherfuseClient', () => {
  it('targets the right host, sends the raw key (no Bearer), and shapes a swap quote', async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith('/quote')) {
        return {
          body: {
            quoteId: 'q1',
            sourceAmount: '100',
            destinationAmount: '92.81',
            sourceAsset: 'USDC:G1',
            destinationAsset: 'USTRY:G2',
            sourceRail: 'stellar',
            destinationRail: 'stellar',
            rateAfterFees: '0.9281',
            rateBeforeFees: '0.9281',
            feeBps: 0,
            feeAmount: '0',
            fees: [],
            createdAt: 'a',
            expiresAt: 'b',
          },
        };
      }
      return { body: {} };
    });
    const c = new EtherfuseClient({ apiKey: 'api_sand:k:org', env: 'sand', organizationId: 'org-1', fetchImpl: f });
    const q = await c.quote({
      sourcePaymentAccountId: 'pa',
      destinationPaymentAccountId: 'pa',
      sourceAmount: '100',
      sourceAsset: 'USDC:G1',
      destinationAsset: 'USTRY:G2',
      rail: 'stellar',
    });
    expect(q.quoteId).toBe('q1');
    expect(calls[0].url).toBe('https://api.sand.etherfuse.com/organization/org-1/quote');
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h.Authorization).toBe('api_sand:k:org');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({
      source: { type: 'stored', id: 'pa' },
      destination: { type: 'stored', id: 'pa' },
      sourceAmount: '100',
      sourceAsset: 'USDC:G1',
      destinationAsset: 'USTRY:G2',
      sourceRail: 'stellar',
      destinationRail: 'stellar',
    });
    await c.registerStellarWallet('GABC', 'maker');
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({
      kind: 'wallet',
      label: 'maker',
      accountDetails: { kind: 'address', address: 'GABC', chain: 'stellar' },
    });
    await c.createOrder('q1');
    expect(JSON.parse(String(calls[2].init!.body))).toEqual({ quoteId: 'q1' });
  });

  it('maps problem+json errors to the slug, with retryability and Retry-After', async () => {
    const { f } = fakeFetch((url) => {
      if (url.endsWith('/quote')) {
        return {
          status: 422,
          body: {
            type: 'https://docs.etherfuse.com/ramp/v2/errors/quote-unavailable',
            title: 'Quote unavailable',
            status: 422,
            detail: 'cannot price this route right now',
            instance: 'tag:etherfuse.com,2026:R2-1',
          },
        };
      }
      if (url.endsWith('/balances')) {
        return { status: 429, body: { type: '.../rate-limit-exceeded', title: 'Slow down', status: 429, detail: 'x', instance: 'i' }, headers: { 'Retry-After': '7' } };
      }
      return { status: 404, body: '' };
    });
    const c = new EtherfuseClient({ apiKey: 'api_prod:k:org', env: 'prod', organizationId: 'o', fetchImpl: f });
    const err = await c
      .quote({ sourcePaymentAccountId: 'a', destinationPaymentAccountId: 'a', sourceAmount: '1', sourceAsset: 'x', destinationAsset: 'y' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EtherfuseError);
    expect(err.code).toBe('quote-unavailable');
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(true);
    expect(err.instance).toBe('tag:etherfuse.com,2026:R2-1');
    const rl = await c.balances('pa').catch((e) => e);
    expect(rl.code).toBe('rate-limit-exceeded');
    expect(rl.retryAfterSec).toBe(7);
    const nf = await c.order('nope').catch((e) => e);
    expect(nf.status).toBe(404);
    expect(nf.retryable).toBe(false);
  });

  it('refuses a key from the other environment', () => {
    expect(() => new EtherfuseClient({ apiKey: 'api_prod:k:o', env: 'sand', organizationId: 'o' })).toThrow(/does not match env/);
    expect(stellarAssetId('USTRY', 'GABC')).toBe('USTRY:GABC');
  });
});

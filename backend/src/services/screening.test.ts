import { describe, it, expect } from 'vitest';
import { Screener, configFromEnv, BlockedAddressError } from './screening.js';

const G1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const G2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { f, calls };
}

const predicateEnv = {
  SCREENING_PROVIDER: 'predicate',
  PREDICATE_API_KEY: 'pk_test',
  PREDICATE_VERIFICATION_HASH: 'vh_123',
};

describe('screening', () => {
  it('none allows everything; denylist blocks exact matches', async () => {
    expect(await new Screener(configFromEnv({})).isBlocked(G1)).toBe(false);
    const s = new Screener(configFromEnv({ SCREENING_PROVIDER: 'denylist', SCREENING_DENYLIST: `${G1}, ${G2}` }));
    expect(await s.isBlocked(G1)).toBe(true);
    await expect(s.assertNotBlocked(G2)).rejects.toBeInstanceOf(BlockedAddressError);
    expect(await s.isBlocked('GCCC')).toBe(false);
  });

  it('predicate: documented v2 request shape, is_compliant verdict, 10-minute cache', async () => {
    let t = 1_000_000;
    const { f, calls } = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init!.body));
      return { body: { is_compliant: body.from !== G2, reason: body.from === G2 ? 'sanctioned' : undefined } };
    });
    const s = new Screener(configFromEnv(predicateEnv), f, () => t);
    expect(await s.isBlocked(G1)).toBe(false);
    expect(await s.isBlocked(G2)).toBe(true);
    expect(calls[0].url).toBe('https://api.predicate.io/v2/attestation');
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('pk_test');
    expect(h.authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ verification_hash: 'vh_123', from: G1, chain: 'stellar' });
    // cached
    await s.isBlocked(G1);
    await s.isBlocked(G2);
    expect(calls.length).toBe(2);
    t += 11 * 60 * 1000;
    await s.isBlocked(G1);
    expect(calls.length).toBe(3);
  });

  it('predicate: provider errors fail open by default and closed with SCREENING_FAIL_CLOSED', async () => {
    const { f } = fakeFetch(() => ({ status: 503, body: { error: 'down' } }));
    expect(await new Screener(configFromEnv(predicateEnv), f).isBlocked(G1)).toBe(false);
    expect(await new Screener(configFromEnv({ ...predicateEnv, SCREENING_FAIL_CLOSED: '1' }), f).isBlocked(G1)).toBe(true);
    const bad = fakeFetch(() => ({ body: { allowed: true } })); // old guessed shape -> error -> fail-open
    expect(await new Screener(configFromEnv(predicateEnv), bad.f).isBlocked(G1)).toBe(false);
    const unset = new Screener(configFromEnv({ SCREENING_PROVIDER: 'predicate', SCREENING_FAIL_CLOSED: '1' }), f);
    expect(await unset.isBlocked(G1)).toBe(true);
  });
});

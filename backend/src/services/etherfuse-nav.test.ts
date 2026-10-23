import { describe, it, expect } from 'vitest';
import { EtherfuseNavService } from './etherfuse-nav.js';

const ISSUER = 'GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC';

function fakeFetch(opts: { costOk?: boolean; bondsOk?: boolean; calls?: string[] } = {}) {
  return async (url: string) => {
    opts.calls?.push(url);
    if (url.endsWith('/tokens/cost')) {
      return {
        ok: opts.costOk ?? true,
        json: async () => ({
          USTRY: { token_symbol: 'USTRY', currency: 'USD', token_cost_in_usd: '1.077984', token_cost_in_fiat: '1.077984', current_basis_points: 360, current_time: '2026-10-23T21:51:35Z' },
          CETES: { token_symbol: 'CETES', currency: 'MXN', token_cost_in_usd: '0.063614', token_cost_in_fiat: '1.187573', current_basis_points: 555, current_time: '2026-10-23T21:51:35Z' },
          MEXE: { token_symbol: 'MEXe', underlying_bond_symbol: 'CETES', currency: 'MXN', token_cost_in_usd: '0.053566', token_cost_in_fiat: '1', current_basis_points: 0, current_time: 'nope' },
          BROKEN: { token_symbol: 'BROKEN', token_cost_in_usd: '0' },
        }),
      };
    }
    return {
      ok: opts.bondsOk ?? true,
      json: async () => ({
        stablebonds: [
          { symbol: 'USTRY', blockchains: [{ blockchain: 'solana', tokenIdentifier: 'USTRYnG…' }, { blockchain: 'stellar', tokenIdentifier: `USTRY-${ISSUER}` }] },
          { symbol: 'CETES', blockchains: [{ blockchain: 'stellar', tokenIdentifier: `CETES-${ISSUER}` }] },
        ],
      }),
    };
  };
}

describe('EtherfuseNavService', () => {
  it('maps issuer NAV by symbol with the Stellar issuer bound', async () => {
    const calls: string[] = [];
    const svc = new EtherfuseNavService({ fetchImpl: fakeFetch({ calls }) });
    const ustry = await svc.lookup('ustry', ISSUER);
    expect(ustry).toMatchObject({ symbol: 'USTRY', usd: 1.077984, currency: 'USD', yieldBps: 360, stellarIssuer: ISSUER });
    expect(ustry!.timestamp).toBe(Math.floor(Date.parse('2026-10-23T21:51:35Z') / 1000));
    const cetes = await svc.lookup('CETES');
    expect(cetes!.fiat).toBe(1.187573);
    // a different issuer claiming the same code is not the Etherfuse bond
    expect(await svc.lookup('USTRY', 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBeNull();
    expect(await svc.lookup('BROKEN')).toBeNull();
    expect(await svc.lookup('XLM')).toBeNull();
    // one fetch pair, then cache
    expect(calls.length).toBe(2);
  });

  it('survives a bonds-lookup failure and a cost failure', async () => {
    const svc = new EtherfuseNavService({ fetchImpl: fakeFetch({ bondsOk: false }) });
    const u = await svc.lookup('USTRY', ISSUER);
    expect(u?.usd).toBe(1.077984);
    expect(u?.stellarIssuer).toBeNull();
    const dead = new EtherfuseNavService({ fetchImpl: fakeFetch({ costOk: false }) });
    expect(await dead.lookup('USTRY')).toBeNull();
  });
});

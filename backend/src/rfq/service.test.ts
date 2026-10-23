import { describe, it, expect, beforeEach } from 'vitest';
import { StrKey, Keypair } from '@stellar/stellar-sdk';
import { RfqService, RfqError } from './service.js';
import { RfqStore } from './store.js';

const RFQ = StrKey.encodeContract(Buffer.alloc(32, 7));
const USDC = StrKey.encodeContract(Buffer.alloc(32, 1));
const BOND = StrKey.encodeContract(Buffer.alloc(32, 2));
const TAKER = Keypair.random().publicKey();

/** Enough of StellarClient / FairValueService for the request path. */
function deps(overrides: Partial<ConstructorParameters<typeof RfqService>[0]> = {}) {
  const store = new RfqStore();
  return {
    store,
    service: new RfqService({
      stellar: {
        getLatestLedger: async () => 1_000,
        simulateAndParse: async () => null,
        simulateAuthEntries: async () => {
          throw new Error('no network in tests');
        },
        buildTransaction: async () => {
          throw new Error('no network in tests');
        },
      } as any,
      rfqContractId: RFQ,
      store,
      fairValue: {
        // USDC $1.00, bond $10.50 — both "redstone", 60s old
        quoteUsd: async (sac: string) => ({
          price: sac === USDC ? 1 : 10.5,
          source: 'redstone',
          timestamp: Math.floor(Date.now() / 1000) - 60,
        }),
      } as any,
      tokenMeta: (sac) => (sac === USDC ? { symbol: 'USDC', decimals: 7 } : { symbol: 'BOND', decimals: 18 }),
      oracleOnChain: async () => true,
      ammQuote: async () => ({ amountOut: 99_500_000_000_000_000_000n, venues: ['Aqua'] }),
      bookPlan: async () => ({ fills: 1, amountOut: 50_000_000_000_000_000_000n, amountInUsed: 525_0000000n }),
      ...overrides,
    }),
  };
}

describe('RfqService.createRequest', () => {
  let s: ReturnType<typeof deps>;
  beforeEach(() => {
    s = deps();
  });

  it('builds a reference with decimal-correct NAV and bps labels', async () => {
    // 1,050 USDC (7 dec) at $1 → 100 bonds (18 dec) at $10.50
    const r = await s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 1_050_0000000n });
    expect(r.reference.navAmountOut).toBe((100n * 10n ** 18n).toString());
    expect(r.reference.navPrice).toBeCloseTo(1 / 10.5, 10);
    expect(r.reference.navSource).toBe('redstone');
    expect(r.reference.navAgeSec).toBeGreaterThanOrEqual(60);
    expect(r.reference.oracleOnChain).toBe(true);
    // AMM pays 99.5 bonds vs NAV 100 → 50 bps short
    expect(r.reference.ammVsNavBps).toBe(50);
    expect(r.reference.ammVenues).toEqual(['Aqua']);
    // Book fills half the budget (525 USDC) for 50 bonds → exactly NAV pro-rata
    expect(r.reference.bookFills).toBe(1);
    expect(r.reference.bookVsNavBps).toBe(0);
    expect(r.status).toBe('open');
    expect(r.expiresAt - r.createdAt).toBe(20_000);
    expect(r.decimalsOut).toBe(18);
  });

  it('clamps ttl and refuses degenerate input', async () => {
    const r = await s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 1n, ttlSec: 9_999 });
    expect(r.expiresAt - r.createdAt).toBe(120_000);
    await expect(
      s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: USDC, amountIn: 1n })
    ).rejects.toThrow(/must differ/);
    await expect(
      s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 0n })
    ).rejects.toThrow(/positive/);
  });

  it('falls back to the on-chain fair value when no off-chain feed covers the pair', async () => {
    const t = deps({
      fairValue: { quoteUsd: async () => null } as any,
      stellar: {
        getLatestLedger: async () => 1_000,
        simulateAndParse: async (_c: string, fn: string) => (fn === 'fair_value' ? 123n : null),
      } as any,
    });
    const r = await t.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 1_0000000n });
    expect(r.reference.navAmountOut).toBe('123');
    expect(r.reference.navSource).toBe('swapbook');
  });

  it('caps open requests per taker and spaces them out', async () => {
    const mk = () => s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 1_0000000n });
    await mk();
    // Second one inside the 2s window is refused
    await expect(mk()).rejects.toMatchObject({ status: 429 });
    // Backdate the first so spacing passes, then fill the cap
    for (const r of s.store.open()) r.createdAt -= 10_000;
    await mk();
    for (const r of s.store.open()) r.createdAt -= 10_000;
    await mk();
    for (const r of s.store.open()) r.createdAt -= 10_000;
    const err = await mk().catch((e) => e);
    expect(err).toBeInstanceOf(RfqError);
    expect(err.message).toMatch(/too many open/);
    // Cancelling one frees a slot
    s.service.cancel(s.store.open()[0].id);
    await mk();
  });
});

describe('RfqService quote intake', () => {
  it('rejects malformed and mismatched signed entries before touching the network', async () => {
    const s = deps();
    const r = await s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 1_0000000n });
    await expect(
      s.service.submitQuote(r.id, { signedAuthXdr: 'garbage', makerLabel: 'x' })
    ).rejects.toThrow(/not a valid/);
    await expect(s.service.accept(r.id, 'nope')).rejects.toMatchObject({ status: 404 });
    s.service.cancel(r.id);
    await expect(
      s.service.prepareQuote(r.id, { maker: Keypair.random().publicKey(), amountOut: 1n })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('is disabled without a contract id', async () => {
    const s = deps({ rfqContractId: '' });
    expect(s.service.enabled).toBe(false);
    await expect(
      s.service.createRequest({ taker: TAKER, tokenIn: USDC, tokenOut: BOND, amountIn: 1n })
    ).rejects.toMatchObject({ status: 503 });
  });
});

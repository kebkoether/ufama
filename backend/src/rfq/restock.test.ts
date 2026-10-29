import { describe, it, expect } from 'vitest';
import { Restocker, RestockDeps } from './restock.js';

function harness(over: Partial<RestockDeps> = {}) {
  const log: string[] = [];
  const orders = new Map<string, any>();
  let quotes = 0;
  const submitted: string[] = [];
  const etherfuse = {
    quote: async (p: any) => {
      quotes++;
      return { quoteId: `q${quotes}`, sourceAmount: p.sourceAmount, destinationAmount: '92.8', feeBps: 0, rateBeforeFees: '0.928' } as any;
    },
    createOrder: async (quoteId: string) => {
      const o = {
        id: quoteId,
        status: 'created',
        fundingInstructions: { rail: 'stellar', destination: { expiresAt: null, address: 'GPOOL', preparedTransaction: { transaction: `XDR-${quoteId}`, refreshAfter: null } }, fundingDeadline: 'd' },
      };
      orders.set(quoteId, o);
      return o as any;
    },
    order: async (id: string) => orders.get(id),
    refreshFunding: async (id: string) => {
      const o = orders.get(id);
      o.fundingInstructions.destination.preparedTransaction.transaction = `XDR-${id}-fresh`;
      return o;
    },
    balances: async () => ({}) as any,
  };
  const balances = { USTRY: 10, CETES: 5000 };
  const deps: RestockDeps = {
    etherfuse,
    paymentAccountId: 'pa',
    sourceAsset: 'USDC:G1',
    balances: async () => balances,
    signAndSubmit: async (xdr) => {
      submitted.push(xdr);
      return `hash-${submitted.length}`;
    },
    targets: [
      { symbol: 'USTRY', asset: 'USTRY:G2', minBalance: 50, spend: '100' },
      { symbol: 'CETES', asset: 'CETES:G3', minBalance: 1000, spend: '50' },
    ],
    log: (m) => log.push(m),
    ...over,
  };
  return { r: new Restocker(deps), log, orders, submitted, balances, quotesMade: () => quotes };
}

describe('Restocker', () => {
  it('refills only what is below the floor, funds the order, then waits for it', async () => {
    const h = harness();
    const first = await h.r.tick();
    expect(first).toEqual([
      { symbol: 'USTRY', action: 'funded', orderId: 'q1', hash: 'hash-1' },
      { symbol: 'CETES', action: 'skipped', reason: 'holds 5000 ≥ 1000' },
    ]);
    expect(h.submitted).toEqual(['XDR-q1']);
    // Still pending → no second order even though the balance is still low
    const second = await h.r.tick();
    expect(second[0]).toMatchObject({ symbol: 'USTRY', action: 'skipped', orderId: 'q1', reason: 'order created' });
    expect(h.quotesMade()).toBe(1);
    // Completes → balance restored → nothing to do
    h.orders.get('q1').status = 'completed';
    h.balances.USTRY = 100;
    const third = await h.r.tick();
    expect(third[0]).toMatchObject({ symbol: 'USTRY', action: 'skipped', reason: 'holds 100 ≥ 50' });
    expect(h.log.some((l) => l.includes('completed'))).toBe(true);
  });

  it('re-funds with refreshed instructions on a stale sequence, and reports failures', async () => {
    let attempts = 0;
    const h = harness({
      signAndSubmit: async (xdr) => {
        attempts++;
        if (attempts === 1) throw new Error('Horizon: tx_bad_seq');
        return `hash-${xdr}`;
      },
    });
    const res = await h.r.tick();
    expect(res[0]).toEqual({ symbol: 'USTRY', action: 'funded', orderId: 'q1', hash: 'hash-XDR-q1-fresh' });
    h.orders.get('q1').status = 'failed';
    h.orders.get('q1').failure = { code: 'fulfillmentFailed', message: 'no liquidity' };
    const next = await h.r.tick();
    expect(next[0]).toMatchObject({ symbol: 'USTRY', action: 'failed', orderId: 'q1', reason: 'failed' });
    // A failed order clears the pending slot so the next tick may retry
    const retry = await h.r.tick();
    expect(retry[0].action).toBe('funded');
    expect(retry[0].orderId).toBe('q2');
  });

  it('skips a quote whose fee is above the cap', async () => {
    const h = harness({
      etherfuse: {
        quote: async () => ({ quoteId: 'q', feeBps: 40, destinationAmount: '1', sourceAmount: '1', rateBeforeFees: '1' }) as any,
        createOrder: async () => {
          throw new Error('should not order');
        },
        order: async () => null as any,
        refreshFunding: async () => null as any,
        balances: async () => ({}) as any,
      },
      maxFeeBps: 25,
    });
    const res = await h.r.tick();
    expect(res[0]).toMatchObject({ symbol: 'USTRY', action: 'skipped', reason: 'quote fee 40 bps above cap' });
  });
});

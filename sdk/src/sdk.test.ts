import { describe, it, expect } from 'vitest';
import { Keypair, Networks, StrKey, authorizeInvocation, xdr, Address } from '@stellar/stellar-sdk';
import { UfamaClient } from './client.js';
import { signQuoteEntry, entrySigner } from './signing.js';
import { priceAtNavMinus, acceptableQuotes, runMaker } from './flows.js';
import { toFrame, parseSse } from './sse.js';
import type { RfqRequest } from './types.js';

const RFQ = StrKey.encodeContract(Buffer.alloc(32, 7));

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; stream?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r.stream !== undefined) {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(r.stream!));
          c.close();
        },
      });
      return new Response(body, { status: r.status ?? 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { f, calls };
}

function sampleRequest(over: Partial<RfqRequest> = {}): RfqRequest {
  return {
    id: 'rfq_1',
    taker: 'GTAKER',
    tokenIn: 'CIN',
    tokenOut: 'COUT',
    symbolIn: 'USDC',
    symbolOut: 'USTRY',
    decimalsIn: 7,
    decimalsOut: 7,
    amountIn: '1000000000',
    createdAt: Date.now(),
    expiresAt: Date.now() + 20_000,
    ledgerAtCreate: 1,
    status: 'open',
    reference: {
      navAmountOut: '928000000',
      navPrice: 0.928,
      navSource: 'redstone',
      navAgeSec: 10,
      oracleOnChain: true,
      issuerNavAmountOut: null,
      issuerNavSource: null,
      issuerNavAgeSec: null,
      issuerVsOracleBps: null,
      ammAmountOut: null,
      ammVsNavBps: null,
      ammVenues: [],
      bookAmountOut: null,
      bookAmountInUsed: null,
      bookVsNavBps: null,
      bookFills: 0,
    },
    quotes: [],
    acceptedQuoteId: null,
    settledHash: null,
    ...over,
  };
}

describe('UfamaClient', () => {
  it('builds URLs, sends keys only where required, and surfaces API errors', async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith('/api/assets')) return { body: { assets: [], p2pAllowed: ['USDC'] } };
      if (url.includes('/api/rfq/reference?')) return { body: { reference: { navAmountOut: '1' } } };
      if (url.endsWith('/v1/tokens')) return { body: { tokens: [] } };
      if (url.endsWith('/api/rfq/request')) return { status: 429, body: { error: 'too many open requests' } };
      return { status: 404, body: { error: 'nope' } };
    });
    const c = new UfamaClient({ baseUrl: 'https://x.test/', apiKey: 'k', fetch: f });
    expect((await c.assets()).p2pAllowed).toEqual(['USDC']);
    expect(calls[0].url).toBe('https://x.test/api/assets');
    expect((calls[0].init!.headers as any)['x-api-key']).toBeUndefined();
    await c.rfq.reference({ tokenIn: 'USDC', tokenOut: 'USTRY', amountIn: '1', taker: undefined });
    expect(calls[1].url).toBe('https://x.test/api/rfq/reference?tokenIn=USDC&tokenOut=USTRY&amountIn=1');
    await c.v1.tokens();
    expect((calls[2].init!.headers as any)['x-api-key']).toBe('k');
    await expect(c.rfq.request({ taker: 'G', tokenIn: 'a', tokenOut: 'b', amountIn: '1' })).rejects.toMatchObject({
      status: 429,
      message: 'too many open requests',
    });
    const noKey = new UfamaClient({ baseUrl: 'https://x.test', fetch: f });
    await expect(noKey.v1.tokens()).rejects.toThrow(/needs an API key/);
  });

  it('parses the maker SSE stream', async () => {
    const stream =
      'event: hello\ndata: {"maker":"SDF","open":[]}\n\n: hb\n\nevent: request.created\ndata: {"type":"request.created","request":{"id":"rfq_9"}}\n\n';
    const { f } = fakeFetch(() => ({ stream }));
    const c = new UfamaClient({ baseUrl: 'https://x.test', apiKey: 'k', fetch: f });
    const events: any[] = [];
    await c.rfq.stream((ev) => events.push(ev));
    expect(events.map((e) => e.type)).toEqual(['hello', 'request.created']);
    expect(events[1].request.id).toBe('rfq_9');
  });
});

describe('sse parser', () => {
  it('handles comments, multi-line data and chunk boundaries', async () => {
    expect(toFrame(': hb')).toBeNull();
    expect(toFrame('event: x\ndata: a\ndata: b')).toEqual({ event: 'x', data: 'a\nb' });
    const enc = new TextEncoder();
    const chunks = ['event: a\nda', 'ta: 1\n\nevent: b\ndata: 2\n', '\n'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const out: any[] = [];
    for await (const fr of parseSse(body)) out.push(fr);
    expect(out).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });
});

describe('signing', () => {
  it('signs a prepared entry with the maker key and keeps the signer visible', async () => {
    const maker = Keypair.random();
    const inv = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(RFQ).toScAddress(),
          functionName: 'settle_quote',
          args: [xdr.ScVal.scvVoid()],
        })
      ),
      subInvocations: [],
    });
    // An unsigned entry as the API would hand it over (void signature)
    const unsigned = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(maker.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('77') as any,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: inv,
    });
    const b64 = unsigned.toXDR('base64');
    expect(entrySigner(b64)).toBe(maker.publicKey());
    const signed = await signQuoteEntry(b64, maker, 12_345, Networks.TESTNET);
    const back = xdr.SorobanAuthorizationEntry.fromXDR(signed, 'base64');
    const ac: any = (back.credentials as any).address;
    expect(Number(ac.signatureExpirationLedger)).toBe(12_345);
    expect((ac.signature as any).type).not.toBe('scvVoid');
    // Matches what the SDK's own authorizeInvocation would produce structurally
    const ref = await authorizeInvocation({ signer: maker, validUntilLedgerSeq: 12_345, invocation: inv, networkPassphrase: Networks.TESTNET, authV2: false });
    expect((ref.credentials as any).type).toBe((back.credentials as any).type);
  });
});

describe('flows', () => {
  it('prices NAV minus a spread and ranks acceptable quotes', () => {
    const r = sampleRequest();
    expect(priceAtNavMinus(r, 5)).toBe(927536000n);
    expect(priceAtNavMinus(sampleRequest({ reference: { ...r.reference, navAmountOut: null } }), 5)).toBeNull();
    const now = Date.now();
    const q = (id: string, out: string, status: any = 'live', expiresAt = now + 60_000) =>
      ({ id, requestId: r.id, maker: 'G', makerLabel: 'm', amountOut: out, expiryLedger: 1, expiresAt, nonce: '1', maxNavDevBps: 50, vsNavBps: 0, status, receivedAt: now }) as any;
    const ranked = acceptableQuotes(
      sampleRequest({ quotes: [q('a', '1'), q('b', '3'), q('c', '2'), q('d', '9', 'superseded'), q('e', '8', 'live', now + 1000)] }),
      now
    );
    expect(ranked.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('runMaker prices, prepares, signs locally and posts; skips what it cannot price', async () => {
    const maker = Keypair.random();
    const req = sampleRequest();
    const unsignedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(maker.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('5') as any,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({ contractAddress: new Address(RFQ).toScAddress(), functionName: 'settle_quote', args: [] })
        ),
        subInvocations: [],
      }),
    }).toXDR('base64');
    const posted: any[] = [];
    const ctl = new AbortController();
    const { f } = fakeFetch((url, init) => {
      if (url.endsWith('/api/rfq/stream')) {
        return {
          stream: `event: hello\ndata: ${JSON.stringify({ maker: 'm', open: [req, { ...req, id: 'rfq_skip', reference: { ...req.reference, navAmountOut: null } }] })}\n\n`,
        };
      }
      if (url.endsWith('/prepare')) {
        const body = JSON.parse(String(init!.body));
        posted.push({ prepare: body });
        return { body: { quote: { expiryLedger: 500, nonce: '5' }, authEntryXdr: unsignedEntry, check: {} } };
      }
      if (url.endsWith('/quote')) {
        posted.push({ quote: JSON.parse(String(init!.body)) });
        return { body: { quote: { id: 'q_1', status: 'live', amountOut: '1' } } };
      }
      return { status: 404, body: { error: 'nope' } };
    });
    const client = new UfamaClient({ baseUrl: 'https://x.test', apiKey: 'k', fetch: f });
    const quoted: string[] = [];
    const skipped: string[] = [];
    const loop = runMaker({
      client,
      maker: maker.publicKey(),
      signer: maker,
      networkPassphrase: Networks.TESTNET,
      price: (r) => priceAtNavMinus(r, 5),
      onQuoted: (r, q) => {
        quoted.push(`${r.id}:${q.id}`);
        ctl.abort();
      },
      onSkipped: (r, why) => skipped.push(`${r.id}:${why}`),
      signal: ctl.signal,
      backoffMs: { min: 1, max: 2 },
    });
    await loop;
    expect(quoted).toEqual(['rfq_1:q_1']);
    expect(skipped).toEqual(['rfq_skip:price() returned null']);
    expect(posted[0].prepare).toEqual({ maker: maker.publicKey(), amountOut: '927536000' });
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(posted[1].quote.signedAuthXdr, 'base64');
    expect(Number(((signed.credentials as any).address as any).signatureExpirationLedger)).toBe(500);
  });
});

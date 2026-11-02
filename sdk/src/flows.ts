/**
 * Higher-level flows built on the client: a taker settling a quote with
 * a wallet, and a maker loop answering requests with locally signed
 * quotes. Both are small so you can copy and adapt them.
 */

import type { Keypair } from '@stellar/stellar-sdk';
import { UfamaClient } from './client.js';
import { signQuoteEntry, SigningCallback } from './signing.js';
import { RfqQuote, RfqRequest, UfamaApiError } from './types.js';

/** Live quotes a taker can still act on, best first. */
export function acceptableQuotes(r: RfqRequest, now = Date.now()): RfqQuote[] {
  return r.quotes
    .filter((q) => q.status === 'live' && q.expiresAt > now + 3_000)
    .sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : 0));
}

/**
 * Open a request, wait for quotes, accept the best one, sign with the
 * wallet you pass, submit, report. Resolves with the tx hash and the
 * quote; throws if nobody answered inside the window.
 */
export async function requestAndSettle(
  client: UfamaClient,
  params: { taker: string; tokenIn: string; tokenOut: string; amountIn: string; ttlSec?: number },
  signTransaction: (xdr: string) => Promise<string>,
  opts: { pollMs?: number; minQuotes?: number; waitAfterFirstMs?: number } = {}
): Promise<{ hash: string; quote: RfqQuote; request: RfqRequest }> {
  const r = await client.rfq.request(params);
  const pollMs = opts.pollMs ?? 1500;
  let firstSeen: number | null = null;
  let latest = r;
  for (;;) {
    await sleep(pollMs);
    latest = await client.rfq.get(r.id);
    const live = acceptableQuotes(latest);
    if (live.length > 0 && firstSeen === null) firstSeen = Date.now();
    const windowOver = Date.now() >= latest.expiresAt;
    const enough = live.length >= (opts.minQuotes ?? 1) && (windowOver || Date.now() - (firstSeen ?? 0) >= (opts.waitAfterFirstMs ?? 3_000));
    if (enough) break;
    if (windowOver && live.length === 0) throw new Error(`no quotes for request ${r.id}`);
    if (latest.status !== 'open' && live.length === 0) throw new Error(`request ${r.id} is ${latest.status}`);
  }
  const best = acceptableQuotes(latest)[0];
  const { xdr, quote } = await client.rfq.accept(r.id, best.id);
  const signed = await signTransaction(xdr);
  const sent = await client.submit(signed);
  if (!sent.hash) throw new Error(`submit returned no hash (${sent.status})`);
  await client.rfq.settled(r.id, sent.hash).catch(() => {});
  return { hash: sent.hash, quote, request: latest };
}

export interface MakerOptions {
  client: UfamaClient;
  /** Public address of the quoting wallet. */
  maker: string;
  /** Keypair or signing callback for that wallet. */
  signer: Keypair | SigningCallback;
  networkPassphrase: string;
  /**
   * Price a request: return the amountOut (base units of tokenOut) you
   * will deliver, or null to skip. `request.reference` carries the
   * oracle NAV, issuer NAV, DEX route and book for the same amount.
   */
  price: (request: RfqRequest) => Promise<bigint | null> | bigint | null;
  /** On-chain NAV band to request (bps); 0 = none. Default 50 when the pair has a feed. */
  maxNavDevBps?: (request: RfqRequest) => number | undefined;
  onQuoted?: (request: RfqRequest, quote: RfqQuote) => void;
  onSkipped?: (request: RfqRequest, reason: string) => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
  /** Reconnect backoff bounds, ms. */
  backoffMs?: { min?: number; max?: number };
}

/**
 * Permanent maker loop: subscribe to requests, price each one, ask the
 * API for the exact auth entry, sign it locally, post it. Reconnects
 * with backoff until `signal` aborts.
 */
export async function runMaker(o: MakerOptions): Promise<void> {
  const seen = new Set<string>();
  let backoff = o.backoffMs?.min ?? 1_000;
  const quote = async (r: RfqRequest) => {
    if (seen.has(r.id) || r.taker === o.maker || r.status !== 'open') return;
    seen.add(r.id);
    if (seen.size > 5_000) seen.clear();
    try {
      const out = await o.price(r);
      if (out === null || out <= 0n) {
        o.onSkipped?.(r, 'price() returned null');
        return;
      }
      const prep = await o.client.rfq.prepare(r.id, {
        maker: o.maker,
        amountOut: out.toString(),
        maxNavDevBps: o.maxNavDevBps?.(r),
      });
      const signed = await signQuoteEntry(prep.authEntryXdr, o.signer, prep.quote.expiryLedger, o.networkPassphrase);
      const q = await o.client.rfq.submitQuote(r.id, signed);
      o.onQuoted?.(r, q);
    } catch (err) {
      if (err instanceof UfamaApiError && err.status < 500) o.onSkipped?.(r, err.message);
      else o.onError?.(err);
    }
  };
  while (!o.signal?.aborted) {
    try {
      await o.client.rfq.stream(
        (ev) => {
          if (ev.type === 'hello') for (const r of ev.open) void quote(r);
          else if (ev.type === 'request.created') void quote(ev.request);
        },
        { signal: o.signal }
      );
      backoff = o.backoffMs?.min ?? 1_000;
    } catch (err) {
      if (o.signal?.aborted) return;
      o.onError?.(err);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, o.backoffMs?.max ?? 30_000);
  }
}

/** NAV minus a spread, in base units of tokenOut; null without a NAV reference. */
export function priceAtNavMinus(request: RfqRequest, spreadBps: number): bigint | null {
  const nav = request.reference.navAmountOut;
  if (!nav) return null;
  return (BigInt(nav) * BigInt(10_000 - spreadBps)) / 10_000n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

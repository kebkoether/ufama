'use client';

/**
 * RFQ client: API helpers + a hook that runs the taker's state machine.
 *
 *   start()  → POST /api/rfq/request, then poll GET /api/rfq/:id while
 *              quotes are being collected (countdown from expiresAt)
 *   accept() → POST /api/rfq/:id/accept → wallet signs → /api/swap/submit
 *              → POST /api/rfq/:id/settled
 *
 * Quotes stay acceptable for a grace period after the countdown ends
 * (their own expiresAt), so the panel keeps showing them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, submitTransaction } from './api';

export interface RfqReference {
  navAmountOut: string | null;
  navPrice: number | null;
  navSource: string | null;
  navAgeSec: number | null;
  oracleOnChain: boolean;
  issuerNavAmountOut: string | null;
  issuerNavSource: string | null;
  issuerNavAgeSec: number | null;
  issuerVsOracleBps: number | null;
  ammAmountOut: string | null;
  ammVsNavBps: number | null;
  ammVenues: string[];
  bookAmountOut: string | null;
  bookAmountInUsed: string | null;
  bookVsNavBps: number | null;
  bookFills: number;
}

export interface RfqQuote {
  id: string;
  maker: string;
  makerLabel: string;
  amountOut: string;
  expiryLedger: number;
  expiresAt: number;
  vsNavBps: number | null;
  maxNavDevBps: number;
  status: 'live' | 'accepted' | 'superseded' | 'expired' | 'rejected';
}

export interface RfqRequest {
  id: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  createdAt: number;
  expiresAt: number;
  status: 'open' | 'accepted' | 'settled' | 'expired' | 'cancelled';
  reference: RfqReference;
  quotes: RfqQuote[];
  acceptedQuoteId: string | null;
  settledHash: string | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} failed: ${res.statusText}`);
  return data as T;
}

export async function createRfq(body: {
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  ttlSec?: number;
}): Promise<RfqRequest> {
  return (await post<{ request: RfqRequest }>('/api/rfq/request', body)).request;
}

export async function getRfq(id: string): Promise<RfqRequest> {
  const res = await fetch(`${API_BASE}/api/rfq/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `RFQ read failed: ${res.statusText}`);
  return data.request as RfqRequest;
}

export async function acceptRfq(id: string, quoteId: string): Promise<{ xdr: string; quote: RfqQuote }> {
  return post(`/api/rfq/${id}/accept`, { quoteId });
}

export async function cancelRfq(id: string): Promise<void> {
  await post(`/api/rfq/${id}/cancel`, {});
}

export async function settledRfq(id: string, hash: string): Promise<void> {
  await post(`/api/rfq/${id}/settled`, { hash });
}

export type RfqPhase = 'idle' | 'requesting' | 'open' | 'closed' | 'accepting' | 'done' | 'error';

/** Live quotes a taker can still act on. */
export function acceptableQuotes(r: RfqRequest | null, now = Date.now()): RfqQuote[] {
  if (!r) return [];
  return r.quotes
    .filter((q) => q.status === 'live' && q.expiresAt > now + 3_000)
    .sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : BigInt(b.amountOut) < BigInt(a.amountOut) ? -1 : 0));
}

export function useRfq() {
  const [request, setRequest] = useState<RfqRequest | null>(null);
  const [phase, setPhase] = useState<RfqPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeId = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  // 1s clock for countdowns while anything is on screen
  useEffect(() => {
    if (phase === 'idle' || phase === 'done') return;
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [phase]);

  const reset = useCallback(() => {
    stopPolling();
    activeId.current = null;
    setRequest(null);
    setPhase('idle');
    setError(null);
  }, [stopPolling]);

  const start = useCallback(
    async (params: { taker: string; tokenIn: string; tokenOut: string; amountIn: string; ttlSec?: number }) => {
      stopPolling();
      setError(null);
      setPhase('requesting');
      try {
        const r = await createRfq(params);
        activeId.current = r.id;
        setRequest(r);
        setPhase('open');
        pollRef.current = setInterval(async () => {
          if (activeId.current !== r.id) return;
          try {
            const next = await getRfq(r.id);
            if (activeId.current !== r.id) return;
            setRequest(next);
            // Keep polling a little past the deadline: late quotes land
            // and live ones expire on their own clock.
            if (Date.now() > next.expiresAt + 60_000 || next.status === 'accepted' || next.status === 'settled') {
              stopPolling();
            }
            if (next.status !== 'open') setPhase((p) => (p === 'open' ? 'closed' : p));
          } catch {
            /* transient — keep polling */
          }
        }, 1500);
        return r;
      } catch (err: any) {
        setError(err?.message || 'Could not open the request');
        setPhase('error');
        throw err;
      }
    },
    [stopPolling]
  );

  const cancel = useCallback(async () => {
    const id = activeId.current;
    stopPolling();
    if (id) cancelRfq(id).catch(() => {});
    reset();
  }, [reset, stopPolling]);

  /**
   * Accept a quote: the backend returns the settlement tx, the wallet
   * signs it, and the backend relays it. Resolves with the tx hash.
   */
  const accept = useCallback(
    async (quoteId: string, signTransaction: (xdr: string) => Promise<string>): Promise<{ hash: string; quote: RfqQuote }> => {
      const r = request;
      if (!r) throw new Error('No open request');
      stopPolling();
      setPhase('accepting');
      setError(null);
      try {
        const { xdr, quote } = await acceptRfq(r.id, quoteId);
        const signed = await signTransaction(xdr);
        const { hash } = await submitTransaction(signed);
        if (hash) settledRfq(r.id, hash).catch(() => {});
        setRequest((prev) => (prev ? { ...prev, status: 'settled', settledHash: hash ?? null, acceptedQuoteId: quoteId } : prev));
        setPhase('done');
        return { hash: hash ?? '', quote };
      } catch (err: any) {
        setError(err?.message || 'Settlement failed');
        setPhase('error');
        throw err;
      }
    },
    [request, stopPolling]
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const secondsLeft = request ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000)) : 0;
  const quotes = acceptableQuotes(request, now);

  return { request, phase, error, secondsLeft, quotes, now, start, cancel, accept, reset };
}

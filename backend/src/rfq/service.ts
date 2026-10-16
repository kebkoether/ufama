/**
 * RFQ orchestration: taker requests → maker firm quotes (pre-signed
 * Soroban auth entries) → taker accepts → one atomic settle_quote tx.
 *
 * Trust model: makers are registered (API key → label) but the backend
 * never holds maker keys. Every submitted quote is verified by an
 * ENFORCE-mode simulation against the live host before it is shown to
 * the taker: bad signature, wrong nonce, insufficient maker balance or a
 * quote outside its own NAV band all fail there, not at accept time.
 *
 * Reference pricing (NAV from RedStone/Reflector, the AMM route, and
 * standing SwapBook orders) is computed once per request so every quote
 * card can be labelled "NAV ± N bps" against the same anchor.
 */

import { xdr } from '@stellar/stellar-sdk';
import { StellarClient, isTransportError } from '../stellar/client.js';
import { FairValueService } from '../services/fair-value.js';
import {
  RfqStore,
  RfqRequest,
  RfqQuote,
  RfqReference,
  PublicRequest,
  RfqEvent,
  toPublic,
  newId,
} from './store.js';
import {
  QuoteFields,
  quoteToScVal,
  decodeQuoteEntry,
  isSourceAccountEntry,
  entryAddress,
  randomNonce,
  vsFairBps,
} from './quote-xdr.js';

export class RfqError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface RfqServiceDeps {
  stellar: StellarClient;
  rfqContractId: string;
  store: RfqStore;
  fairValue: FairValueService;
  tokenMeta: (sac: string) => { symbol: string; decimals: number };
  /** Does the SwapBook hold an on-chain feed for this pair? */
  oracleOnChain: (tokenIn: string, tokenOut: string) => Promise<boolean>;
  /** Best DEX/AMM route net output for comparison, or null. */
  ammQuote: (
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ) => Promise<{ amountOut: bigint; venues: string[] } | null>;
  /** Standing-order fills available right now for this taker. */
  bookPlan: (
    taker: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ) => Promise<{ fills: number; amountOut: bigint; amountInUsed: bigint }>;
  /** Ledger close time estimate (seconds). */
  ledgerSeconds?: number;
}

const DEFAULT_REQUEST_TTL_SEC = 20;
const MAX_REQUEST_TTL_SEC = 120;
/** Extra validity past the request deadline so a taker can accept after
 *  the countdown ends (ledgers). */
const QUOTE_ACCEPT_GRACE_LEDGERS = 12;
const MIN_QUOTE_TTL_LEDGERS = 6;
const MAX_QUOTE_TTL_LEDGERS = 720; // ~1h
/** Default on-chain NAV band for quotes on pairs with a feed (bps). */
const DEFAULT_NAV_BAND_BPS = 50;
const MAX_NAV_BAND_BPS = 1_000;

export class RfqService {
  private ledgerSeconds: number;

  constructor(private deps: RfqServiceDeps) {
    this.ledgerSeconds = deps.ledgerSeconds ?? 5;
  }

  get enabled(): boolean {
    return Boolean(this.deps.rfqContractId);
  }

  get contractId(): string {
    return this.deps.rfqContractId;
  }

  subscribe(fn: (ev: RfqEvent) => void): () => void {
    return this.deps.store.subscribe(fn);
  }

  listenerCount(): number {
    return this.deps.store.listenerCount();
  }

  openCount(): number {
    return this.deps.store.openCount();
  }

  // ─── Taker side ─────────────────────────────────────

  async createRequest(input: {
    taker: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    ttlSec?: number;
  }): Promise<PublicRequest> {
    this.assertEnabled();
    if (input.tokenIn === input.tokenOut) throw new RfqError('tokenIn and tokenOut must differ');
    if (input.amountIn <= 0n) throw new RfqError('amountIn must be positive');
    const ttlSec = Math.min(
      MAX_REQUEST_TTL_SEC,
      Math.max(5, Math.floor(input.ttlSec ?? DEFAULT_REQUEST_TTL_SEC))
    );
    const metaIn = this.deps.tokenMeta(input.tokenIn);
    const metaOut = this.deps.tokenMeta(input.tokenOut);

    const [ledger, reference] = await Promise.all([
      this.deps.stellar.getLatestLedger(),
      this.buildReference(input.taker, input.tokenIn, input.tokenOut, input.amountIn, metaIn, metaOut),
    ]);

    const now = Date.now();
    const req: RfqRequest = {
      id: newId('rfq'),
      taker: input.taker,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      symbolIn: metaIn.symbol,
      symbolOut: metaOut.symbol,
      decimalsIn: metaIn.decimals,
      decimalsOut: metaOut.decimals,
      amountIn: input.amountIn.toString(),
      createdAt: now,
      expiresAt: now + ttlSec * 1000,
      ledgerAtCreate: ledger,
      status: 'open',
      reference,
      quotes: [],
      acceptedQuoteId: null,
      settledHash: null,
    };
    this.deps.store.insert(req);
    return toPublic(req);
  }

  get(id: string): PublicRequest {
    const r = this.require(id);
    this.expireQuotes(r, Date.now());
    return toPublic(r);
  }

  listOpen(): PublicRequest[] {
    return this.deps.store.open().map(toPublic);
  }

  cancel(id: string): PublicRequest {
    const r = this.require(id);
    this.deps.store.close(id, 'cancelled');
    return toPublic(r);
  }

  /** Taker reports the settlement hash so the request reads as settled. */
  markSettled(id: string, hash: string): PublicRequest {
    const r = this.require(id);
    if (r.status === 'accepted' || r.status === 'open') {
      if (r.status === 'open') this.deps.store.close(id, 'settled');
      else r.status = 'settled';
    }
    r.settledHash = hash;
    return toPublic(r);
  }

  /**
   * Build the taker's settlement transaction for an accepted quote.
   * Recording-mode simulation supplies the taker's own (source-account)
   * entry; the maker's SIGNED entry replaces the recorded one; the
   * enforce-mode build verifies the pair and sizes the footprint.
   */
  async accept(id: string, quoteId: string): Promise<{ xdr: string; quote: Omit<RfqQuote, 'signedAuthXdr'>; request: PublicRequest }> {
    const r = this.require(id);
    if (r.status !== 'open' && r.status !== 'expired') throw new RfqError(`request is ${r.status}`, 409);
    const q = r.quotes.find((x) => x.id === quoteId);
    if (!q) throw new RfqError('quote not found', 404);
    const ledger = await this.deps.stellar.getLatestLedger();
    this.expireQuotes(r, Date.now(), ledger);
    if (q.status !== 'live') throw new RfqError(`quote is ${q.status}`, 409);

    const fields = this.fieldsFor(r, q);
    const xdrOut = await this.buildWithMakerEntry(fields, q.signedAuthXdr, 'accept');

    q.status = 'accepted';
    for (const other of r.quotes) if (other.id !== q.id && other.status === 'live') other.status = 'superseded';
    r.acceptedQuoteId = q.id;
    if (r.status === 'open') this.deps.store.close(id, 'accepted');
    else r.status = 'accepted';
    const { signedAuthXdr: _s, ...pub } = q;
    return { xdr: xdrOut, quote: pub, request: toPublic(r) };
  }

  // ─── Maker side ─────────────────────────────────────

  /**
   * Build the exact authorization entry a maker must sign for a quote.
   * Also returns the on-chain check (fee, NAV deviation) so the maker
   * sees what the contract will enforce before signing.
   */
  async prepareQuote(
    id: string,
    input: { maker: string; amountOut: bigint; ttlLedgers?: number; maxNavDevBps?: number }
  ): Promise<{
    quote: Record<string, string | number>;
    authEntryXdr: string;
    check: { fee: string; makerReceives: string; fairOut: string | null; vsNavBps: number | null };
  }> {
    const r = this.require(id);
    if (r.status !== 'open') throw new RfqError(`request is ${r.status}`, 409);
    if (Date.now() >= r.expiresAt) throw new RfqError('request has expired', 409);
    if (input.maker === r.taker) throw new RfqError('maker cannot quote their own request');
    if (input.amountOut <= 0n) throw new RfqError('amountOut must be positive');

    const ledger = await this.deps.stellar.getLatestLedger();
    const remainingLedgers = Math.ceil((r.expiresAt - Date.now()) / 1000 / this.ledgerSeconds);
    const ttl = Math.min(
      MAX_QUOTE_TTL_LEDGERS,
      Math.max(MIN_QUOTE_TTL_LEDGERS, Math.floor(input.ttlLedgers ?? remainingLedgers + QUOTE_ACCEPT_GRACE_LEDGERS))
    );
    let band = input.maxNavDevBps ?? (r.reference.oracleOnChain ? DEFAULT_NAV_BAND_BPS : 0);
    if (!Number.isInteger(band) || band < 0 || band > MAX_NAV_BAND_BPS) {
      throw new RfqError(`maxNavDevBps must be an integer 0..${MAX_NAV_BAND_BPS}`);
    }
    if (band > 0 && !r.reference.oracleOnChain) {
      throw new RfqError('this pair has no on-chain NAV feed — quote with maxNavDevBps 0');
    }

    const fields: QuoteFields = {
      maker: input.maker,
      taker: r.taker,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: BigInt(r.amountIn),
      amountOut: input.amountOut,
      expiryLedger: ledger + ttl,
      nonce: randomNonce(),
      maxNavDevBps: band,
    };

    // On-chain view of the quote (fee, deviation, band) — fails with the
    // contract's own error when the quote would not settle.
    const check = await this.checkOnChain(fields);

    let entries: xdr.SorobanAuthorizationEntry[];
    try {
      entries = await this.deps.stellar.simulateAuthEntries(
        r.taker,
        this.deps.rfqContractId,
        'settle_quote',
        [quoteToScVal(fields)]
      );
    } catch (err) {
      throw new RfqError(`quote would not settle: ${explain(err)}`, 422);
    }
    const makerEntry = entries.find((e) => entryAddress(e) === input.maker);
    if (!makerEntry) {
      throw new RfqError('simulation produced no authorization entry for the maker', 422);
    }

    return {
      quote: {
        maker: fields.maker,
        taker: fields.taker,
        tokenIn: fields.tokenIn,
        tokenOut: fields.tokenOut,
        amountIn: fields.amountIn.toString(),
        amountOut: fields.amountOut.toString(),
        expiryLedger: fields.expiryLedger,
        nonce: fields.nonce.toString(),
        maxNavDevBps: fields.maxNavDevBps,
      },
      authEntryXdr: makerEntry.toXDR('base64'),
      check,
    };
  }

  /**
   * Accept a maker's SIGNED entry as a live quote. Shape-checked
   * offline, then verified by an enforce-mode simulation.
   */
  async submitQuote(
    id: string,
    input: { signedAuthXdr: string; makerLabel: string }
  ): Promise<Omit<RfqQuote, 'signedAuthXdr'>> {
    const r = this.require(id);
    if (r.status !== 'open') throw new RfqError(`request is ${r.status}`, 409);
    const now = Date.now();
    if (now >= r.expiresAt) throw new RfqError('request has expired', 409);

    let decoded;
    try {
      decoded = decodeQuoteEntry(input.signedAuthXdr, this.deps.rfqContractId);
    } catch (err) {
      throw new RfqError(explain(err));
    }
    const f = decoded.quote;
    if (!decoded.signed) throw new RfqError('auth entry is not signed');
    if (f.taker !== r.taker) throw new RfqError('quote.taker does not match the request');
    if (f.tokenIn !== r.tokenIn || f.tokenOut !== r.tokenOut) {
      throw new RfqError('quote tokens do not match the request');
    }
    if (f.amountIn !== BigInt(r.amountIn)) throw new RfqError('quote.amount_in does not match the request');
    if (f.amountOut <= 0n) throw new RfqError('quote.amount_out must be positive');
    if (f.maker === r.taker) throw new RfqError('maker cannot quote their own request');
    if (decoded.signatureExpirationLedger < f.expiryLedger) {
      throw new RfqError('signature expires before the quote does — sign with validUntil >= expiry_ledger');
    }
    const ledger = await this.deps.stellar.getLatestLedger();
    if (f.expiryLedger <= ledger + MIN_QUOTE_TTL_LEDGERS - 1) {
      throw new RfqError('quote expires too soon to be accepted');
    }
    if (f.expiryLedger > ledger + MAX_QUOTE_TTL_LEDGERS) {
      throw new RfqError(`quote expiry too far (max ${MAX_QUOTE_TTL_LEDGERS} ledgers)`);
    }

    // The host is the judge: signature, nonce, balances, NAV band.
    await this.buildWithMakerEntry(f, input.signedAuthXdr, 'verify');

    const nav = r.reference.navAmountOut ? BigInt(r.reference.navAmountOut) : null;
    const quote: RfqQuote = {
      id: newId('q'),
      requestId: r.id,
      maker: f.maker,
      makerLabel: input.makerLabel,
      amountOut: f.amountOut.toString(),
      expiryLedger: f.expiryLedger,
      expiresAt: now + (f.expiryLedger - ledger) * this.ledgerSeconds * 1000,
      nonce: f.nonce.toString(),
      maxNavDevBps: f.maxNavDevBps,
      vsNavBps: nav ? vsFairBps(nav, f.amountOut) : null,
      signedAuthXdr: input.signedAuthXdr,
      status: 'live',
      receivedAt: now,
    };
    // One live quote per maker per request — a re-quote supersedes.
    for (const q of r.quotes) if (q.maker === f.maker && q.status === 'live') q.status = 'superseded';
    r.quotes.push(quote);
    const { signedAuthXdr: _s, ...pub } = quote;
    return pub;
  }

  // ─── Internals ──────────────────────────────────────

  private assertEnabled(): void {
    if (!this.enabled) throw new RfqError('RFQ is not enabled on this server', 503);
  }

  private require(id: string): RfqRequest {
    this.assertEnabled();
    const r = this.deps.store.get(id);
    if (!r) throw new RfqError('request not found', 404);
    return r;
  }

  private fieldsFor(r: RfqRequest, q: RfqQuote): QuoteFields {
    return {
      maker: q.maker,
      taker: r.taker,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: BigInt(r.amountIn),
      amountOut: BigInt(q.amountOut),
      expiryLedger: q.expiryLedger,
      nonce: BigInt(q.nonce),
      maxNavDevBps: q.maxNavDevBps,
    };
  }

  private expireQuotes(r: RfqRequest, now: number, ledger?: number): void {
    for (const q of r.quotes) {
      if (q.status !== 'live') continue;
      if ((ledger !== undefined && ledger >= q.expiryLedger) || now >= q.expiresAt) q.status = 'expired';
    }
  }

  /**
   * Recording sim for the taker's own entry + the maker's signed entry
   * → enforce-mode build. Returns the assembled unsigned XDR.
   */
  private async buildWithMakerEntry(
    fields: QuoteFields,
    signedAuthXdr: string,
    phase: 'verify' | 'accept'
  ): Promise<string> {
    const arg = quoteToScVal(fields);
    let recorded: xdr.SorobanAuthorizationEntry[];
    try {
      recorded = await this.deps.stellar.simulateAuthEntries(
        fields.taker,
        this.deps.rfqContractId,
        'settle_quote',
        [arg]
      );
    } catch (err) {
      throw new RfqError(`quote would not settle: ${explain(err)}`, 422);
    }
    const takerEntries = recorded.filter(
      (e) => isSourceAccountEntry(e) || entryAddress(e) === fields.taker
    );
    const makerEntry = xdr.SorobanAuthorizationEntry.fromXDR(signedAuthXdr, 'base64');
    // Public RPCs answer the odd enforce-mode simulation with a 5xx; a
    // single retry separates that from a genuine host rejection (which
    // is deterministic and repeats).
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.stellar.buildTransaction(
          fields.taker,
          this.deps.rfqContractId,
          'settle_quote',
          [arg],
          { auth: [...takerEntries, makerEntry] }
        );
      } catch (err) {
        if (attempt === 0 && isTransportError(err)) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const reason = explain(err);
        throw new RfqError(
          phase === 'verify'
            ? `signed quote rejected by the host: ${reason}`
            : `quote can no longer settle: ${reason}`,
          isTransportError(err) ? 503 : 422
        );
      }
    }
  }

  private async checkOnChain(fields: QuoteFields): Promise<{
    fee: string;
    makerReceives: string;
    fairOut: string | null;
    vsNavBps: number | null;
  }> {
    const res = await this.deps.stellar.simulateAndParse<{
      fair_out: bigint;
      deviation_bps: bigint;
      fee: bigint;
      maker_receives: bigint;
    }>(this.deps.rfqContractId, 'check_quote', [quoteToScVal(fields)]);
    if (!res) {
      throw new RfqError(
        fields.maxNavDevBps > 0
          ? 'contract refused the quote (outside the NAV band, or the NAV feed is stale)'
          : 'contract refused the quote',
        422
      );
    }
    const fair = BigInt(res.fair_out);
    return {
      fee: BigInt(res.fee).toString(),
      makerReceives: BigInt(res.maker_receives).toString(),
      fairOut: fair > 0n ? fair.toString() : null,
      vsNavBps: fair > 0n ? Number(res.deviation_bps) : null,
    };
  }

  private async buildReference(
    taker: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    metaIn: { symbol: string; decimals: number },
    metaOut: { symbol: string; decimals: number }
  ): Promise<RfqReference> {
    const [usdIn, usdOut, oracleOnChain, amm, book] = await Promise.all([
      this.deps.fairValue.quoteUsd(tokenIn, metaIn.symbol),
      this.deps.fairValue.quoteUsd(tokenOut, metaOut.symbol),
      this.deps.oracleOnChain(tokenIn, tokenOut).catch(() => false),
      this.deps.ammQuote(tokenIn, tokenOut, amountIn).catch(() => null),
      this.deps
        .bookPlan(taker, tokenIn, tokenOut, amountIn)
        .catch(() => ({ fills: 0, amountOut: 0n, amountInUsed: 0n })),
    ]);

    let navAmountOut: bigint | null = null;
    let navPrice: number | null = null;
    let navSource: string | null = null;
    let navAgeSec: number | null = null;
    if (usdIn && usdOut) {
      // amountIn / 10^decIn * pIn / pOut * 10^decOut, in bigint with
      // 12-digit price scaling so 18-decimal tokens stay exact.
      const pIn = BigInt(Math.round(usdIn.price * 1e12));
      const pOut = BigInt(Math.round(usdOut.price * 1e12));
      if (pIn > 0n && pOut > 0n) {
        navAmountOut =
          (amountIn * pIn * 10n ** BigInt(metaOut.decimals)) /
          (pOut * 10n ** BigInt(metaIn.decimals));
        navPrice = usdIn.price / usdOut.price;
        navSource = usdIn.source === usdOut.source ? usdIn.source : `${usdIn.source}+${usdOut.source}`;
        const nowSec = Math.floor(Date.now() / 1000);
        const ages = [usdIn, usdOut].filter((u) => u.timestamp > 0).map((u) => nowSec - u.timestamp);
        navAgeSec = ages.length ? Math.max(...ages) : null;
      }
    }
    // No off-chain reading but the SwapBook prices the pair: use the
    // contract's own fair value — the number the NAV band will enforce.
    if (navAmountOut === null && oracleOnChain) {
      const fair = await this.deps.stellar.simulateAndParse<bigint>(
        this.deps.rfqContractId,
        'fair_value',
        [StellarClient.toAddress(tokenIn), StellarClient.toAddress(tokenOut), StellarClient.toI128(amountIn)]
      );
      if (fair && BigInt(fair) > 0n) {
        navAmountOut = BigInt(fair);
        navPrice =
          Number(navAmountOut) / 10 ** metaOut.decimals / (Number(amountIn) / 10 ** metaIn.decimals);
        navSource = 'swapbook';
      }
    }

    // A fill that uses only part of the budget is compared pro-rata.
    let bookVsNavBps: number | null = null;
    if (navAmountOut && book.amountInUsed > 0n && book.amountOut > 0n) {
      const navForUsed = (navAmountOut * book.amountInUsed) / amountIn;
      bookVsNavBps = vsFairBps(navForUsed, book.amountOut);
    }

    return {
      navAmountOut: navAmountOut?.toString() ?? null,
      navPrice,
      navSource,
      navAgeSec,
      oracleOnChain,
      ammAmountOut: amm?.amountOut ? amm.amountOut.toString() : null,
      ammVsNavBps: navAmountOut && amm?.amountOut ? vsFairBps(navAmountOut, amm.amountOut) : null,
      ammVenues: amm?.venues ?? [],
      bookAmountOut: book.amountOut > 0n ? book.amountOut.toString() : null,
      bookAmountInUsed: book.amountInUsed > 0n ? book.amountInUsed.toString() : null,
      bookVsNavBps,
      bookFills: book.fills,
    };
  }
}

function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Host/token-level failures first: a Stellar Asset Contract reports
  // its own error codes, which collide with ours (#10 is both the SAC's
  // balance error and our NavBandExceeded).
  if (/resulting balance is not within the allowed range|balance|underflow|insufficient/i.test(msg)) {
    return 'insufficient balance (maker or taker)';
  }
  if (/trustline|not authorized|TrustLine/i.test(msg)) return 'missing trustline or unauthorized recipient';
  if (/status code 5\d\d|ECONNRESET|ETIMEDOUT|timed out/i.test(msg)) {
    return 'RPC unavailable — retry in a moment';
  }
  // Our contract's code, only when the failing frame is ours
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    const names: Record<string, string> = {
      '3': 'InvalidAmount',
      '4': 'SameToken',
      '5': 'SameParty',
      '6': 'Expired',
      '7': 'ExpiryTooFar',
      '8': 'AlreadyUsed (nonce already settled)',
      '9': 'NavBandTooWide',
      '10': 'NavBandExceeded (quote is outside its NAV band)',
      '11': 'OracleUnavailable (no fresh NAV feed for this pair)',
    };
    return names[m[1]] ? `${names[m[1]]}` : `contract error #${m[1]}`;
  }
  if (/auth|signature|nonce|InvalidAction|recording|enforc/i.test(msg)) {
    return 'authorization failed (signature, nonce or expiry)';
  }
  return msg.slice(0, 300);
}

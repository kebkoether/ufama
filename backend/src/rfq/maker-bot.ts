/**
 * Reference RFQ maker bot.
 *
 * Listens to the ufama RFQ stream, prices every request at NAV ± a
 * configured spread, asks the API to build the exact Soroban
 * authorization entry, signs it LOCALLY with the maker key, and posts
 * the signed entry back as a firm quote. The API never sees the key.
 *
 * Inventory is implicit: the API's prepare step simulates the full
 * settlement with this maker's balances, so a request this wallet
 * cannot fill is rejected there and simply skipped.
 *
 *   UFAMA_API_URL=https://…railway.app \
 *   RFQ_MAKER_KEY=rk_live_…           (registered in RFQ_MAKER_KEYS on the server) \
 *   RFQ_MAKER_SECRET=S…                (this wallet signs quotes) \
 *   NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" \
 *   RFQ_SPREAD_BPS=5                   (taker receives NAV minus this) \
 *   RFQ_MAX_NOTIONAL=50000             (display units of tokenIn, per request) \
 *   RFQ_PAIRS=USDC>USTRY,USDC>deJTRSY  (optional allowlist of symbolIn>symbolOut) \
 *   npm run maker
 *
 * Pairs without a NAV reference are skipped unless RFQ_FALLBACK_1TO1=1
 * (stablecoin-to-stablecoin corridors quote 1:1 minus spread).
 */

import 'dotenv/config';
import { Keypair, authorizeEntry, xdr, Horizon, TransactionBuilder } from '@stellar/stellar-sdk';
import { EtherfuseClient, EtherfuseEnv } from '../services/etherfuse-client.js';
import { Restocker, RestockTarget } from './restock.js';

const API = (process.env.UFAMA_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const KEY = process.env.RFQ_MAKER_KEY ?? '';
const SECRET = process.env.RFQ_MAKER_SECRET ?? '';
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
const SPREAD_BPS = Number(process.env.RFQ_SPREAD_BPS ?? '5');
const MAX_NOTIONAL = Number(process.env.RFQ_MAX_NOTIONAL ?? '50000');
const PAIRS = (process.env.RFQ_PAIRS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const FALLBACK_1TO1 = ['1', 'true'].includes((process.env.RFQ_FALLBACK_1TO1 ?? '').toLowerCase());
/** Band the quote asks the contract to enforce on pairs with a feed. */
const NAV_BAND_BPS = Number(process.env.RFQ_NAV_BAND_BPS ?? '50');

if (!KEY || !SECRET) {
  console.error('RFQ_MAKER_KEY and RFQ_MAKER_SECRET are required');
  process.exit(1);
}
const signer = Keypair.fromSecret(SECRET);
const headers = { 'x-api-key': KEY, 'Content-Type': 'application/json' };
console.log(`[maker] ${signer.publicKey()} quoting NAV−${SPREAD_BPS} bps via ${API}`);

interface PublicRequest {
  id: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
  amountIn: string;
  expiresAt: number;
  status: string;
  reference: {
    navAmountOut: string | null;
    oracleOnChain: boolean;
  };
}

const quoted = new Set<string>();

/** POST with one retry on 5xx — the public RPC behind the API hiccups. */
async function postWithRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status >= 500) {
    await new Promise((r) => setTimeout(r, 600));
    return fetch(url, init);
  }
  return res;
}

async function quote(req: PublicRequest): Promise<void> {
  if (quoted.has(req.id)) return;
  quoted.add(req.id);
  const pair = `${req.symbolIn}>${req.symbolOut}`.toUpperCase();
  if (PAIRS.length && !PAIRS.includes(pair)) return;
  if (req.taker === signer.publicKey()) return;

  const amountIn = BigInt(req.amountIn);
  const notional = Number(amountIn) / 10 ** req.decimalsIn;
  if (notional > MAX_NOTIONAL) {
    console.log(`[maker] skip ${req.id} ${pair}: ${notional} exceeds RFQ_MAX_NOTIONAL`);
    return;
  }

  let fair: bigint | null = req.reference.navAmountOut ? BigInt(req.reference.navAmountOut) : null;
  // Reference pricing is the API's; a maker with its own NAV source
  // (an issuer's primary-market feed, say) replaces this line.
  if (fair === null && FALLBACK_1TO1) {
    fair = (amountIn * 10n ** BigInt(req.decimalsOut)) / 10n ** BigInt(req.decimalsIn);
  }
  if (fair === null || fair <= 0n) {
    console.log(`[maker] skip ${req.id} ${pair}: no NAV reference`);
    return;
  }
  const amountOut = (fair * BigInt(10_000 - SPREAD_BPS)) / 10_000n;
  const maxNavDevBps = req.reference.oracleOnChain ? Math.max(NAV_BAND_BPS, SPREAD_BPS + 5) : 0;

  const prep = await postWithRetry(`${API}/api/rfq/${req.id}/prepare`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ maker: signer.publicKey(), amountOut: amountOut.toString(), maxNavDevBps }),
  });
  if (!prep.ok) {
    console.log(`[maker] skip ${req.id} ${pair}: prepare ${prep.status} ${(await prep.json().catch(() => ({}))).error ?? ''}`);
    return;
  }
  const { authEntryXdr, quote: q, check } = (await prep.json()) as {
    authEntryXdr: string;
    quote: { expiryLedger: number; nonce: string };
    check: { vsNavBps: number | null; fee: string };
  };

  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
  const signed = await authorizeEntry(entry, signer, q.expiryLedger, PASSPHRASE);

  const post = await postWithRetry(`${API}/api/rfq/${req.id}/quote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ signedAuthXdr: signed.toXDR('base64') }),
  });
  const body = (await post.json().catch(() => ({}))) as any;
  if (!post.ok) {
    console.log(`[maker] rejected ${req.id} ${pair}: ${body.error ?? post.status}`);
    return;
  }
  console.log(
    `[maker] quoted ${req.id} ${pair}: ${amountOut} out for ${amountIn} in ` +
      `(NAV ${check.vsNavBps ?? '?'} bps, expires L${q.expiryLedger}, quote ${body.quote?.id})`
  );
}

/** Minimal SSE client over fetch (Node 22+). Reconnects with backoff. */
async function stream(): Promise<void> {
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(`${API}/api/rfq/stream`, { headers: { 'x-api-key': KEY } });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      backoff = 1000;
      console.log('[maker] connected');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(frame);
        }
      }
      throw new Error('stream ended');
    } catch (err) {
      console.log(`[maker] disconnected (${(err as Error).message}); retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

function handleFrame(frame: string): void {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (!data.length) return;
  let payload: any;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    return;
  }
  if (event === 'hello') {
    for (const r of payload.open ?? []) void quote(r).catch(logErr);
  } else if (event === 'request.created') {
    void quote(payload.request).catch(logErr);
  }
}

function logErr(err: unknown): void {
  console.error('[maker] error:', err instanceof Error ? err.message : err);
}

/**
 * Optional: keep bond inventory topped up from the issuer's primary
 * market (Etherfuse v2). Enabled when ETHERFUSE_API_KEY is set.
 *
 *   ETHERFUSE_API_KEY=api_prod:…      (or api_sand:… with ETHERFUSE_ENV=sand)
 *   ETHERFUSE_ENV=prod|sand
 *   ETHERFUSE_ORG_ID=<uuid>
 *   ETHERFUSE_PAYMENT_ACCOUNT_ID=<uuid of this wallet on Etherfuse; omitted = register it>
 *   RESTOCK_SOURCE_ASSET=USDC:GA5ZSEJ…   (what we spend)
 *   RESTOCK_TARGETS='[{"symbol":"USTRY","asset":"USTRY:GCRYUGD5…","minBalance":50,"spend":"100"}]'
 *   RESTOCK_INTERVAL_SEC=60
 */
async function startRestock(): Promise<void> {
  const key = process.env.ETHERFUSE_API_KEY ?? '';
  if (!key) return;
  const env = (process.env.ETHERFUSE_ENV ?? 'prod') as EtherfuseEnv;
  const org = process.env.ETHERFUSE_ORG_ID ?? '';
  const sourceAsset = process.env.RESTOCK_SOURCE_ASSET ?? '';
  let targets: RestockTarget[] = [];
  try {
    targets = JSON.parse(process.env.RESTOCK_TARGETS ?? '[]');
  } catch {
    console.error('[restock] RESTOCK_TARGETS is not valid JSON');
    return;
  }
  if (!org || !sourceAsset || targets.length === 0) {
    console.error('[restock] ETHERFUSE_ORG_ID, RESTOCK_SOURCE_ASSET and RESTOCK_TARGETS are required');
    return;
  }
  const ef = new EtherfuseClient({ apiKey: key, env, organizationId: org });
  const me = await ef.me().catch((e) => {
    console.error('[restock] Etherfuse key check failed:', e instanceof Error ? e.message : e);
    return null;
  });
  if (!me) return;
  let paymentAccountId = process.env.ETHERFUSE_PAYMENT_ACCOUNT_ID ?? '';
  if (!paymentAccountId) {
    const pa = await ef.registerStellarWallet(signer.publicKey(), 'ufama maker');
    paymentAccountId = pa.id;
    console.log(`[restock] registered maker wallet on Etherfuse as payment account ${pa.id} (${pa.status})`);
  }
  const horizonUrl = PASSPHRASE.startsWith('Public') ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
  const horizon = new Horizon.Server(horizonUrl);
  const restocker = new Restocker({
    etherfuse: ef,
    paymentAccountId,
    sourceAsset,
    targets,
    balances: async () => {
      const acct = await horizon.loadAccount(signer.publicKey());
      const out: Record<string, number> = {};
      for (const b of acct.balances as any[]) {
        const sym = b.asset_type === 'native' ? 'XLM' : String(b.asset_code ?? '');
        if (sym) out[sym] = (out[sym] ?? 0) + Number(b.balance);
      }
      return out;
    },
    signAndSubmit: async (unsignedXdr) => {
      const tx = TransactionBuilder.fromXdr(unsignedXdr, PASSPHRASE);
      tx.sign(signer);
      const res = await horizon.submitTransaction(tx);
      return res.hash;
    },
    log: (m) => console.log(m),
  });
  const interval = Number(process.env.RESTOCK_INTERVAL_SEC ?? '60') * 1000;
  console.log(`[restock] on (${env}, every ${interval / 1000}s): ${targets.map((t) => `${t.symbol}<${t.minBalance}`).join(', ')}`);
  const run = () => restocker.tick().catch((e) => console.error('[restock] tick failed:', e instanceof Error ? e.message : e));
  void run();
  setInterval(run, interval);
}

stream();
void startRestock();

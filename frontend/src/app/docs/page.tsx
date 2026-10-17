const API_BASE = 'https://atomicswap-aggregator-production.up.railway.app';

const section: React.CSSProperties = {
  background: '#131722',
  border: '1px solid #252a3a',
  borderRadius: '14px',
  padding: '22px',
  marginBottom: '16px',
};
const h2: React.CSSProperties = { fontSize: '17px', fontWeight: 700, color: '#e1e4ea', marginBottom: '10px' };
const p: React.CSSProperties = { fontSize: '14px', color: '#8a8f9c', lineHeight: 1.65, marginBottom: '10px' };
const code: React.CSSProperties = {
  display: 'block',
  background: '#0d1117',
  border: '1px solid #1a1f2e',
  borderRadius: '8px',
  padding: '12px 14px',
  fontSize: '12.5px',
  color: '#c4cad6',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'pre',
  overflowX: 'auto',
  marginBottom: '10px',
};

export const metadata = { title: 'Ufama — API Docs' };

export default function DocsPage() {
  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '32px 24px 64px' }}>
      <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#e1e4ea', marginBottom: '6px' }}>
        Integrator API
      </h1>
      <p style={{ ...p, marginBottom: '24px' }}>
        REST API for wallets and payment apps that want swaps on Stellar without running their
        own routing. Flow: <b style={{ color: '#e1e4ea' }}>quote → build → your user signs → send</b>.
        Ufama never sees keys — every transaction is signed client-side by your user&apos;s wallet.
      </p>

      <div style={section}>
        <div style={h2}>Base URL &amp; auth</div>
        <span style={code}>{API_BASE}</span>
        <p style={p}>
          Every <b>/v1</b> request needs an API key, sent as <b>x-api-key</b> or{' '}
          <b>Authorization: Bearer</b>. Keys are issued manually — email{' '}
          <a href="mailto:hello@ufama.trade" style={{ color: '#6366f1' }}>hello@ufama.trade</a>.
          Rate limit: 120 requests/min per key.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /v1/quote</div>
        <span style={code}>{`{
  "assetIn":  "XLM",            // symbol or SAC contract address
  "assetOut": "USDC",
  "amount":   "1000000000",     // base units (7 decimals), EXACT_IN
  "slippageBps": 50,            // optional, default 50
  "feeBps": 25,                 // optional partner fee, max 100 (1%)
  "referralAddress": "G..."     // required when feeBps > 0
}`}</span>
        <p style={p}>
          Returns <b>amountOut</b> (net of protocol fee and your partner fee),{' '}
          <b>minAmountOut</b>, <b>kind</b> (&quot;classic&quot; or &quot;soroban&quot;),{' '}
          <b>partnerFee</b>, <b>partnerFeeCollected</b>, and the venue{' '}
          <b>segments</b>. Quotes are indicative; build re-prices.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /v1/quote/build</div>
        <p style={p}>
          Same body plus <b>from</b> (the user address that will sign). Returns an unsigned{' '}
          <b>xdr</b>. Hand it to the user&apos;s wallet (Freighter, xBull, LOBSTR — any SEP-43
          signer) and have them sign against{' '}
          <b>Public Global Stellar Network ; September 2015</b>.
        </p>
        <p style={p}>
          <b>Partner economics:</b> on classic (SDEX) routes your <b>feeBps</b> is a second
          payment op inside the same transaction — atomic with the swap, paid in the output
          asset. Your <b>referralAddress</b> must hold a trustline for every output asset you
          enable. Soroban routes report <b>partnerFeeCollected: false</b> for now.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /v1/send</div>
        <span style={code}>{`{ "xdr": "<signed transaction XDR>" }`}</span>
        <p style={p}>
          Submits and returns the result. You can also submit yourself via Horizon (classic) or
          Soroban RPC (soroban) if you prefer.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>GET /v1/tokens · GET /v1/health</div>
        <p style={p}>
          <b>/v1/tokens</b>: the tradeable universe with contract addresses and venue-volume
          ranking (sort by <b>venueVolume</b> for a &quot;top tokens&quot; list).{' '}
          <b>/v1/health</b>: auth check — echoes which partner your key belongs to.
        </p>
      </div>

      <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#e1e4ea', margin: '36px 0 6px' }}>
        RFQ Maker API
      </h1>
      <p style={{ ...p, marginBottom: '24px' }}>
        Quote takers directly with firm prices and settle atomically on-chain. You sign one
        Soroban authorization entry per quote with <b style={{ color: '#e1e4ea' }}>your own key</b>;
        Ufama never holds it and never holds funds — there is no escrow. If the taker accepts, their
        transaction carries your signed entry and both legs settle together or not at all. The
        protocol fee (0.5 bps) comes out of the taker&apos;s payment leg. Issuers can quote their own
        assets at NAV; the contract can enforce a NAV band on-chain for pairs with an oracle feed.
      </p>

      <div style={section}>
        <div style={h2}>Flow</div>
        <span style={code}>{`GET  /api/rfq/stream            SSE: request.created / request.closed   (x-api-key)
GET  /api/rfq/open              same, for pollers                       (x-api-key)
POST /api/rfq/:id/prepare       -> unsigned auth entry for your quote   (x-api-key)
     sign it locally: authorizeEntry(entry, keypair, expiryLedger, passphrase)
POST /api/rfq/:id/quote         { signedAuthXdr }                       (x-api-key)`}</span>
        <p style={p}>
          Maker keys are issued manually (same contact as below); the key&apos;s label is the trust
          badge takers see on your quote card. A reference bot that does all of this is in the repo:{' '}
          <b>backend/src/rfq/maker-bot.ts</b> (<b>npm run maker</b>).
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /api/rfq/:id/prepare</div>
        <span style={code}>{`{
  "maker":        "G...",          // the wallet that will sign and deliver
  "amountOut":    "999500000",     // base units of tokenOut you deliver for request.amountIn
  "maxNavDevBps": 50,              // optional; 0 = no on-chain NAV check (default 50 when a feed exists)
  "ttlLedgers":   120              // optional; default = request window + ~1 min grace
}
→ {
  "quote":        { maker, taker, tokenIn, tokenOut, amountIn, amountOut, expiryLedger, nonce, maxNavDevBps },
  "authEntryXdr": "<SorobanAuthorizationEntry, unsigned>",
  "check":        { fee, makerReceives, fairOut, vsNavBps }   // what the contract will enforce
}`}</span>
        <p style={p}>
          The server simulates the full settlement with your balances before answering, so a quote
          you cannot fund, or one outside its NAV band, is refused here with the contract&apos;s own
          reason. Sign <b>authEntryXdr</b> with <b>validUntilLedgerSeq = quote.expiryLedger</b>.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>POST /api/rfq/:id/quote</div>
        <span style={code}>{`{ "signedAuthXdr": "<SorobanAuthorizationEntry, signed>" }
→ { "quote": { id, makerLabel, amountOut, expiryLedger, vsNavBps, status: "live" } }`}</span>
        <p style={p}>
          Every submission is verified against the live host in enforce mode (signature, nonce,
          expiry, balances, NAV band) before the taker sees it. One live quote per maker per
          request — a re-quote supersedes. Requests carry a <b>reference</b> (NAV from
          RedStone/Reflector or the on-chain feed, the best DEX route, standing-book fills) so you
          can price off the same anchor the taker compares against.
        </p>
      </div>

      <div style={section}>
        <div style={h2}>Taker side (public)</div>
        <span style={code}>{`POST /api/rfq/request          { taker, tokenIn, tokenOut, amountIn, ttlSec? }
GET  /api/rfq/:id              request + live quotes (no signed XDR exposed)
POST /api/rfq/:id/accept       { quoteId } → { xdr }   sign with the taker wallet, submit via /api/swap/submit
POST /api/rfq/:id/settled      { hash }`}</span>
      </div>

      <div style={section}>
        <div style={h2}>Contact</div>
        <p style={{ ...p, marginBottom: 0 }}>
          API keys, integration help, or anything else:{' '}
          <a href="mailto:hello@ufama.trade" style={{ color: '#6366f1' }}>hello@ufama.trade</a>
        </p>
      </div>
    </div>
  );
}

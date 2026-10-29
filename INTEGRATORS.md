# Ufama Integrator API (v1)

REST API for wallets and payment apps that want to offer swaps on Stellar
without running their own routing. Same shape as the Soroswap API, so if
you've integrated that, this is familiar: **quote → build → your user signs
→ send**. We never see keys; every transaction is signed client-side by
your user's wallet.

Base URL: `https://atomicswap-aggregator-production.up.railway.app`

## SDK and OpenAPI

- TypeScript: `sdk/` in this repo (`@ufama/sdk`) wraps everything below plus
  both sides of the RFQ, including local signing of maker quotes.
- Any language: the API host serves `GET /openapi.yaml`.

## Auth

Every `/v1/*` request needs an API key, sent either way:

```
x-api-key: ak_live_...
Authorization: Bearer ak_live_...
```

Keys are issued manually for now — email hello@ufama.trade. Rate limit: 120
requests/min per key (429 with `retryAfterSeconds` beyond that).

## Partner fees

Add `feeBps` (integer, max 100 = 1%) plus `referralAddress` (your
fee-collection account) to `/v1/quote` and `/v1/quote/build`. On
**classic (SDEX) routes** the fee is appended to the same transaction as a
second operation — atomic with the swap, paid in the output asset, so your
`referralAddress` must hold a trustline for every output asset you enable.
On **Soroban routes** fee collection isn't wired yet (`partnerFeeCollected:
false` in the response — Router contract support is on the roadmap); quotes
always tell you which kind won before you commit.

## Endpoints

### GET /v1/health
Auth check. Returns `{ status, partner, network }`.

### GET /v1/tokens
Tradeable universe: `{ symbol, name, contract, issuer, decimals, verified,
venueVolume }`. Sort by `venueVolume` for a "top tokens" list.

### POST /v1/quote
```json
{
  "assetIn":  "CAS3J7GY... (SAC contract or symbol)",
  "assetOut": "CCW67TSZ...",
  "amount":   "1000000000",
  "slippageBps": 50,
  "feeBps": 25,
  "referralAddress": "G..."
}
```
`amount` is base units (7 decimals), EXACT_IN only. Response:

```json
{
  "amountOut": "164847192",
  "partnerFee": "413150",
  "partnerFeeCollected": false,
  "minAmountOut": "164022956",
  "kind": "soroban",
  "segments": [{ "venue": "Aqua", "amountIn": "...", "expectedOut": "..." }]
}
```
`amountOut` is net of protocol fee AND your partner fee. Quotes are
indicative — build re-prices.

### POST /v1/quote/build
Same body plus `from` (the user's address that will sign). Returns
`{ xdr, kind, partnerFee, partnerFeeCollected, expectedOut }`. Hand `xdr`
to the user's wallet (Freighter, xBull, LOBSTR, … — any SEP-43 signer),
have them sign against `Public Global Stellar Network ; September 2015`.

### POST /v1/send
`{ "xdr": "<signed>" }` → `{ status, result }`. Or submit yourself via
Horizon (classic kind) / Soroban RPC (soroban kind) if you prefer.

## Flow summary

```
POST /v1/quote        → show the user the price
POST /v1/quote/build  → get unsigned XDR
(user signs in their wallet)
POST /v1/send         → done
```

## Config (operator)

- `INTEGRATOR_API_KEYS` — comma-separated `name:key` pairs, e.g.
  `meru:ak_live_abc123,airtm:ak_live_xyz789`. Keys must be ≥16 chars.
- `V1_RATE_LIMIT_PER_MIN` — default 120.

# @ufama/sdk

TypeScript client for the [ufama](https://www.ufama.trade) API. Three roles, one package:

- **Integrators** — quote → build → your user signs → send (`client.v1.*`, keyed).
- **RFQ takers** — ask for firm quotes at NAV, accept one, settle atomically (`client.rfq.*`, public).
- **RFQ makers** — answer requests with quotes you sign with your own key (`runMaker`, maker key).

The SDK never holds keys. Every signature is produced by a `Keypair` or a callback you pass in.
Node 20+ (uses global `fetch`). Peer dependency: `@stellar/stellar-sdk` 17.

```bash
npm i @ufama/sdk @stellar/stellar-sdk
```

## Integrator swap

```ts
import { UfamaClient } from '@ufama/sdk';

const ufama = new UfamaClient({ apiKey: process.env.UFAMA_API_KEY });
const q = await ufama.v1.quote({ assetIn: 'XLM', assetOut: 'USDC', amount: '1000000000', feeBps: 25, referralAddress: 'G…' });
const { xdr } = await ufama.v1.build({ from: userAddress, assetIn: 'XLM', assetOut: 'USDC', amount: '1000000000', feeBps: 25, referralAddress: 'G…' });
const signed = await wallet.signTransaction(xdr); // Freighter, xBull, your custody…
await ufama.v1.send(signed);
```

## RFQ taker

```ts
import { UfamaClient, requestAndSettle } from '@ufama/sdk';

const ufama = new UfamaClient();
// See the reference first: oracle NAV, issuer NAV, DEX route, standing book
const ref = await ufama.rfq.reference({ tokenIn: 'USDC', tokenOut: 'USTRY', amountIn: '1000000000' });

const { hash, quote } = await requestAndSettle(
  ufama,
  { taker: userAddress, tokenIn: 'USDC', tokenOut: 'USTRY', amountIn: '1000000000' },
  (xdr) => wallet.signTransaction(xdr)
);
console.log(`filled ${quote.amountOut} from ${quote.makerLabel}, NAV ${quote.vsNavBps} bps, tx ${hash}`);
```

Under the hood: `rfq.request` → poll `rfq.get` → `rfq.accept` returns one transaction carrying the maker's pre-signed authorization → your wallet signs → `submit`. Both legs move in that one transaction or nothing moves.

## RFQ maker

You need a maker API key (the key's label is the badge takers see) and a funded wallet. Pricing is yours; the request carries the same reference the taker is comparing against.

```ts
import { Keypair } from '@stellar/stellar-sdk';
import { UfamaClient, runMaker, priceAtNavMinus, MAINNET_PASSPHRASE } from '@ufama/sdk';

const signer = Keypair.fromSecret(process.env.MAKER_SECRET!);
await runMaker({
  client: new UfamaClient({ apiKey: process.env.UFAMA_MAKER_KEY }),
  maker: signer.publicKey(),
  signer,                       // or a callback for an HSM / custody API
  networkPassphrase: MAINNET_PASSPHRASE,
  price: (r) => priceAtNavMinus(r, 5),          // NAV − 5 bps, or null to skip
  maxNavDevBps: (r) => (r.reference.oracleOnChain ? 50 : 0),
  onQuoted: (r, q) => console.log('quoted', r.id, q.amountOut),
  onSkipped: (r, why) => console.log('skip', r.id, why),
});
```

What `runMaker` does per request: `rfq.prepare` (the API simulates the full settlement with your balances and returns the exact unsigned authorization entry) → `signQuoteEntry` with your key, bound to the quote's expiry ledger → `rfq.submitQuote` (the API verifies the signed entry against the live host before any taker sees it). Inventory is implicit: a request you cannot fund is refused at prepare and skipped.

Issuers quoting their own asset at NAV + 0 use exactly this loop. If your treasury signs through an HSM, pass a `SigningCallback` that signs the 32-byte payload hash.

## Reference

| Call | Auth | Returns |
|---|---|---|
| `assets()` | – | tradeable universe + P2P corridor |
| `rfq.reference({tokenIn, tokenOut, amountIn, taker?})` | – | oracle NAV, issuer NAV, DEX route, book |
| `rfq.request(...)`, `rfq.get(id)`, `rfq.accept(id, quoteId)`, `rfq.cancel(id)`, `rfq.settled(id, hash)` | – | taker flow |
| `submit(signedXdr)` | – | relay a signed transaction |
| `rfq.open()`, `rfq.stream(onEvent)`, `rfq.prepare(id, …)`, `rfq.submitQuote(id, signedAuthXdr)` | maker key | maker flow |
| `v1.tokens()`, `v1.quote(...)`, `v1.build(...)`, `v1.send(xdr)` | integrator key | instant swaps |

Errors throw `UfamaApiError` with `status` and the API's `error` message. Amounts are base-unit strings; decimals come from `assets()` / `v1.tokens()` (7 for classic assets, 18 for deRWA tokens, 8 for SolvBTC).

OpenAPI spec: `GET /openapi.yaml` on the API host. Keys: hello@ufama.trade.

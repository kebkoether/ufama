# Deployments

## Mainnet v1.2.1 — LIVE SET (v1.2 deployed 2026-09-03, Router v1.2.1 2026-09-11, Curve adapter 2026-10-15)

| Contract | Address |
|---|---|
| FeeVault (reused from v1.1) | `CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP` |
| SwapBook v1.2 | `CB2KKROC2H6H757TY4H67ZAT3POFZWY532WOMQDQFWUFWK7PTJUTAEBN` |
| Router v1.2.1 (surplus share) | `CCT3IA6HKUA5GCAR7XLSNR4N5V2WEKDM6G4OSZ4EDXNS56CLDFBT2BDO` |
| TwapBook v1.2 | `CD7NOEXYJJKRPNADYM6C3AST33HF7WLYFOMWGQCX5MHD4CM7LYPB7U6I` |
| Aqua adapter v1.2 (venue 1) | `CBYQV73IOS3KFIXZV6TC3LC7CPQQGTFQG2UEJ5EF5LFBMVBF7XRSUJCE` |
| Sushi adapter v1.2 (venue 2) | `CAWVG65APH5K56AS7FWXKKDLSJQUO5WIGCVFUFFFRA2JOJ35OYERLCVR` |
| Curve adapter (venue 4, UNARMED) | `CCTMKF4PIHIW6UKF3ETVNLE4Z3ZSGLI4HMDWVWCXKSHJHVZEILKGMG7O` |
| RfqSettle (2026-10-17) | `CBFNGCV7IIZC2E2LUQFLBJU2E4UKG4AINSDWWOU5S64OFKHXTOB74DNB` |

Admin/deployer: `GB3BIN23PHTOPHTEGTC4VCY2HVSY6HDYG3C6QXQQ3TCEJR74K6DWGMQT`.
Router v1.2 `CBSF6G7HXYWHXQDGZROJU4MLONCTNZXF7U3LNURUYMWR5B75TZJGAUJW` is
retired (still venue-wired, unreferenced). Router `get_venues` = [1, 2, 4].

Curve adapter: deployed with NO factory (tx `544dde45…45ace`,
`get_factory` = null). It answers PoolNotSet to every quote and the
backend reports the venue unavailable until it is armed — see
"Curve mainnet launch (pre-armed)" below. Railway needs
`CURVE_ADAPTER_CONTRACT_ID=CCTMKF4PIHIW6UKF3ETVNLE4Z3ZSGLI4HMDWVWCXKSHJHVZEILKGMG7O`
once the Curve-venue backend is deployed.

## Mainnet v1.1 — SUPERSEDED by v1.2 (deployed 2026-08-22)

| Contract | Address |
|---|---|
| FeeVault | `CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP` |
| SwapBook | `CB2UJMIFIT3SKCAKD7FDSRJCU6KWV2WXHLWSH25WKO6PMSRVMZDRS5CI` |
| Router | `CDY6O3L2D4FVJCCW3MBO76ZYKNZXNKCVB4JRXXIWJJSXHA2VE4SSZDXK` |
| TwapBook | `CDB2E3K6R7EAJS3XWW3C3UZXXH3EK66FJPRU7OISUDP4SO7KYDR5FJD6` |
| Aqua adapter | `CCTL6C4PYDTXT6GL5YTE6CG4ZH2EXKJONUP4445SMTY5AYQPNQY666HZ` |
| Sushi adapter (factory fallback) | `CDFNVWKR6BO57LR3PMGGDK456FOAOILKSPE56GYRFGIY2Q5JPUULL3IY` |

Git tag: `v1.1.0`. Fees verified on-chain at deploy: Router 0/100k
(ZERO — instant swaps venue-fees-only, cap 0.5 bps), SwapBook 5/100k
(0.5 bps, settable ≤ cap), TwapBook 100/100k (10 bps, settable ≤ cap).
Venues 1 = Aqua, 2 = Sushi on Router and TwapBook. Aqua XLM/USDC pool
registered: concentrated `CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV`
(hash `24f9c991…71f3`). Sushi pairs resolve PERMISSIONLESSLY via the
factory — no per-pair registration.

Post-deploy TODOs:
- [ ] SwapBook oracle admin is TEMPORARILY the deployer — repoint to the
      Railway oracle pusher's public key (`set_oracle_admin`) before
      oracle-mode (market) orders open.
- [ ] Configure SEP-40/Reflector (`set_sep40_oracle` + `set_sep40_feed`
      per token) — until then pairs use the guarded pushed price.
- [ ] Railway cutover: the seven env values above + `SWAPBOOK_V11=1`.

## Mainnet v1.0 (SUPERSEDED by v1.1 — was the canary set, dust-tested 2026-08-17)

| Contract | Address |
|---|---|
| FeeVault | `CAIBVO2HVR77N6ZMUNFG23ORBONCJGKN7WSBYSMSDUFYTC43YJVASOWI` |
| SwapBook | `CBPTU2MADELJOEPJWJIJUYXM36YFKQYMECNDIW6SFLZZ3XKABGZ44SVF` |
| Router | `CD4EKANBDBF5NNV6BNJVPIHGZLLUKEXBB3QXZ3QWPOX5LNCEFPOJ2J6I` |
| TwapBook (v2, settable fee) | `CCOFNUDEHVPZQSDLENYA6DGX3UTQQVYTUMG5ZBEYFIMNA4C3IQLPTONJ` |
| Aqua adapter (v3) | `CC3P5UNO6PBVAKKQ7A6SJZ6G566X3VF2XNH5BFI7A3VFUGIMNPOP2HDY` |
| Sushi adapter (v3) | `CDK4YWZSUEPCNDBA3VUVKXFLEKD2HWJ7JFXV5MEBGXWO6HNUO3YJ5D3R` |

Admin/deployer: `GB3BIN23PHTOPHTEGTC4VCY2HVSY6HDYG3C6QXQQ3TCEJR74K6DWGMQT`
Aqua pool registered on the adapter: XLM/USDC constant-product
`CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE`
(hash `b2e02fcf…aab7f0`). Venue 1 = Aqua, venue 2 = Sushi on both Router
and TwapBook. Sushi pair registered: XLM/USDC fee-3000 canonical pool
`CCR2CH4GQVCZHG7CHFVMNANCK45CU5DVKXZIIITDZQAU3CEJZ7RQH2MQ` (2.4M XLM deep).
SushiSwap venue contracts (reverse-engineered, see memory/PR notes):
router `CDMIM23W…ZCHL`, quoter `CASKWJSI…2RWC`, factory `CCRSMJDI…GZGF`,
position manager `CARTUL5A…UQZ4`. The adapter calls pools DIRECTLY
(pool.swap + invoker auth + pre-authorized deterministic transfer) —
Sushi's own router path is unusable from contracts (auth context contains
dynamic oracle-hint state) and swap_prefunded is gated to their routers.

Verified with dust-sized real transactions: instant swap via Aqua
(fee exact at 0.5 bps ceil), P2P place/quote/fill, TWAP place +
permissionless slice + live AheadOfSchedule rejection + cancel refund,
FeeVault withdrawal. **Contracts are unaudited — do not publicize or
route size until the audit line in the deployment plan is met.**

TwapBook v2 (deployed 2026-08-19): protocol fee now admin-settable via
`set_fee`, initialized at 10 bps with a compile-time hard cap of 10 bps
(`MAX_FEE_PER_100K = 100`) — verifiable on-chain via `get_fee`. Venues 1
(Aqua) and 2 (Sushi) re-registered. Set Railway
`TWAP_BOOK_CONTRACT_ID=CCOFNUDEHVPZQSDLENYA6DGX3UTQQVYTUMG5ZBEYFIMNA4C3IQLPTONJ`.

Superseded mainnet contracts (do not use): TwapBook v1
`CAMZXFZC…3Q2Z` (fixed 0.5 bps fee), `CCYFDTWA…GR22` (adapter v2, auth fix
mis-ordered), plus one adapter v1 with the allowance-based flow.

## Testnet (2026-08-13)

| Contract | Address |
|---|---|
| FeeVault | `CAE7OFX4PJZ3YXP7WHSHGG6YGA2SOR6WBWCHCNRO4YIDXEYQYHMMAJPC` |
| SwapBook | `CBHLP5NVC4MW5IW5LADGQHHH35LSDY2P6LM5RABKPGXVZVTYKGJJY3NI` |
| Router | `CDHWQFVZ7CIUZQL334ZQW2IEINCM3H66SZD77WO2IQ2NBUTKO2UF35LR` |
| TwapBook | `CCL6X6X5YWCHVFFDLX63TCIV4R2GTEHEZPEHG4TJLVIOP52DXJ7YQHMH` |
| Aqua adapter | `CBJTYQG3V2VC2KSMNT4KRXRULU6FSGWXX2AT453QZBGI2AFHKZREIBUH` |
| RfqSettle (2026-10-16) | `CB4TBZBK6SLTVBAOV3IRI6DLH27P23WT3C5J7UXDW3FJ7BIX5WVVZ43W` |

RFQ end-to-end verified on testnet 2026-10-16: maker bot (testnet
`maker` identity) quoted a 100 USDC → USDT0 request in 2s, taker signed
with the CLI, `settle_quote` landed (tx `bfdd63ef…26aa`): taker −100 USDC
/ +99.95 USDT0, FeeVault +0.005 USDC, `is_used` true, replay refused.
Negative paths exercised live: NAV-band breach, tampered signature,
unfunded maker, unregistered key, closed request. The testnet SwapBook
carries a pushed 1:1 USDC/USDT0 oracle price (deployer is oracle admin)
so the on-chain NAV band path runs there.

Curve (StableSwap-NG) is NOT registered on testnet by design. Its
testnet factory `CANV76QKMKSQ26WZMLGVBGML5BCXKKZN2D2Q7HWFLKAEYZ6WWOJ6MHDS`
and 3-pool `CB6PW7DRUI5GO652L7CRUOOPAZ4IBMWKQ7RCM7SGWFFF5YQKV6PIXFXN` were
used once (2026-10-15) to verify the adapter's ABI assumptions and the
quote path; the venue was then removed from the testnet Router.

## RFQ settlement — mainnet rollout

RfqSettle deployed 2026-10-17: `CBFNGCV7IIZC2E2LUQFLBJU2E4UKG4AINSDWWOU5S64OFKHXTOB74DNB`
(admin mainnet-deployer, fee_vault CBNI2QR4…HPXP, swap_book CB2KKROC…AEBN,
fee 5/100k). Code rent for the 11 KB wasm was ~16.6 XLM. Step 1 below is
done. Steps 2–3 done 2026-10-23: Railway carries RFQ_CONTRACT_ID +
RFQ_MAKER_KEYS ("SDF Liquidity"); a maker runs from Klint's laptop with
the dedicated CLI identity `sdf-maker` (GDDSD2TN…6WYS, 50 USDC +
6 XLM inventory). **First mainnet RFQ settlement 2026-10-23**: taker
mainnet-tester sold 0.5 XLM for 0.872912 USDC at NAV −5 bps with the
50 bps on-chain band active (XLM/USDC Reflector feeds), tx
`d31b07a2…fb0a`. Repeatable: `scripts/rfq-smoke.sh`.

Always-on maker (instead of the laptop): in Railway, add a second
service from this repo — root directory `backend`, config-as-code
path `backend/railway.maker.json` (start command runs the bot, no
healthcheck), variables UFAMA_API_URL (the backend's public URL),
RFQ_MAKER_KEY (one of RFQ_MAKER_KEYS), RFQ_MAKER_SECRET (the maker
wallet's S… key — Railway's secret store, nowhere else),
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015",
RFQ_SPREAD_BPS=5, RFQ_MAX_NOTIONAL=50000. One service per maker wallet.

TODO (admin tx, run by Klint): `bash scripts/register-rwa-feeds.sh`
registers RedStone feeds for USTRY/CETES/TESOURO on the SwapBook so
those pairs get the NAV band (RedStone publishes all three). Until then
they quote with band 0. On-chain NAV (`fair_value`) answers today for
USDC→deJTRSY and USDC→USDY (SwapBook SEP-40 feeds); USDC→USTRY has no
feed registered on the SwapBook yet, so USTRY quotes run with band 0
until `set_sep40_feed` adds its RedStone feed.

| Step | Command / action | What it does |
|---|---|---|
| 1 ✅ | `bash scripts/rfq.sh deploy` | Builds `contracts/rfq`, deploys it wired to the live FeeVault and SwapBook v1.2 (NAV source), prints `RFQ_CONTRACT_ID`. Admin = mainnet-deployer (rotate with `transfer_admin`/`accept_admin` like the others). |
| 2 | Railway: `RFQ_CONTRACT_ID=…`, `RFQ_MAKER_KEYS="SDF Liquidity:<key>,…"` then Deploy | Enables the RFQ tab (the frontend needs nothing); registers who may post quotes. The key label is the badge takers see. |
| 3 | Run a maker: `UFAMA_API_URL=… RFQ_MAKER_KEY=… RFQ_MAKER_SECRET=… NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" npm run maker` (backend dir) | Reference bot: quotes every request at NAV − `RFQ_SPREAD_BPS` (default 5) within `RFQ_MAX_NOTIONAL`, signs locally, posts. Run one per SDF liquidity wallet; pairs can be allowlisted with `RFQ_PAIRS=USDC>USTRY,…`. |

Issuer onboarding (Etherfuse etc.): give them a maker key; they run the
same flow with their own key and quote their asset at NAV + 0. The
contract settles atomically — no escrow, no custody by Ufama. If they
cannot sign Soroban auth entries, their API stays an off-chain reference
only.

NAV band on mainnet: pairs priced through SwapBook SEP-40 feeds (RedStone
for the RWA roster) get `maxNavDevBps` 50 by default; pairs without a
feed quote with band 0 and show "no NAV ref" on the card.

## Curve mainnet launch (pre-armed)

The Curve adapter is built to be deployed BEFORE Curve's mainnet launch
and switched on with a single call the moment their factory address is
public. Nothing else changes on launch day.

| Step | When | Command | What it does |
|---|---|---|---|
| 1 | now | `bash scripts/curve.sh deploy` | Deploys the adapter UNARMED (no factory), registers it as venue 4 on the Router. Prints `CURVE_ADAPTER_CONTRACT_ID` — set it on Railway and press Deploy once. The venue reports unavailable and costs nothing while unarmed. |
| 2 | launch day | `bash scripts/curve.sh preflight <FACTORY>` | Confirms Curve's mainnet factory/pool ABI matches what the adapter was built for (`pool_count`, `pool_registration{pool,coins}`, `get_dy`, `get_balances`, `exchange(caller,i,j,dx,min_dy,receiver)`) and that the pool pulls input via a nested `transfer(caller → pool)` — the auth pattern the adapter pre-authorizes. Refuses to pass otherwise. |
| 3 | launch day | `ADAPTER=<id> bash scripts/curve.sh arm <FACTORY>` | `set_factory` on the adapter, then quotes coin0→coin1 of the first pool through it. Within one discovery refresh (≤10 min) the backend reads `get_factory`, sweeps every registered pool, and Curve appears in `/api/health` as `curve.armed:true` with routes live. No Railway change. |

If preflight fails (ABI drift between Curve's testnet and mainnet
builds), the adapter needs a rebuild + redeploy before arming — the
unarmed venue keeps doing nothing in the meantime. Admin pins
(`set_pool`) remain available to force a specific pool.

**Curve v1.0.0 review (2026-10-23, private repo `curvefi/stableswap-rs`,
branch `release/v1.0.0`).** The release matches the adapter exactly:
`exchange(caller, i, j, dx, min_dy, receiver: MuxedAddress) -> i128` with
`caller.require_auth()`; the input is pulled by a nested
`token.transfer(caller -> pool)` (`execute.rs` → `move_coin`), the
mechanism the adapter pre-authorizes; payouts go to `receiver` (a
contract address needs no trustline); `get_dy(i,j,dx)`, `get_balances()`,
`coin_decimals()`, `coins(i)` and the SEP-41 `name` are all present;
factory `pool_count()` and `pool_registration(i) -> Option<PoolRegistration
{ pool, coins, coin_decimals, … }>` match discovery and the adapter's
field-tolerant decoder. No code change needed. Launch facts from their
`deploy.sh`: one Factory (non-upgradeable, admin = their deploy key),
one 3-coin implementation, ONE pool at launch, implementation closed
afterwards. The factory address is deterministic —
`bash scripts/curve.sh derive <ADMIN>` — so it can be known before
pool_count > 0. Their SHA256SUMS (CI `wasm` job of the release tag) can be
pinned into preflight via `EXPECTED_POOL_WASM_SHA256` /
`EXPECTED_FACTORY_WASM_SHA256`.
Release/v1.0.0 CI wasm job (run 39804728438, commit 4294412…, 2026-10-22)
built: factory.wasm 0738851daec0513310d9714f0d2757002f2a1102c22f3b23e9cf340bd1170834;
pool builds (build order 2-coin then 3-coin per build_release.sh)
a14b7606884d4a493145600c1538052ef7fbd3ab509302c0be54dbeb06c96984 and
4cbbec8e3604da9fb1115949ca737f5c26641a9b580974bd37c0980e7192b631. Confirm
which is pool-coins-3 against their published SHA256SUMS before pinning;
the launch pool is 3-coin.

Test assets USDC / USDT0 issued by the testnet deployer
`GBSFQ5KPAH76PGXVG2WIJFOAEYZNUIZDYVWACGLK7JXTBVKDA4H6MGDY`.
Note: Stellar testnet resets quarterly — these expire with it.

# Deployments

## Mainnet v1.1 — LIVE SET (deployed 2026-08-22)

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

Test assets USDC / USDT0 issued by the testnet deployer
`GBSFQ5KPAH76PGXVG2WIJFOAEYZNUIZDYVWACGLK7JXTBVKDA4H6MGDY`.
Note: Stellar testnet resets quarterly — these expire with it.

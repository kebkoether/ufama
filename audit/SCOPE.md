# Audit scope — ufama contract set (prepared 2026-11-02)

Companion to [THREAT_MODEL.md](../THREAT_MODEL.md) (26 STRIDE threats,
T-xxx ids), [ARCHITECTURE.md](../ARCHITECTURE.md), [SCANS.md](./SCANS.md)
and [REMEDIATION.md](./REMEDIATION.md). This document is what we hand an
auditor: what to look at, what we believe holds, what we already know.

## Commit of record

Tag **`audit-2026-11-05`** = `main` at
`31c10cc4b788623ece4bcb2ecc39c4dda29e6e01` (merged 2026-11-09). Contract
sources were frozen on 2026-11-05 when the pre-audit fixes in
[PRE-AUDIT.md](./PRE-AUDIT.md) landed and RfqSettle v1.1 was deployed; the
scans in [SCANS.md](./SCANS.md) ran against those same sources (`3e2e073`),
and the commits between `3e2e073` and the tag touch only CI and audit
documentation. We will not deploy new contract code during the engagement.
Contracts are **not upgradeable**; findings ship as new deployments.

Toolchain: pinned in `contracts/rust-toolchain.toml`; target
`wasm32v1-none`; soroban-sdk 27. Build and test:

```bash
cd contracts
cargo test
cargo clippy --all-targets -- -D warnings -A clippy::too-many-arguments -A clippy::inconsistent-digit-grouping -A deprecated
cargo build --release --target wasm32v1-none
```

## In scope

| Contract | Path | Rust LOC | Unit tests | Mainnet address | Priority |
|---|---|---|---|---|---|
| RfqSettle | `contracts/rfq/src/lib.rs` | 490 | 14 | `CBOK7OLUI763SDSBEUXDEMTOM2OLH4ETIIKPCJBQZG6SETK7YSEPSAT7` | **1** |
| SwapBook v1.2 | `contracts/swap-book/src/lib.rs` | 1563 | 41 | `CB2KKROC2H6H757TY4H67ZAT3POFZWY532WOMQDQFWUFWK7PTJUTAEBN` | **1** |
| Router v1.2.1 | `contracts/router/src/lib.rs` | 828 | 17 | `CCT3IA6HKUA5GCAR7XLSNR4N5V2WEKDM6G4OSZ4EDXNS56CLDFBT2BDO` | 2 |
| TwapBook v1.2 | `contracts/twap-book/src/lib.rs` | 699 | 13 | `CD7NOEXYJJKRPNADYM6C3AST33HF7WLYFOMWGQCX5MHD4CM7LYPB7U6I` | 2 |
| FeeVault | `contracts/fee-vault/src/lib.rs` | 150 | 3 | `CBNI2QR4LBM7GLLKSYOIASACBRSKNDMLDZAGUOTBBHMCAPCZH5HSHPXP` | 3 |
| Aqua adapter | `contracts/adapters/aqua/src/lib.rs` | 404 | — | `CBYQV73IOS3KFIXZV6TC3LC7CPQQGTFQG2UEJ5EF5LFBMVBF7XRSUJCE` | 3 |
| Sushi adapter | `contracts/adapters/sushiswap/src/lib.rs` | 388 | — | `CAWVG65APH5K56AS7FWXKKDLSJQUO5WIGCVFUFFFRA2JOJ35OYERLCVR` | 3 |
| Curve adapter | `contracts/adapters/curve/src/lib.rs` | 385 | — | `CCTMKF4PIHIW6UKF3ETVNLE4Z3ZSGLI4HMDWVWCXKSHJHVZEILKGMG7O` (unarmed) | 3 |

About 4,900 lines of contract Rust plus `contracts/integration-tests`
(cross-contract tests). Adapter tests live in the integration crate.

Priority 1 is where user funds sit or where a third party's signature is
consumed. Priority 2 holds funds transiently (Router) or in escrow
(TwapBook). Priority 3 is stateless glue or admin-only.

## Out of scope (but available for context)

- Backend (`backend/`, TypeScript): quote building, RFQ relay, maker
  API keys, wallet screening. Not trusted for fund safety (trust
  assumption 4 in the threat model); every price floor is re-enforced
  on-chain.
- Frontend (`frontend/`) and SDK (`sdk/`).
- External venues (Aqua, SushiSwap V3, Curve stableswap-rs, Stellar DEX)
  and oracles (Reflector, RedStone SEP-40 adapters). Registered venues
  are protocol-trusted (assumption 2); a malicious registered venue is
  analyzed as admin compromise (T-ADM-2).

## Privileged roles

| Role | Held by | Powers |
|---|---|---|
| Contract admin (all contracts) | `GB3BIN23…GMQT`, single key in the operator's local `stellar` CLI keystore | register/remove venues, set fees within compile-time caps, set oracle + feeds, withdraw FeeVault, two-step admin transfer |
| SwapBook oracle admin | currently the deployer (to be repointed) | push guarded prices for pairs WITHOUT SEP-40 feeds |
| RFQ maker | any key the backend issues an API key to | sign quotes; bound by its own signature only |
| Keeper (TWAP) | nobody in particular | permissionless, constrained on-chain |

Fee caps (per 100k, compile-time): Router 5, SwapBook 5, RfqSettle 5,
TwapBook 100. Live values: 0 / 5 / 5 / 100.

## Areas we want the auditor to spend time on

1. **RfqSettle auth flow.** The maker pre-signs a Soroban authorization
   entry for `settle_quote` with the full `Quote` struct as arguments;
   the taker's transaction carries that entry and the taker signs as
   source. Questions: can the entry be replayed (nonce in temporary
   storage vs `expiry_ledger`), re-bound to another quote, or consumed by
   someone other than `quote.taker`? Does the maker's entry authorize
   exactly one `transfer` of `amount_out`?
2. **NAV band.** `settle_quote` reads `SwapBook.get_oracle_price` for the
   pair, both directions, and must fail closed when no feed exists.
   Rounding direction, decimals handling across feeds, stale prices.
3. **SwapBook `match_and_place`, partial fills, excluded counterparties,
   self-fill rejection**, dust and rounding in partial fills, storage
   growth and TTL.
4. **Oracle precedence**: SEP-40 feed when both tokens have one, else the
   guarded admin-pushed price; staleness and deviation guards.
5. **Router surplus share and partner fee split** (`execute_route_partner`):
   fee taken from output, caps, who receives surplus.
6. **TwapBook** slice execution by permissionless keepers: price floors,
   slippage per slice, keeper griefing.
7. **Fee accounting**: every fee path lands in FeeVault; no path lets fees
   exceed the cap or be redirected.
8. **Storage lifetimes**: instance/persistent/temporary choices and TTL
   extension; archived-entry behaviour on settle/fill.

## Known issues and accepted risks

- Single admin key, not yet hardware or multisig (REMEDIATION #2). Gate:
  TVL growth.
- SwapBook oracle admin is still the deployer key (DEPLOYMENTS.md TODO).
- Curve adapter deployed unarmed; arming is an admin call once Curve's
  mainnet factory exists, verified against pinned wasm hashes.
- `env.events().publish` deprecation and `cargo fmt` normalization
  deliberately deferred so audit-facing diffs stay small (REMEDIATION
  #9, #10).
- cargo audit: RUSTSEC-2026-0387 (crypto-bigint, host-side only, not in
  wasm) ignored in `contracts/.cargo/audit.toml`; `paste` unmaintained
  and `spin` yanked are transitive via soroban-sdk.

## Invariants we believe hold

Sixteen invariants, each tied to the enforcing lines, are listed in
[PRE-AUDIT.md](./PRE-AUDIT.md) together with the findings of the internal
adversarial review (3 Medium, 5 Low, all fixed or accepted-and-disclosed).

Operational rules the contracts assume (candidates for the audit to
challenge): admin-pushed prices are directed per (A,B); SEP-40 feeds
crossed for a pair must share a quote currency; feed decimals are
snapshotted at registration; the first pushed write for a pair has no
jump cap; RFQ makers quote gross of the taker-side fee.

## Deliverables we ask for

Report with severity-ranked findings and reproduction steps, a fix
verification pass on the redeployed contracts, and permission to publish
the report in this folder.

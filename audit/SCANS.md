# Security Tooling Scans

Scan reports for the Soroban contract workspace (`contracts/`), run on
2026-11-05 against commit `3e2e073` (main after the pre-audit fixes,
RfqSettle v1.1 deployed). Remediation for anything actionable:
[REMEDIATION.md](./REMEDIATION.md).

> **Supersedes the 2026-08-21 scans.** That run reported "Analyzed, 0
> findings" for every crate. In hindsight the detectors never executed:
> Scout's pinned nightly could not compile the workspace (see "Running
> Scout" below) and the tool still printed a clean table. The 2026-11-05
> run is the first Scout report with real detector output for this
> codebase, so the numbers below are not a regression against August.

## cargo audit (RustSec advisory database)

Tool: `cargo-audit` (RustSec). **Also runs in CI on every PR.**

Result: **0 vulnerabilities**, 2 informational warnings, 1 ignored advisory:

| Advisory | Crate | Status |
|---|---|---|
| RUSTSEC-2024-0436 (unmaintained) | `paste` 1.0.15 | Transitive dependency of `soroban-sdk` — no downstream action available; REMEDIATION #8 |
| yanked | `spin` 0.9.8 | Transitive dependency; same handling |
| RUSTSEC-2026-0387 (ignored in `contracts/.cargo/audit.toml`) | `crypto-bigint` via `soroban-env-host` 27 → `k256` | Host-side only (test harness and CLI tooling); not linked into any contract wasm. Ignored with justification in the config file; revisit when `soroban-env-host` bumps `k256` |

## cargo clippy

Tool: `clippy` (rustc 1.95.0), `--all-targets -- -D warnings` with three
documented allows. **Gates CI on every PR.**

Result: **clean** under the policy. The allows, and why they are policy
rather than suppressed findings:

| Lint | Reason |
|---|---|
| `clippy::too_many_arguments` | Contract entry points (`place_order`: 10 args, `place_twap`: 12) take flat argument lists by design — Soroban invocations have no builder pattern, and grouping into structs changes the external ABI |
| `clippy::inconsistent_digit_grouping` | Amount literals are grouped at Stellar's 7-decimal boundary (`10_000_0000000` = 10,000 units), which is intentional and more readable for stroop math |
| `deprecated` | `env.events().publish` is soft-deprecated in soroban-sdk 27 in favor of `#[contractevent]`. Migrating changes the on-chain event encoding, so it ships with the next contract deployment, not as a repo-only edit (REMEDIATION #9) |

## Tests

`cargo test --workspace`: **112 passed, 0 failed** (rfq 14, swap-book 41,
router 17, twap-book 13, fee-vault 3, integration-tests 11, adapters).

## CoinFabrik Scout (Soroban static analyzer)

Tool: `cargo-scout-audit` 0.3.16 (dylint 4.1, nightly-2025-08-07), run
in GitHub Actions (`.github/workflows/scout.yml`, run 42123935180) with
`--target=wasm32v1-none`. Report: [scout-report.md](./scout-report.md).

Result: **all nine workspace crates analyzed; 61 Critical, 73 Medium,
3 Minor, 17 Enhancement raw hits.** After triage (below): **no finding
requires a code change before the audit.** Every Critical is the
`integer-overflow-or-underflow` pattern lint, which this workspace
neutralizes at the profile level; the Mediums are bounded by design or
are pattern false positives. Items worth a reviewer's eye are marked
"audit note".

| Crate | Critical | Medium | Minor | Enhancement |
|---|---|---|---|---|
| swap_book | 20 | 21 | 0 | 1 |
| router | 16 | 25 | 1 | 1 |
| twap_book | 15 | 12 | 0 | 2 |
| rfq_settle | 7 | 2 | 1 | 1 |
| curve_adapter | 1 | 7 | 1 | 3 |
| aqua_adapter | 1 | 6 | 1 | 3 |
| sushiswap_adapter | 1 | 1 | 0 | 4 |
| fee_vault | 0 | 1 | 0 | 1 |
| integration_tests | 0 | 0 | 0 | 1 |

### Triage by detector

| Detector (severity, hits) | Where | Assessment | Action |
|---|---|---|---|
| `integer-overflow-or-underflow` (Critical, 61) | all contracts | The lint flags every unchecked `+ - *` on integers. `contracts/Cargo.toml` sets `overflow-checks = true` in `[profile.release]`, so an overflow **traps and reverts the transaction**; it can never wrap silently. Every value-bearing product goes through `I256` muldivs that return `Overflow` errors (RfqSettle `muldiv_*`, SwapBook/Router/TwapBook equivalents). Spot-checked sites: RfqSettle `amount_in - fee` (fee ≤ 5/100k of a positive amount), `expiry_ledger - seq` (guarded by the `Expired` check on the line above), `fair - amount_out` (both positive i128), `d - 1` (d > 0). Residual: a trap instead of a typed error on absurd inputs, which costs the caller one failed-tx fee | None. Documented invariant (PRE-AUDIT #9). **Audit note**: confirm no site can be driven to a trap by a counterparty rather than the caller |
| `missing-new-admin-auth` (Medium, 10) | every `transfer_admin` | Pattern lint for one-step admin changes. Every contract uses the two-step `transfer_admin` / `accept_admin`; the new admin signs on `accept_admin`, which is exactly the protection the lint asks for (PRE-AUDIT invariant 15) | None (false positive) |
| `dos-unexpected-revert-with-storage` (Medium, 6) and `dynamic-storage` (Medium, 8) | Router `VenueIds`; SwapBook `PairIndex`, `MakerPairCount`; TwapBook `ActiveIndex` | Vec-typed storage that non-admins can grow. Bounds: Router venues are admin-only; SwapBook pair index ≤ `MAX_ORDERS_PER_PAIR = 200` and ≤ 10 per maker (`MakerPairLimit`, PRE-AUDIT M3); TwapBook index ≤ `MAX_ACTIVE_ORDERS = 500`. Rebuild-on-remove loops are over those same bounded vectors | None. **Audit note**: T-CH-6 in THREAT_MODEL.md covers the remaining 200-order griefing cost |
| `dos-unbounded-operation` (Medium, 19) | index scans, venue loops, Curve pool scan | All loops iterate the bounded vectors above, the admin-registered venue list, or the Curve factory registry capped by `MAX_SCAN_POOLS` | None. **Audit note**: `quote_fill` may touch 200 orders (PRE-AUDIT I6, view only) |
| `unsafe-unwrap` (Medium, 19 + 4 duplicates) | `vec.get(i).unwrap()` inside `0..vec.len()` loops; Router `partner.as_ref().unwrap()` guarded by `partner_fee > 0`, which is only non-zero when `partner` is `Some` | Unreachable `None`s | None. Cosmetic: could become `expect`/`?` in the next deployment |
| `avoid-vec-map-input` (Medium, 11) | Router paths, SwapBook `excluded`/`fills`, adapters | Each element is resolved against storage (venue ids, order ids, token addresses) and rejected if unknown before any transfer | None |
| `unsafe-map-get` (Medium, 2) | Curve adapter registry read | Already `let Some(..) = map.get(..) else { continue }` — the safe form the lint recommends | None (false positive) |
| `front-running` (Medium, 1) | SwapBook fee transfer to FeeVault | The transfer is the protocol fee, not a user-chosen amount; the user-facing minimum is enforced on the fill one line earlier | None (false positive) |
| `ineffective-extend-ttl` (Medium, 1) | RfqSettle `mark_used` (`threshold == extend_to`) | Entry is written once and only read afterwards, so the call runs once per nonce. Equal arguments are the idiomatic "always extend to max" | None |
| `unused-return-enum` (Minor, 4) | views that currently only return `Ok` | Signature kept for ABI stability and future errors | None |
| `storage-change-events` (Enhancement, 8) | adapter `set_router`/`set_factory`/`set_pool`, TwapBook fee setter | Events already exist on the admin-surface paths the threat model monitors; the rest are adapter wiring | Add in the next deployment (REMEDIATION #11) |
| `soroban-version` (Enhancement, 9) | every crate | Workspace is on soroban-sdk 27.0.5 (protocol 24); crates.io latest is a 30.0.0 release candidate. The deployed contracts must stay on the protocol version mainnet runs | Bump with the post-audit redeploy (REMEDIATION #12) |

### Running Scout

Scout 0.3.16 cannot analyze a soroban-sdk 27.0.5 workspace out of the
box, and silently reports "Analyzed" with no findings when its compile
step fails. Three workarounds, all in `.github/workflows/scout.yml`:

1. Its pinned dylint 4.1 checks out branch `master` of
   `rust-lang/rust-clippy`, which was renamed to `main`; CI serves a
   local mirror that still has `master`.
2. Its default `--target=wasm32-unknown-unknown` is refused by
   soroban-sdk 27's build script on Rust ≥ 1.82; CI passes
   `--target=wasm32v1-none`.
3. Its pinned `nightly-2025-08-07` predates the stabilization of
   `str::floor_char_boundary` (Rust 1.91, used by `soroban-sdk-macros`);
   a `RUSTC_WRAPPER` injects the feature gate for that one crate.

The workflow runs weekly and on demand (Actions → Scout → Run
workflow); the report is the job summary and an artifact.

## Reproducing locally

```bash
cd contracts
cargo audit
cargo clippy --all-targets -- -D warnings -A clippy::too-many-arguments -A clippy::inconsistent-digit-grouping -A deprecated
cargo test --workspace
```

Scout: use the GitHub Actions workflow. On Windows the detector-helper
build fails before the analysis starts; on Linux the three workarounds
above are required.

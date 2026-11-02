# Pre-audit adversarial review — RfqSettle + SwapBook (2026-11-02)

Internal review of the two contracts that hold or move user value on the
narrowest trust assumptions, done before applying to the Audit Bank so
the paid audit starts from a cleaner base. Read-only review first, then
fixes on branch `feat/pre-audit-fixes`. No Critical or High findings.
Mainnet addresses are in [SCOPE.md](./SCOPE.md); fixes ship as new
deployments (contracts are not upgradeable).

Severity: Medium = a documented guarantee did not hold, or a bounded-cost
DoS / socialized-loss path; Low = liveness, economic edge, or an
inconsistency with no direct fund loss; Info = hygiene, docs, tests.

## Findings and status

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| M1 | Medium | `rfq/src/lib.rs` `read_oracle`; `swap-book/src/lib.rs` `get_oracle_price` | The RFQ NAV band accepted an arbitrarily stale admin-pushed price: RfqSettle discarded `updated_at`, and SwapBook's `get_oracle_price` returns the stored pushed price without the freshness check its own fill paths apply. SEP-40 pairs were unaffected (freshness enforced inside the feed read). | **Fixed** both sides: RfqSettle refuses `updated_at` older than 1,000 ledgers (`OracleStale`, new error 15) and SwapBook's `get_oracle_price` now runs `check_oracle_fresh` on pushed prices. Tests: `stale_pushed_price_is_refused_even_if_the_book_returns_it`. |
| M2 | Medium (design) | SwapBook escrow | All orders in a token share one contract balance. A clawback-enabled or auth-revocable asset (USDT0; typical for RWA tokens) lets the issuer claw back or freeze the pooled escrow; the shortfall is socialized onto the last makers to exit. RfqSettle has no escrow and is not exposed. | **Accepted + documented** (T-CH-12 in THREAT_MODEL.md). Not fixable in-contract for SACs. Follow-ups: issuer-flag badge in the UI, monitor `sum(open remaining) <= balance` per token. |
| M3 | Medium | SwapBook `place_order` | 200 dust orders with 90-day expiry lock a directed pair (`BookFull`) for everyone; no placement fee, no per-maker cap, no admin purge. The threat model also cited a `MAX_ACTIVE_ORDERS = 500` that does not exist and a placement fee that is not charged. | **Mitigated**: per-maker-per-pair cap of 10 open orders (`MakerPairLimit`). Threat model corrected. Runbook: set `MinOrder` for every listed token at deploy. |
| L1 | Low | SwapBook TTLs | Order entries extended to 30 days while expiry may be 90; `PairIndex` rewritten without TTL extension on removal; `Sep40Feed`, `MinOrder`, `OraclePrice` never re-extended after write; RFQ/SwapBook instance TTL only bumped on some paths. Archived entries halt fills/claims/band reads until restored (fail closed, funds safe). | **Fixed**: order TTL covers expiry; index, feed, min-order and price entries extended on touch; instance TTL extended in admin functions; permissionless `bump_ttl`. |
| L2 | Low | RfqSettle | No maker-side revocation of a signed quote: a signed quote was a free option for the taker until expiry. | **Fixed**: `cancel_nonce(maker, nonce)` writes the replay record under the maker's auth. Test: `maker_can_cancel_a_nonce_before_it_settles`. Backend/maker-bot wiring is a follow-up. |
| L3 | Low | SwapBook `fill_inner` vs Router | Maker's floor was gross of fee in SwapBook fills (maker could receive up to 0.5 bps under `min_amount_out`) but net of fee in Router timer routes. | **Fixed**: fills now require `amount_out - fee >= required_out`. RFQ makers quote gross by design (documented). |
| L4 | Low | RfqSettle | Replay record lived only until the quote's expiry, so `is_used` stopped answering for a settled nonce and the same `(maker, nonce)` could settle again under a later quote. | **Fixed**: record lives `MAX_QUOTE_TTL_LEDGERS + 1` regardless of expiry. Test: `used_record_outlives_the_quote_it_settled`. |
| L5 | Low | SwapBook, RfqSettle, FeeVault | Missing events on `remove_sep40_feed`, `set_oracle_admin`, RFQ `transfer_admin`; FeeVault admin change was one-step. | **Fixed**: events added; FeeVault now two-step (`transfer_admin` / `accept_admin`). |

Informational items (I1–I14 in the review) and what was done:

- I4 validation gaps (negative `min_amount_out` on oracle orders,
  `auto_route_after >= expiry`): **fixed** with tests.
- I8 RfqSettle views could trap instead of returning `Overflow` /
  `OracleUnavailable`: **fixed**, muldivs return `Result`. Test:
  `overflow_is_reported_as_an_error_not_a_trap`.
- I13 no test exercised the maker's real auth tree (all tests used
  `mock_all_auths`): **fixed**,
  `maker_auth_entry_is_bound_to_the_exact_quote` builds both parties'
  `MockAuth` trees and shows a tampered quote cannot be settled with the
  maker's entry.
- I14 threat-model inaccuracies: **fixed** (T-CH-6, T-CH-7, T-RFQ-2 now
  confirmed).
- I1/I2/I3/I5 (directed pushed prices, feed base-currency assumption,
  decimals snapshot at registration, first-write jump cap): documented
  as operational rules in the scope doc; candidates for the audit to
  weigh.
- I6 `quote_fill` ignores `excluded` and may iterate 200 orders: view
  only; left for the audit.
- I7/I9 (fee changes vs pre-signed entries; failed settle after auth
  does not consume the nonce, taker pays the failed fee): expected
  behaviour, now in the threat model.
- I10/I11 dust remainders and rounding direction: taker-favoured by
  < 1 base unit; left as is, noted for the audit.
- I12 `set_router` to a G-address would let that key pull escrow: admin
  trust, alert on the existing event.

## Invariants (verified against code during the review)

RfqSettle (`contracts/rfq/src/lib.rs`):

1. Only `quote.taker` can settle (`q.taker.require_auth()`); a relayer
   still needs the taker's signature over `settle_quote(q)`.
2. The maker's entry is bound to the full `Quote` (contract id,
   function, the struct with taker, tokens, amounts, expiry, nonce,
   band) plus network id and signature expiration; it cannot be re-bound.
3. The maker's entry authorizes exactly one sub-invocation:
   `token_out.transfer(maker, taker, amount_out)`. The taker's two
   transfers run under the taker's auth.
4. All validation runs before either `require_auth`; everything after
   auth reverts the transaction on failure.
5. `(maker, nonce)` settles at most once within `USED_TTL_LEDGERS`:
   host nonce consumption plus the temporary replay record.
6. Oracle reads fail closed: any non-`Ok((num > 0, den > 0, fresh))`
   outcome is `OracleUnavailable` / `OracleStale`. Band 0 skips the
   oracle by design and is visible to both signers.
7. Fee ≤ 5 / 100,000 at compile time; always paid to the stored
   FeeVault; a settle whose fee would consume the payment is refused.
8. No admin action can move user funds; `set_swap_book` can only weaken
   the band, never change signed amounts.
9. Arithmetic in `I256` with explicit `Overflow`; zero and negative
   amounts, same-token and same-party quotes refused.

SwapBook (`contracts/swap-book/src/lib.rs`):

10. Fills need an Open/PartialFill, unexpired order; fill ≤ remaining;
    payment net of fee ≥ the ceiling-rounded price; escrow out equals
    the filled amount; terminal states are terminal.
11. Partial-fill price uses the original `amount_in` as denominator so
    the per-unit price is constant and the sum of partial payments ≥ the
    full-fill payment.
12. Self-fill and excluded counterparties are rejected before any
    transfer; `match_and_place` re-reads each order per fill and checks
    the budget before each fill.
13. `claim_expired_timer` fires only between `auto_route_after` and
    expiry, derives `min_out` on-chain from the order's own terms, and
    the Router enforces it net of fee.
14. SEP-40 reads reject price ≤ 0, stale (per-feed or global max age),
    future-dated > 60 s, and missing feeds.
15. Admin rotation is two-step in every contract.
16. Soroban forbids re-entrancy; `try_invoke_contract` rolls back
    sub-call state on failure.

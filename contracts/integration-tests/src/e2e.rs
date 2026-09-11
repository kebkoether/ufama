#![cfg(test)]

//! End-to-end flows across the real contract set. Every test deploys the
//! REAL FeeVault contract (not a placeholder address) so fee accrual and
//! admin withdrawal are exercised exactly as on mainnet.

use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    token,
    token::{StellarAssetClient, TokenClient},
    Address, Env, Vec,
};

use fee_vault::{FeeVault, FeeVaultClient};
use router::{Router, RouterClient, RouteSegment as RouterSegment};
use swap_book::{SwapBook, SwapBookClient};
use twap_book::{RouteSegment as TwapSegment, TwapBook, TwapBookClient, TwapStatus};

// ─── Mock venue (production adapter interface) ──────────
// Pays token_out at rate_bps of amount_in from its own balance.

#[sdk_contract]
pub struct MockVenue;

#[sdk_contractimpl]
impl MockVenue {
    pub fn __constructor(env: Env, rate_bps: i128) {
        env.storage().instance().set(&symbol_short!("rate"), &rate_bps);
    }
    pub fn swap(
        env: Env,
        recipient: Address,
        _token_in: Address,
        token_out: Address,
        amount_in: i128,
        _min_amount_out: i128,
    ) -> i128 {
        let rate: i128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        let out = amount_in * rate / 10_000;
        token::Client::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &recipient,
            &out,
        );
        out
    }
}

// ─── Shared setup: the full mainnet contract set ────────

struct World {
    env: Env,
    admin: Address,
    vault_id: Address,
    swapbook_id: Address,
    router_id: Address,
    twap_id: Address,
    token_a: Address,
    token_b: Address,
    maker: Address,
    taker: Address,
    treasury: Address,
}

const START_LEDGER: u32 = 100;

/// Deploys FeeVault, SwapBook, Router, TwapBook wired exactly as on
/// mainnet, plus one funded mock venue registered as venue 1 on both the
/// Router and the TwapBook.
fn deploy_world(venue_rate_bps: i128) -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = START_LEDGER;
        li.timestamp = 1_000;
    });

    let admin = Address::generate(&env);
    let maker = Address::generate(&env);
    let taker = Address::generate(&env);
    let treasury = Address::generate(&env);

    let token_a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&maker, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_a).mint(&taker, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_b).mint(&taker, &1_000_000_0000000);

    let vault_id = env.register(FeeVault, (admin.clone(),));
    let swapbook_id = env.register(SwapBook, (admin.clone(), vault_id.clone()));
    let router_id = env.register(
        Router,
        (admin.clone(), vault_id.clone(), swapbook_id.clone()),
    );
    let twap_id = env.register(
        TwapBook,
        (admin.clone(), vault_id.clone(), swapbook_id.clone()),
    );
    SwapBookClient::new(&env, &swapbook_id).set_router(&router_id);

    let venue = env.register(MockVenue, (venue_rate_bps,));
    StellarAssetClient::new(&env, &token_b).mint(&venue, &10_000_000_0000000);
    RouterClient::new(&env, &router_id).register_venue(&1u32, &venue);
    TwapBookClient::new(&env, &twap_id).register_venue(&1u32, &venue);
    // v1.1 defaults the Router fee to 0; these lifecycles verify the fee
    // plumbing at the historical 0.5 bps rate.
    RouterClient::new(&env, &router_id).set_fee(&5);

    World {
        env,
        admin,
        vault_id,
        swapbook_id,
        router_id,
        twap_id,
        token_a,
        token_b,
        maker,
        taker,
        treasury,
    }
}

fn advance_to(env: &Env, seq: u32) {
    env.ledger().with_mut(|li| li.sequence_number = seq);
}

fn router_segs(env: &Env, amount: i128, min_out: i128) -> Vec<RouterSegment> {
    soroban_sdk::vec![
        env,
        RouterSegment { venue_id: 1, amount_in: amount, min_amount_out: min_out }
    ]
}

fn twap_segs(env: &Env, amount: i128) -> Vec<TwapSegment> {
    soroban_sdk::vec![
        env,
        TwapSegment { venue_id: 1, amount_in: amount, min_amount_out: 0 }
    ]
}

/// ceil(amount * num / 100_000) — the protocol fee formula.
fn fee_ceil(amount: i128, num: i128) -> i128 {
    (amount * num + 100_000 - 1) / 100_000
}

// ─── 1. P2P lifecycle: place → quote → partial fill → fill → withdraw ───

#[test]
fn p2p_lifecycle_fees_accrue_in_real_vault_and_withdraw() {
    let w = deploy_world(10_000);
    let book = SwapBookClient::new(&w.env, &w.swapbook_id);
    let vault = FeeVaultClient::new(&w.env, &w.vault_id);
    let token_b = TokenClient::new(&w.env, &w.token_b);
    assert_eq!(vault.get_admin(), w.admin);

    // Maker sells 10,000 A for at least 10,000 B (1:1)
    let amount = 10_000_0000000i128;
    let order_id = book.place_order(
        &w.maker, &w.token_a, &w.token_b,
        &amount, &amount, &10_000u32,
        &0u32, &0u32, &0u32, &soroban_sdk::vec![&w.env]);

    // Taker-direction quote: spending 4,000 B buys 4,000 A
    let pay_budget = 4_000_0000000i128;
    let (bought, paid) = book.quote_fill(&w.token_a, &w.token_b, &pay_budget);
    assert_eq!(bought, pay_budget);
    assert_eq!(paid, pay_budget);

    // Partial fill at the quoted terms
    book.partial_fill(&w.taker, &order_id, &bought, &paid);
    let fee1 = fee_ceil(paid, 5);
    assert_eq!(token_b.balance(&w.maker), paid - fee1);
    assert_eq!(vault.get_balance(&w.token_b), fee1);

    // Fill the remainder
    let rest = amount - bought;
    book.fill_order(&w.taker, &order_id, &rest);
    let fee2 = fee_ceil(rest, 5);
    assert_eq!(vault.get_balance(&w.token_b), fee1 + fee2);
    assert_eq!(token_b.balance(&w.maker), amount - fee1 - fee2);
    // Taker holds the maker's full escrow
    assert_eq!(
        TokenClient::new(&w.env, &w.token_a).balance(&w.taker),
        1_000_000_0000000 + amount
    );

    // Admin withdraws the accumulated fees to the treasury
    vault.withdraw(&w.token_b, &(fee1 + fee2), &w.treasury);
    assert_eq!(token_b.balance(&w.treasury), fee1 + fee2);
    assert_eq!(vault.get_balance(&w.token_b), 0);

    // Over-withdrawal is rejected (balance-based accounting)
    assert!(vault.try_withdraw(&w.token_b, &1, &w.treasury).is_err());
}

// ─── 2. Auth actually gates the vault ────────────────────

#[test]
fn vault_withdrawal_requires_admin_signature() {
    // No mock_all_auths here — require_auth must actually fail.
    let env = Env::default();
    let admin = Address::generate(&env);
    let intruder = Address::generate(&env);
    let vault_id = env.register(FeeVault, (admin.clone(),));
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    let vault = FeeVaultClient::new(&env, &vault_id);
    assert!(vault.try_withdraw(&token, &1, &intruder).is_err());
    assert_eq!(vault.get_admin(), admin);
}

// ─── 3. Timer auto-route: SwapBook → Router → venue → maker + vault ───

#[test]
fn timer_route_settles_maker_and_vault_atomically() {
    let w = deploy_world(10_000); // 1:1 venue
    let book = SwapBookClient::new(&w.env, &w.swapbook_id);
    let router = RouterClient::new(&w.env, &w.router_id);
    let vault = FeeVaultClient::new(&w.env, &w.vault_id);

    // 10,000 A, floor 9,999.5 B (leaves exactly the 0.5 bps fee),
    // auto-route after ledger 150
    let amount = 10_000_0000000i128;
    let min_out = 9_999_5000000i128;
    let order_id = book.place_order(
        &w.maker, &w.token_a, &w.token_b,
        &amount, &min_out, &10_000u32,
        &0u32, &0u32, &150u32, &soroban_sdk::vec![&w.env]);

    advance_to(&w.env, 200);
    let received = router.route_expired_order(&order_id, &router_segs(&w.env, amount, min_out));

    let fee = fee_ceil(amount, 5); // 1:1 venue → out == amount
    assert_eq!(received, amount - fee);
    assert_eq!(TokenClient::new(&w.env, &w.token_b).balance(&w.maker), amount - fee);
    assert_eq!(vault.get_balance(&w.token_b), fee);

    // The order is settled — a second claim must fail
    assert!(router
        .try_route_expired_order(&order_id, &router_segs(&w.env, amount, min_out))
        .is_err());

    // And the fees are withdrawable
    vault.withdraw(&w.token_b, &fee, &w.treasury);
    assert_eq!(vault.get_balance(&w.token_b), 0);
}

#[test]
fn timer_route_below_maker_floor_reverts_and_restores_order() {
    let w = deploy_world(9_500); // venue pays 95% — below the maker's floor
    let book = SwapBookClient::new(&w.env, &w.swapbook_id);
    let router = RouterClient::new(&w.env, &w.router_id);

    let amount = 10_000_0000000i128;
    let min_out = 9_999_5000000i128;
    let order_id = book.place_order(
        &w.maker, &w.token_a, &w.token_b,
        &amount, &min_out, &10_000u32,
        &0u32, &0u32, &150u32, &soroban_sdk::vec![&w.env]);
    advance_to(&w.env, 200);

    assert!(router
        .try_route_expired_order(&order_id, &router_segs(&w.env, amount, 0))
        .is_err());

    // Atomic revert: escrow intact on the book, order still claimable
    let order = book.get_order(&order_id);
    assert_eq!(order.amount_in_remaining, amount);
    assert_eq!(
        TokenClient::new(&w.env, &w.token_a).balance(&w.swapbook_id),
        amount
    );
    // No fee was minted out of thin air
    assert_eq!(
        FeeVaultClient::new(&w.env, &w.vault_id).get_balance(&w.token_b),
        0
    );
}

// ─── 4. TWAP lifecycle: pace, cadence, streaming, completion, fees ───

#[test]
fn twap_full_window_streams_proceeds_and_fees() {
    let w = deploy_world(10_000); // 1:1 venue
    let twap = TwapBookClient::new(&w.env, &w.twap_id);
    let vault = FeeVaultClient::new(&w.env, &w.vault_id);
    let token_b = TokenClient::new(&w.env, &w.token_b);

    // 1,000 A over 1,000 ledgers; fixed limit 0.9985 B/A (room for the
    // 10 bps fee on a 1:1 venue); slice cap 200 A; gap 10; 5% headroom.
    let total = 1_000_0000000i128;
    let slice = 200_0000000i128;
    let end = START_LEDGER + 1_000;
    let order_id = twap.place_twap(
        &w.maker, &w.token_a, &w.token_b,
        &total, &end,
        &9_985i128, &10_000i128, &0u32,
        &slice, &10u32, &500u32,
    );
    assert_eq!(twap.get_fee(), (100, 100_000)); // 10 bps default

    // PACE: a full slice right away exceeds pro-rata + 5% headroom
    advance_to(&w.env, START_LEDGER + 1);
    assert!(twap
        .try_execute_slice(&order_id, &slice, &twap_segs(&w.env, slice))
        .is_err());

    // First legal slice at 15% elapsed (allowed: 150 + 50 headroom = 200)
    advance_to(&w.env, START_LEDGER + 150);
    let net = twap.execute_slice(&order_id, &slice, &twap_segs(&w.env, slice));
    let fee_per_slice = fee_ceil(slice, 100);
    assert_eq!(net, slice - fee_per_slice);
    assert_eq!(token_b.balance(&w.maker), net); // proceeds STREAM per slice
    assert_eq!(vault.get_balance(&w.token_b), fee_per_slice);

    // CADENCE: immediate second slice violates min_slice_gap
    assert!(twap
        .try_execute_slice(&order_id, &1_0000000i128, &twap_segs(&w.env, 1_0000000))
        .is_err());

    // Complete the order across the window
    for step in [350u32, 550, 750, 950] {
        advance_to(&w.env, START_LEDGER + step);
        twap.execute_slice(&order_id, &slice, &twap_segs(&w.env, slice));
    }

    let order = twap.get_order(&order_id);
    assert_eq!(order.status, TwapStatus::Completed);
    assert_eq!(order.filled_in, total);
    assert_eq!(token_b.balance(&w.maker), total - 5 * fee_per_slice);
    assert_eq!(vault.get_balance(&w.token_b), 5 * fee_per_slice);

    // A completed order takes no more slices
    assert!(twap
        .try_execute_slice(&order_id, &1, &twap_segs(&w.env, 1))
        .is_err());

    // Fees are withdrawable by the admin
    vault.withdraw(&w.token_b, &(5 * fee_per_slice), &w.treasury);
    assert_eq!(token_b.balance(&w.treasury), 5 * fee_per_slice);
}

#[test]
fn twap_cancel_and_expiry_always_refund_the_maker() {
    let w = deploy_world(10_000);
    let twap = TwapBookClient::new(&w.env, &w.twap_id);
    let token_a = TokenClient::new(&w.env, &w.token_a);
    let maker_start = token_a.balance(&w.maker);

    let total = 1_000_0000000i128;
    let slice = 200_0000000i128;
    let end = START_LEDGER + 1_000;

    // Cancel path: one slice executes, the rest refunds instantly
    let id1 = twap.place_twap(
        &w.maker, &w.token_a, &w.token_b,
        &total, &end,
        &9_985i128, &10_000i128, &0u32,
        &slice, &10u32, &500u32,
    );
    advance_to(&w.env, START_LEDGER + 150);
    twap.execute_slice(&id1, &slice, &twap_segs(&w.env, slice));
    twap.cancel_twap(&id1);
    assert_eq!(token_a.balance(&w.maker), maker_start - slice);
    assert_eq!(twap.get_order(&id1).status, TwapStatus::Cancelled);

    // Expiry path: window lapses untouched, anyone can trigger the refund
    let id2 = twap.place_twap(
        &w.maker, &w.token_a, &w.token_b,
        &total, &(end + 1_000),
        &9_985i128, &10_000i128, &0u32,
        &slice, &10u32, &500u32,
    );
    advance_to(&w.env, end + 1_001);
    assert!(twap
        .try_execute_slice(&id2, &slice, &twap_segs(&w.env, slice))
        .is_err()); // past end_ledger — no more slices
    twap.expire_twap(&id2); // permissionless cleanup
    assert_eq!(token_a.balance(&w.maker), maker_start - slice);
    assert_eq!(twap.get_order(&id2).status, TwapStatus::Expired);
}

// ─── 5. Oracle: push guards + oracle-pegged fill + staleness ───

#[test]
fn oracle_guarded_pricing_end_to_end() {
    let w = deploy_world(10_000);
    let book = SwapBookClient::new(&w.env, &w.swapbook_id);
    let oracle_admin = Address::generate(&w.env);
    book.set_oracle_admin(&oracle_admin);

    // Push 1.0, then try to jump 50% — the 20% cap rejects it
    book.update_oracle_price(&w.token_a, &w.token_b, &1_0000000i128, &1_0000000i128);
    assert!(book
        .try_update_oracle_price(&w.token_a, &w.token_b, &1_5000000i128, &1_0000000i128)
        .is_err());
    // A 20% step is the boundary — allowed
    book.update_oracle_price(&w.token_a, &w.token_b, &1_2000000i128, &1_0000000i128);
    // Non-positive prices are rejected
    assert!(book
        .try_update_oracle_price(&w.token_a, &w.token_b, &0i128, &1i128)
        .is_err());

    // Oracle-pegged order at 1% slippage
    let amount = 1_000_0000000i128;
    let order_id = book.place_order(
        &w.maker, &w.token_a, &w.token_b,
        &amount, &0i128, &10_000u32,
        &1u32, &100u32, &0u32, &soroban_sdk::vec![&w.env]);

    // Fair value at 1.2, minimum payment = ceil(fair * 99%)
    let fair = amount * 12 / 10;
    let min_pay = (fair * 9_900 + 10_000 - 1) / 10_000;
    // Underpayment bounces
    assert!(book
        .try_fill_order(&w.taker, &order_id, &(min_pay - 1))
        .is_err());
    // Exactly the floor clears
    book.fill_order(&w.taker, &order_id, &min_pay);

    // Staleness: a second oracle order can't fill on an ~83-min-old price
    let order2 = book.place_order(
        &w.maker, &w.token_a, &w.token_b,
        &amount, &0i128, &20_000u32,
        &1u32, &100u32, &0u32, &soroban_sdk::vec![&w.env]);
    advance_to(&w.env, START_LEDGER + 1_001); // past ORACLE_STALE_LEDGERS
    assert!(book.try_fill_order(&w.taker, &order2, &min_pay).is_err());
}

// ─── 6. Multi-venue split route with fee on the total ───

#[test]
fn split_route_takes_fee_on_total_and_reverts_whole_on_shortfall() {
    let w = deploy_world(10_000); // venue 1 at 1:1
    let router = RouterClient::new(&w.env, &w.router_id);
    let vault = FeeVaultClient::new(&w.env, &w.vault_id);

    // Second venue paying 1.01
    let venue2 = w.env.register(MockVenue, (10_100i128,));
    StellarAssetClient::new(&w.env, &w.token_b).mint(&venue2, &10_000_000_0000000);
    router.register_venue(&2u32, &venue2);

    let half = 5_000_0000000i128;
    let total_in = 2 * half;
    let expected_out = half + half * 10_100 / 10_000; // 10,050 B
    let fee = fee_ceil(expected_out, 5);
    let segments = soroban_sdk::vec![
        &w.env,
        RouterSegment { venue_id: 1, amount_in: half, min_amount_out: half },
        RouterSegment { venue_id: 2, amount_in: half, min_amount_out: half },
    ];

    let received = router.execute_route(
        &w.taker, &w.token_a, &w.token_b,
        &total_in, &(expected_out - fee), &segments, &0,
    );
    assert_eq!(received, expected_out - fee);
    assert_eq!(vault.get_balance(&w.token_b), fee);
    // Router carries nothing between transactions
    assert_eq!(TokenClient::new(&w.env, &w.token_b).balance(&w.router_id), 0);
    assert_eq!(TokenClient::new(&w.env, &w.token_a).balance(&w.router_id), 0);

    // Asking for more than the venues can deliver reverts the WHOLE route
    let taker_a_before = TokenClient::new(&w.env, &w.token_a).balance(&w.taker);
    let greedy = soroban_sdk::vec![
        &w.env,
        RouterSegment { venue_id: 1, amount_in: half, min_amount_out: half },
        RouterSegment { venue_id: 2, amount_in: half, min_amount_out: half },
    ];
    assert!(router
        .try_execute_route(
            &w.taker, &w.token_a, &w.token_b,
            &total_in, &(expected_out + 1), &greedy, &0,
        )
        .is_err());
    assert_eq!(
        TokenClient::new(&w.env, &w.token_a).balance(&w.taker),
        taker_a_before
    );
}

// ─── 7. TWAP fee governance: settable within the compiled cap ───

#[test]
fn twap_fee_is_settable_but_hard_capped() {
    let w = deploy_world(10_000);
    let twap = TwapBookClient::new(&w.env, &w.twap_id);

    // Admin can lower (fee holiday) and restore within the cap
    twap.set_fee(&0i128);
    assert_eq!(twap.get_fee(), (0, 100_000));
    twap.set_fee(&50i128);
    assert_eq!(twap.get_fee(), (50, 100_000));

    // The 10 bps ceiling is compile-time — 101/100k must be rejected
    assert!(twap.try_set_fee(&101i128).is_err());
    assert!(twap.try_set_fee(&-1i128).is_err());

    // A slice at 5 bps charges exactly 5 bps
    let vault = FeeVaultClient::new(&w.env, &w.vault_id);
    let total = 1_000_0000000i128;
    let slice = 200_0000000i128;
    let order_id = twap.place_twap(
        &w.maker, &w.token_a, &w.token_b,
        &total, &(START_LEDGER + 1_000),
        &9_985i128, &10_000i128, &0u32,
        &slice, &10u32, &500u32,
    );
    advance_to(&w.env, START_LEDGER + 150);
    let net = twap.execute_slice(&order_id, &slice, &twap_segs(&w.env, slice));
    let fee = fee_ceil(slice, 50);
    assert_eq!(net, slice - fee);
    assert_eq!(vault.get_balance(&w.token_b), fee);
}

// ─── 8. v1.1: SDF-style liquidity wallets that never cross ───

#[test]
fn liquidity_wallets_excluded_from_crossing_each_other() {
    let w = deploy_world(10_000);
    let book = SwapBookClient::new(&w.env, &w.swapbook_id);

    // Two liquidity wallets quoting both sides of the same pair, each
    // placed with the other on its exclusion list.
    let lp_a = Address::generate(&w.env);
    let lp_b = Address::generate(&w.env);
    StellarAssetClient::new(&w.env, &w.token_a).mint(&lp_a, &10_000_0000000);
    StellarAssetClient::new(&w.env, &w.token_b).mint(&lp_b, &10_000_0000000);

    let ask = book.place_order(
        &lp_a, &w.token_a, &w.token_b,
        &10_000_0000000, &10_000_0000000, &10_000u32,
        &0u32, &0u32, &0u32,
        &soroban_sdk::vec![&w.env, lp_b.clone()],
    );

    // The sibling wallet cannot cross — the market cannot wash itself
    assert!(book
        .try_fill_order(&lp_b, &ask, &10_000_0000000)
        .is_err());
    assert!(book
        .try_partial_fill(&lp_b, &ask, &1_0000000, &1_0000000)
        .is_err());

    // An organic taker fills normally, fee lands in the real vault
    book.fill_order(&w.taker, &ask, &10_000_0000000);
    let fee = fee_ceil(10_000_0000000, 5);
    assert_eq!(
        FeeVaultClient::new(&w.env, &w.vault_id).get_balance(&w.token_b),
        fee
    );
}

// ─── 9. v1.1: match_and_place, one atomic invocation ───

#[test]
fn match_and_place_settles_fills_and_escrow_in_one_invocation() {
    let w = deploy_world(10_000);
    let book = SwapBookClient::new(&w.env, &w.swapbook_id);
    let vault = FeeVaultClient::new(&w.env, &w.vault_id);

    // A counterparty sits 400 B -> 400 A on the reverse side
    let reverse_id = book.place_order(
        &w.taker, &w.token_b, &w.token_a,
        &400_0000000, &400_0000000, &10_000u32,
        &0u32, &0u32, &0u32,
        &soroban_sdk::vec![&w.env],
    );

    // Maker sells 1,000 A: 400 crosses instantly, 600 sits — one tx
    let fills = soroban_sdk::vec![
        &w.env,
        swap_book::FillSpec {
            order_id: reverse_id,
            fill_amount_in: 400_0000000,
            amount_out: 400_0000000,
        },
    ];
    let new_id = book.match_and_place(
        &w.maker, &w.token_a, &w.token_b,
        &1_000_0000000, &600_0000000, &10_000u32,
        &0u32, &0u32, &0u32,
        &soroban_sdk::vec![&w.env], &fills,
    );

    // Fill leg: maker received 400 B whole; counter-maker got 400 A - fee
    let fee = fee_ceil(400_0000000, 5);
    assert_eq!(
        TokenClient::new(&w.env, &w.token_b).balance(&w.maker),
        400_0000000
    );
    assert_eq!(vault.get_balance(&w.token_a), fee);

    // Escrow leg: the 600 A remainder sits as a live, fillable order
    let order = book.get_order(&new_id);
    assert_eq!(order.amount_in_remaining, 600_0000000);
    book.fill_order(&w.taker, &new_id, &600_0000000);
    assert_eq!(book.get_order(&new_id).amount_in_remaining, 0);
    assert_eq!(vault.get_balance(&w.token_b), fee_ceil(600_0000000, 5));
}

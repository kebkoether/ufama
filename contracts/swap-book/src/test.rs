#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Env, IntoVal,
};

fn no_excl(env: &Env) -> Vec<Address> {
    Vec::new(env)
}

struct TestCtx {
    env: Env,
    contract_id: Address,
    #[allow(dead_code)]
    admin: Address,
    fee_vault: Address,
    token_a: Address,
    token_b: Address,
    maker: Address,
    taker: Address,
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 100;
        li.timestamp = 1000;
    });

    let admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let maker = Address::generate(&env);
    let taker = Address::generate(&env);

    let token_a_admin = Address::generate(&env);
    let token_a = env
        .register_stellar_asset_contract_v2(token_a_admin)
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&maker, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_a).mint(&taker, &1_000_000_0000000);

    let token_b_admin = Address::generate(&env);
    let token_b = env
        .register_stellar_asset_contract_v2(token_b_admin)
        .address();
    StellarAssetClient::new(&env, &token_b).mint(&maker, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_b).mint(&taker, &1_000_000_0000000);

    let contract_id = env.register(SwapBook, (admin.clone(), fee_vault.clone()));

    TestCtx {
        env,
        contract_id,
        admin,
        fee_vault,
        token_a,
        token_b,
        maker,
        taker,
    }
}

fn advance_to(env: &Env, seq: u32) {
    env.ledger().with_mut(|li| li.sequence_number = seq);
}

/// ceil(amount * 5 / 100_000) — the default 0.5 bps protocol fee.
fn fee_of(amount: i128) -> i128 {
    (amount * 5 + 100_000 - 1) / 100_000
}

/// Smallest gross payment that nets the maker `net` after the default
/// fee: ceil(net * 100_000 / 99_995).
fn gross_for(net: i128) -> i128 {
    (net * 100_000 + 99_995 - 1) / 99_995
}

/// Place a 1:1 fixed order of `amount` A for B expiring at `expiry`.
fn place_1to1(client: &SwapBookClient<'_>, t: &TestCtx, amount: i128, expiry: u32) -> u64 {
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &amount, &expiry,
        &0, &0, &0, &no_excl(&t.env),
    )
}

// ─── Fixed-Price Order Tests ──────────────────────────

#[test]
fn test_place_order_escrows_tokens() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));
    assert_eq!(order_id, 1);

    let order = client.get_order(&order_id);
    assert_eq!(order.maker, t.maker);
    assert_eq!(order.amount_in_remaining, 10_000_0000000);
    assert_eq!(order.status, OrderStatus::Open);

    let token_a = TokenClient::new(&t.env, &t.token_a);
    assert_eq!(token_a.balance(&t.maker), 1_000_000_0000000 - 10_000_0000000);
    assert_eq!(token_a.balance(&t.contract_id), 10_000_0000000);
}

#[test]
fn test_fill_order_pays_maker_and_fee() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));
    client.fill_order(&t.taker, &order_id, &10_000_0000000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Filled);
    assert_eq!(order.amount_in_remaining, 0);

    let token_a = TokenClient::new(&t.env, &t.token_a);
    let token_b = TokenClient::new(&t.env, &t.token_b);

    assert_eq!(token_a.balance(&t.taker), 1_000_000_0000000 + 10_000_0000000);

    // fee = ceil(10_000_0000000 * 5 / 100_000) = 5_000_000
    let fee = 5_000_000i128;
    assert_eq!(
        token_b.balance(&t.maker),
        1_000_000_0000000 + 10_000_0000000 - fee
    );
    assert_eq!(token_b.balance(&t.fee_vault), fee);
}

#[test]
fn test_partial_fill_and_index_retained() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));
    client.partial_fill(&t.taker, &order_id, &5_000_0000000, &5_000_0000000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::PartialFill);
    assert_eq!(order.amount_in_remaining, 5_000_0000000);
    assert_eq!(client.get_orders(&t.token_a, &t.token_b).len(), 1);
}

#[test]
fn test_partial_fill_underpayment_rejected() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));
    // Exact pro-rata for half = ceil(9_999_5000000 / 2) = 4_999_7500000 —
    // that is what the MAKER must net; the taker sends it plus the fee.
    let net = 4_999_7500000i128;
    let gross = gross_for(net);
    assert!(gross > net);
    // One stroop below the gross floor must be rejected (the maker would
    // net less than their pro-rata minimum once the fee comes out)
    let res = client.try_partial_fill(&t.taker, &order_id, &5_000_0000000, &(gross - 1));
    assert!(res.is_err());
    // The exact gross amount succeeds and the maker nets at least the floor
    let before = TokenClient::new(&t.env, &t.token_b).balance(&t.maker);
    client.partial_fill(&t.taker, &order_id, &5_000_0000000, &gross);
    let received = TokenClient::new(&t.env, &t.token_b).balance(&t.maker) - before;
    assert_eq!(received, gross - fee_of(gross));
    assert!(received >= net);
}

/// L3: the maker's floor is NET of fee — paying exactly the floor is an
/// underpayment, because the fee would come out of the maker's side.
#[test]
fn test_maker_floor_is_net_of_fee() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let amount = 1_000_0000000i128;
    let order_id = place_1to1(&client, &t, amount, 10_000);

    // Gross == floor: maker would net floor - fee → rejected
    assert!(client.try_fill_order(&t.taker, &order_id, &amount).is_err());
    // Gross == floor + fee(gross): maker nets exactly the floor → accepted
    let gross = gross_for(amount);
    let before = TokenClient::new(&t.env, &t.token_b).balance(&t.maker);
    client.fill_order(&t.taker, &order_id, &gross);
    let received = TokenClient::new(&t.env, &t.token_b).balance(&t.maker) - before;
    assert_eq!(received, amount);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.fee_vault),
        gross - amount
    );

    // Fee holiday: the floor and the gross coincide again
    client.set_fee(&0);
    let order2 = place_1to1(&client, &t, amount, 10_000);
    assert!(client.try_fill_order(&t.taker, &order2, &(amount - 1)).is_err());
    client.fill_order(&t.taker, &order2, &amount);
}

#[test]
fn test_dust_fill_cannot_round_to_free() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // Cross-price order: 62,000 A for 1 B (per-unit price ≪ 1).
    // Old floor math let fills below 62,000 stroops round required_out to 0.
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &62_000_0000000, &1_0000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));

    // Paying zero is always rejected
    assert!(client.try_partial_fill(&t.taker, &order_id, &61_999, &0).is_err());
    // A 1-stroop payment is consumed whole by the fee — the maker would
    // net zero, below the 1-stroop floor, so the fill is rejected outright
    assert!(client.try_partial_fill(&t.taker, &order_id, &61_999, &1).is_err());
    // 124,000 A has a 2-stroop floor; 2 gross nets 1 → rejected, 3 nets 2
    assert!(client.try_partial_fill(&t.taker, &order_id, &124_000, &2).is_err());
    client.partial_fill(&t.taker, &order_id, &124_000, &3);
}

#[test]
fn test_cancel_order_refunds() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));
    client.cancel_order(&order_id);

    assert_eq!(client.get_order(&order_id).status, OrderStatus::Cancelled);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.maker),
        1_000_000_0000000
    );
    assert_eq!(client.get_orders(&t.token_a, &t.token_b).len(), 0);
}

#[test]
fn test_cancel_requires_maker_auth() {
    let t = setup();
    // Mock ONLY the taker's auth — maker's require_auth must then fail.
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));

    t.env.set_auths(&[]);
    t.env.mock_auths(&[MockAuth {
        address: &t.taker,
        invoke: &MockAuthInvoke {
            contract: &t.contract_id,
            fn_name: "cancel_order",
            args: (order_id,).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_cancel_order(&order_id).is_err());
}

#[test]
fn test_expire_order_refunds_maker() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &150,
        &0, &0, &0,
    &no_excl(&t.env));

    // Not yet expired
    assert!(client.try_expire_order(&order_id).is_err());

    advance_to(&t.env, 200);
    client.expire_order(&order_id);

    assert_eq!(client.get_order(&order_id).status, OrderStatus::Expired);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.maker),
        1_000_000_0000000
    );
    assert_eq!(client.get_orders(&t.token_a, &t.token_b).len(), 0);
}

#[test]
fn test_fill_expired_order_rejected() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &150,
        &0, &0, &0,
    &no_excl(&t.env));
    advance_to(&t.env, 200);
    assert!(client.try_fill_order(&t.taker, &order_id, &10_000_0000000).is_err());
}

// ─── quote_fill (taker-direction quoting) ─────────────

#[test]
fn test_quote_fill_taker_direction() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // Maker sells 10,000 A, wants >= 9,999.5 B
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &200,
        &0, &0, &0,
    &no_excl(&t.env));

    // Taker pays 5,000 B to buy A
    let (bought, paid) = client.quote_fill(&t.token_a, &t.token_b, &5_000_0000000);
    assert!(paid <= 5_000_0000000);
    assert!(paid > 0);
    // The maker's 0.5 bps discount is exactly offset by the 0.5 bps fee
    // the taker sends on top, so 5,000 B buys exactly 5,000 A (gross
    // quoting: before the fee came out of the maker's side, the same
    // budget "bought" slightly more than 5,000 A).
    assert_eq!(bought, 5_000_0000000);
    assert_eq!(paid, 5_000_0000000);

    // The quote is GROSS: it is fillable as-is, and tight to the stroop
    let order_id = 1u64;
    assert!(client
        .try_partial_fill(&t.taker, &order_id, &bought, &(paid - 1))
        .is_err());
    client.partial_fill(&t.taker, &order_id, &bought, &paid);

    // Empty reverse side quotes zero
    let (bought_rev, paid_rev) = client.quote_fill(&t.token_b, &t.token_a, &5_000_0000000);
    assert_eq!(bought_rev, 0);
    assert_eq!(paid_rev, 0);
}

// ─── Oracle Price Mode ────────────────────────────────

fn setup_oracle(t: &TestCtx) -> (SwapBookClient<'_>, Address) {
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let oracle_admin = Address::generate(&t.env);
    client.set_oracle_admin(&oracle_admin);
    // 1 A = 62,000 B
    client.update_oracle_price(&t.token_a, &t.token_b, &62_000, &1);
    (client, oracle_admin)
}

#[test]
fn test_oracle_order_fill() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &50, &0, // Oracle mode, 50 bps slippage
        &no_excl(&t.env));

    // Fill at oracle fair value (62,000 B for 1 A)
    client.fill_order(&t.taker, &order_id, &62_000_0000000);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Filled);
}

#[test]
fn test_oracle_slippage_exceeded() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &50, &0,
    &no_excl(&t.env));
    // 61,000 is ~1.6% below fair — beyond 50 bps tolerance
    assert!(client.try_fill_order(&t.taker, &order_id, &61_000_0000000).is_err());
}

#[test]
fn test_oracle_price_validation() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let oracle_admin = Address::generate(&t.env);
    client.set_oracle_admin(&oracle_admin);

    // Zero / negative prices rejected
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &0, &1).is_err());
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &62_000, &0).is_err());
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &-62_000, &1).is_err());
}

#[test]
fn test_oracle_jump_capped() {
    let t = setup();
    let (client, _) = setup_oracle(&t); // price = 62,000

    // +19% is allowed
    client.update_oracle_price(&t.token_a, &t.token_b, &73_780, &1);
    // From 73,780, +25% must be rejected (cap is 20%)
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &92_225, &1).is_err());
    // A crash to ~zero must be rejected — this was the rug vector
    assert!(client.try_update_oracle_price(&t.token_a, &t.token_b, &1, &1_000_000).is_err());
}

#[test]
fn test_oracle_stale_price_rejected() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &5_000,
        &1, &50, &0,
    &no_excl(&t.env));

    // Advance past staleness window (1000 ledgers)
    advance_to(&t.env, 100 + 1001 + 1);
    assert!(client.try_fill_order(&t.taker, &order_id, &62_000_0000000).is_err());
}

#[test]
fn test_oracle_slippage_cap_enforced() {
    let t = setup();
    let (client, _) = setup_oracle(&t);

    // > MAX_SLIPPAGE_BPS (1000) rejected
    let res = client.try_place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &1001, &0,
    &no_excl(&t.env));
    assert!(res.is_err());
    // 0 slippage in oracle mode also rejected
    let res = client.try_place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &0, &0,
    &no_excl(&t.env));
    assert!(res.is_err());
}

// ─── Auto-Route Timer ─────────────────────────────────

#[test]
fn test_timer_claim_returns_price_floor() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let router = Address::generate(&t.env);
    client.set_router(&router);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &150,
    &no_excl(&t.env));

    // Before the timer: not claimable
    assert!(client.try_claim_expired_timer(&order_id).is_err());

    advance_to(&t.env, 200);
    assert_eq!(client.get_expired_timer_orders(&t.token_a, &t.token_b).len(), 1);

    let claimed = client.claim_expired_timer(&order_id);
    assert_eq!(claimed.maker, t.maker);
    assert_eq!(claimed.amount, 10_000_0000000);
    // Price floor = full min_amount_out (nothing was filled)
    assert_eq!(claimed.min_out, 9_999_5000000);

    let order = client.get_order(&order_id);
    assert_eq!(order.status, OrderStatus::Routed);
    assert_eq!(order.amount_in_remaining, 0);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&router),
        10_000_0000000
    );
}

#[test]
fn test_timer_claim_no_timer_set() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let router = Address::generate(&t.env);
    client.set_router(&router);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &10_000_0000000, &9_999_5000000, &500,
        &0, &0, &0, // no auto-route
        &no_excl(&t.env));
    advance_to(&t.env, 400);
    assert!(client.try_claim_expired_timer(&order_id).is_err());
}

// ─── v1.1: excluded counterparties ───────────────────────

#[test]
fn test_excluded_counterparty_blocked() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let blocked = Address::generate(&t.env);
    StellarAssetClient::new(&t.env, &t.token_b).mint(&blocked, &1_001_0000000);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_000_0000000, &1_000_0000000, &10_000,
        &0, &0, &0,
        &soroban_sdk::vec![&t.env, blocked.clone()],
    );
    let pay = gross_for(1_000_0000000);

    // The excluded wallet cannot fill — not even partially
    assert!(client.try_fill_order(&blocked, &order_id, &pay).is_err());
    assert!(client
        .try_partial_fill(&blocked, &order_id, &1_0000000, &gross_for(1_0000000))
        .is_err());

    // Anyone else can
    client.fill_order(&t.taker, &order_id, &pay);
    assert_eq!(client.get_order(&order_id).amount_in_remaining, 0);
}

#[test]
fn test_self_fill_rejected() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_000_0000000, &1_000_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    assert!(client
        .try_fill_order(&t.maker, &order_id, &1_000_0000000)
        .is_err());
}

#[test]
fn test_exclusion_list_capped() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let mut too_many = Vec::new(&t.env);
    for _ in 0..6 {
        too_many.push_back(Address::generate(&t.env));
    }
    assert!(client
        .try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &1_000_0000000, &1_000_0000000, &10_000,
            &0, &0, &0, &too_many,
        )
        .is_err());
}

// ─── v1.1: settable fee within compiled cap ──────────────

#[test]
fn test_fee_settable_within_cap() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    assert_eq!(client.get_fee(), (5, 100_000));

    // Fee holiday: taker payment goes entirely to the maker
    client.set_fee(&0);
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_000_0000000, &1_000_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    let maker_b_before = TokenClient::new(&t.env, &t.token_b).balance(&t.maker);
    client.fill_order(&t.taker, &order_id, &1_000_0000000);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.maker),
        maker_b_before + 1_000_0000000
    );
    assert_eq!(TokenClient::new(&t.env, &t.token_b).balance(&t.fee_vault), 0);

    // Restore, and the compiled cap holds
    client.set_fee(&5);
    assert!(client.try_set_fee(&6).is_err());
    assert!(client.try_set_fee(&-1).is_err());
}

// ─── v1.1: match_and_place ───────────────────────────────

#[test]
fn test_match_and_place_fills_and_escrows_atomically() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // Reverse-side maker sells 400 B for 400 A
    let counter = Address::generate(&t.env);
    StellarAssetClient::new(&t.env, &t.token_b).mint(&counter, &1_000_0000000);
    let reverse_id = client.place_order(
        &counter, &t.token_b, &t.token_a,
        &400_0000000, &400_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );

    // Maker wants to sell 1,000 A for B: fill the 400 B order (paying the
    // counter-maker's 400 A floor gross of fee), sit the rest
    let pay = gross_for(400_0000000);
    let fills = soroban_sdk::vec![
        &t.env,
        FillSpec { order_id: reverse_id, fill_amount_in: 400_0000000, amount_out: pay },
    ];
    let new_id = client.match_and_place(
        &t.maker, &t.token_a, &t.token_b,
        &1_000_0000000, &600_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env), &fills,
    );
    assert!(new_id > 0);

    // The fill leg settled: as taker on the reverse order, the maker
    // receives the counter-order's escrow (400 B) in FULL; the 0.5 bps
    // fee comes out of the maker's gross payment, and the counter-maker
    // nets its full 400 A floor.
    let fee = fee_of(pay);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.maker),
        1_000_000_0000000 + 400_0000000
    );
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&counter),
        pay - fee
    );
    assert!(pay - fee >= 400_0000000);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.fee_vault),
        fee
    );
    // The remainder (1,000 A minus the gross payment) sits escrowed
    let order = client.get_order(&new_id);
    assert_eq!(order.amount_in_remaining, 1_000_0000000 - pay);
    assert_eq!(order.min_amount_out, 600_0000000);
    // Reverse order is fully consumed
    assert_eq!(client.get_order(&reverse_id).amount_in_remaining, 0);
}

#[test]
fn test_match_and_place_full_consume_places_nothing() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let counter = Address::generate(&t.env);
    StellarAssetClient::new(&t.env, &t.token_b).mint(&counter, &1_000_0000000);
    let reverse_id = client.place_order(
        &counter, &t.token_b, &t.token_a,
        &500_0000000, &500_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    let pay = gross_for(500_0000000);
    let fills = soroban_sdk::vec![
        &t.env,
        FillSpec { order_id: reverse_id, fill_amount_in: 500_0000000, amount_out: pay },
    ];
    let new_id = client.match_and_place(
        &t.maker, &t.token_a, &t.token_b,
        &pay, &500_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env), &fills,
    );
    assert_eq!(new_id, 0); // nothing left to sit
}

#[test]
fn test_match_and_place_validations() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let counter = Address::generate(&t.env);
    StellarAssetClient::new(&t.env, &t.token_b).mint(&counter, &1_000_0000000);

    // Wrong pair: a same-side order is not a valid match target
    let target = client.place_order(
        &counter, &t.token_b, &t.token_a,
        &100_0000000, &100_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    let wrong = soroban_sdk::vec![
        &t.env,
        FillSpec { order_id: target, fill_amount_in: 1, amount_out: 1 },
    ];
    assert!(client
        .try_match_and_place(
            &t.maker, &t.token_b, &t.token_a, // same direction as target
            &100_0000000, &100_0000000, &10_000,
            &0, &0, &0, &no_excl(&t.env), &wrong,
        )
        .is_err());

    // Budget exceeded: fills cost more than amount_in
    let greedy = soroban_sdk::vec![
        &t.env,
        FillSpec { order_id: target, fill_amount_in: 100_0000000, amount_out: 200_0000000 },
    ];
    assert!(client
        .try_match_and_place(
            &t.maker, &t.token_a, &t.token_b,
            &100_0000000, &100_0000000, &10_000,
            &0, &0, &0, &no_excl(&t.env), &greedy,
        )
        .is_err());
}

// ─── v1.1: SEP-40 oracle precedence ──────────────────────

use soroban_sdk::{contract as sdk_contract, contractimpl as sdk_contractimpl};

#[sdk_contract]
pub struct MockSep40;

#[sdk_contractimpl]
impl MockSep40 {
    pub fn set_price(env: Env, asset: OracleAsset, price: i128, timestamp: u64) {
        env.storage()
            .persistent()
            .set(&asset, &Sep40PriceData { price, timestamp });
    }
    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<Sep40PriceData> {
        env.storage().persistent().get(&asset)
    }
    pub fn decimals(_env: Env) -> u32 {
        14
    }
}

#[test]
fn test_sep40_preferred_over_pushed_price_and_fails_closed() {
    let t = setup();
    let (client, _) = setup_oracle(&t); // pushed price: 62,000 B per A

    // Wire a SEP-40 oracle quoting BOTH tokens (base-USD style):
    // A = $2, B = $1 -> cross rate 2 B per A, overriding the pushed 62,000.
    let sep40_id = t.env.register(MockSep40, ());
    let sep40 = MockSep40Client::new(&t.env, &sep40_id);
    let now = t.env.ledger().timestamp();
    let feed_a = OracleAsset::Stellar(t.token_a.clone());
    let feed_b = OracleAsset::Stellar(t.token_b.clone());
    sep40.set_price(&feed_a, &2_0000000, &now);
    sep40.set_price(&feed_b, &1_0000000, &now);
    client.set_sep40_max_age(&300u64);
    client.set_sep40_feed(&t.token_a, &sep40_id, &feed_a, &0u64);
    client.set_sep40_feed(&t.token_b, &sep40_id, &feed_b, &0u64);

    // Oracle-mode order at 1% slippage: required payment follows SEP-40
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &100_0000000, &0, &10_000,
        &1, &100, &0, &no_excl(&t.env),
    );
    // fair = 100 A * 2 = 200 B; floor = ceil(fair * 99%) = 198 B net,
    // which the taker must send gross of the fee
    let min_pay = gross_for((200_0000000i128 * 9_900 + 10_000 - 1) / 10_000);
    assert!(client.try_fill_order(&t.taker, &order_id, &(min_pay - 1)).is_err());
    client.fill_order(&t.taker, &order_id, &min_pay);

    // Stale SEP-40 price fails CLOSED (no fallback to the pushed price)
    let order2 = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &100_0000000, &0, &10_000,
        &1, &100, &0, &no_excl(&t.env),
    );
    t.env.ledger().with_mut(|li| li.timestamp += 301);
    assert!(client.try_fill_order(&t.taker, &order2, &min_pay).is_err());

    // Removing one feed drops the pair back to the pushed price (62,000)
    client.remove_sep40_feed(&t.token_b);
    let order3 = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &10_000,
        &1, &100, &0, &no_excl(&t.env),
    );
    // fair = 1 A * 62,000 = 62,000 B; floor = ceil(62,000 * 99%), gross of fee
    let pushed_floor = gross_for((62_000_0000000i128 * 9_900 + 10_000 - 1) / 10_000);
    StellarAssetClient::new(&t.env, &t.token_b).mint(&t.taker, &62_000_0000000);
    client.fill_order(&t.taker, &order3, &pushed_floor);
}

// ─── v1.2 hardening ──────────────────────────────────────

/// Token stub with 18 decimals — enough for the read_oracle cross-rate
/// path, which only asks tokens for decimals().
#[sdk_contract]
pub struct MockToken18;

#[sdk_contractimpl]
impl MockToken18 {
    pub fn decimals(_env: Env) -> u32 {
        18
    }
}

#[test]
fn test_sep40_cross_rate_18_decimal_token_fits_i128() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // BTC-priced 18-dec token vs a 7-dec dollar SAC, both on a 14-decimal
    // (Reflector-style) feed: the naive p * 10^(dec+oracle_dec) product
    // needs 10^32 and overflowed i128 before exponent cancellation.
    let token18 = t.env.register(MockToken18, ());
    let sep40_id = t.env.register(MockSep40, ());
    let sep40 = MockSep40Client::new(&t.env, &sep40_id);
    let now = t.env.ledger().timestamp();
    let feed_18 = OracleAsset::Stellar(token18.clone());
    let feed_b = OracleAsset::Stellar(t.token_b.clone());
    sep40.set_price(&feed_18, &7_700_000_000_000_000_000, &now); // $77,000 @14dec
    sep40.set_price(&feed_b, &100_000_000_000_000, &now); // $1 @14dec
    client.set_sep40_max_age(&300u64);
    client.set_sep40_feed(&token18, &sep40_id, &feed_18, &0u64);
    client.set_sep40_feed(&t.token_b, &sep40_id, &feed_b, &0u64);

    let (num, den, _) = client.get_oracle_price(&token18, &t.token_b);
    // 1 whole token18 (1e18 base units) = $77,000 = 7.7e11 token_b units
    assert_eq!(num, 7_700_000_000_000_000_000);
    assert_eq!(den, 10_000_000_000_000_000_000_000_000);

    // Reverse direction exercises the other operand ordering
    let (rnum, rden, _) = client.get_oracle_price(&t.token_b, &token18);
    assert_eq!(rnum, 100_000_000_000_000 * 100_000_000_000);
    assert_eq!(rden, 7_700_000_000_000_000_000);
}

#[test]
fn test_per_feed_max_age_overrides_global() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let sep40_id = t.env.register(MockSep40, ());
    let sep40 = MockSep40Client::new(&t.env, &sep40_id);
    let now = t.env.ledger().timestamp();
    let feed_a = OracleAsset::Stellar(t.token_a.clone());
    let feed_b = OracleAsset::Stellar(t.token_b.clone());
    sep40.set_price(&feed_a, &2_0000000, &now);
    sep40.set_price(&feed_b, &1_0000000, &now);
    client.set_sep40_max_age(&300u64);
    // a: slow-heartbeat feed with its own generous bound; b: global
    client.set_sep40_feed(&t.token_a, &sep40_id, &feed_a, &1000u64);
    client.set_sep40_feed(&t.token_b, &sep40_id, &feed_b, &0u64);

    // Fresh: readable
    client.get_oracle_price(&t.token_a, &t.token_b);

    // 500s later feed a (bound 1000) is fine but b is stale per the
    // global 300 — the pair fails closed.
    t.env.ledger().with_mut(|li| li.timestamp += 500);
    assert!(client.try_get_oracle_price(&t.token_a, &t.token_b).is_err());

    // Widening b's own bound heals the pair without touching the global
    client.set_sep40_feed(&t.token_b, &sep40_id, &feed_b, &1000u64);
    client.get_oracle_price(&t.token_a, &t.token_b);
}

#[test]
fn test_min_order_floor() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    client.set_min_order(&t.token_a, &1_0000000);
    assert!(client
        .try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &9_999_999, &9_999_999, &10_000,
            &0, &0, &0, &no_excl(&t.env),
        )
        .is_err());
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );

    // Clearing the floor re-allows dust
    client.set_min_order(&t.token_a, &0);
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1, &1, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
}

#[test]
fn test_expiry_capped() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let seq = t.env.ledger().sequence();

    assert!(client
        .try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &1_0000000, &1_0000000, &(seq + 1_555_200 + 1),
            &0, &0, &0, &no_excl(&t.env),
        )
        .is_err());
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &(seq + 1_555_200),
        &0, &0, &0, &no_excl(&t.env),
    );
}

#[test]
fn test_claim_expired_timer_rejects_lapsed_order() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let router = Address::generate(&t.env);
    client.set_router(&router);

    // Timer at 150, expiry at 200
    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &100_0000000, &100_0000000, &200,
        &0, &0, &150, &no_excl(&t.env),
    );

    // Past expiry the claim must refuse — refund path only
    advance_to(&t.env, 250);
    assert!(client.try_claim_expired_timer(&order_id).is_err());
    client.expire_order(&order_id);
    assert_eq!(client.get_order(&order_id).status, OrderStatus::Expired);

    // Control: timer expired but order still live claims fine
    let order2 = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &100_0000000, &100_0000000, &1000,
        &0, &0, &300, &no_excl(&t.env),
    );
    advance_to(&t.env, 400);
    let claimed = client.claim_expired_timer(&order2);
    assert_eq!(claimed.amount, 100_0000000);
}

#[test]
fn test_fill_paying_maker_nothing_rejected() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &100_0000000, &100_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    // 1-stroop fill: required payment 1, fee 1 — the maker would net 0
    assert!(client
        .try_partial_fill(&t.taker, &order_id, &1, &1)
        .is_err());
}

#[test]
fn test_admin_two_step_rotation() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    // No pending transfer yet
    assert!(client.try_accept_admin().is_err());

    let new_admin = Address::generate(&t.env);
    client.transfer_admin(&new_admin);
    client.accept_admin();

    // Consumed: a second accept has nothing pending
    assert!(client.try_accept_admin().is_err());

    // The rotated admin can operate (mock auths: flow-level check)
    client.set_fee(&0);
}

// ─── Pre-audit fixes ─────────────────────────────────────

/// M3: a maker may hold at most MAX_OPEN_PER_MAKER_PAIR open orders on a
/// directed pair; closing one frees a slot.
#[test]
fn test_maker_pair_open_order_cap() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let mut ids = Vec::new(&t.env);
    for _ in 0..MAX_OPEN_PER_MAKER_PAIR {
        ids.push_back(place_1to1(&client, &t, 1_0000000, 10_000));
    }
    // The 11th is refused with the dedicated error
    let res = client.try_place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    assert_eq!(res, Err(Ok(SwapBookError::MakerPairLimit)));
    // ...also via match_and_place (shared placement path)
    let res = client.try_match_and_place(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env), &soroban_sdk::vec![&t.env],
    );
    assert_eq!(res, Err(Ok(SwapBookError::MakerPairLimit)));

    // The cap is per directed pair and per maker: the reverse side and
    // another maker are unaffected
    client.place_order(
        &t.maker, &t.token_b, &t.token_a,
        &1_0000000, &1_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );
    client.place_order(
        &t.taker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env),
    );

    // Cancel frees a slot → the 11th now succeeds
    client.cancel_order(&ids.get(0).unwrap());
    let id11 = place_1to1(&client, &t, 1_0000000, 10_000);
    assert!(id11 > 0);
    assert_eq!(
        client
            .try_place_order(
                &t.maker, &t.token_a, &t.token_b,
                &1_0000000, &1_0000000, &10_000,
                &0, &0, &0, &no_excl(&t.env),
            ),
        Err(Ok(SwapBookError::MakerPairLimit))
    );

    // A full fill frees a slot (a partial does not)
    client.partial_fill(&t.taker, &ids.get(1).unwrap(), &5_000_000, &gross_for(5_000_000));
    assert!(client
        .try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &1_0000000, &1_0000000, &10_000,
            &0, &0, &0, &no_excl(&t.env),
        )
        .is_err());
    client.fill_order(&t.taker, &ids.get(1).unwrap(), &gross_for(5_000_000));
    place_1to1(&client, &t, 1_0000000, 10_000);

    // Expiry frees a slot
    advance_to(&t.env, 10_001);
    client.expire_order(&ids.get(2).unwrap());
    place_1to1(&client, &t, 1_0000000, 20_000);

    // Router claim frees a slot
    let router = Address::generate(&t.env);
    client.set_router(&router);
    assert!(client
        .try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &1_0000000, &1_0000000, &20_000,
            &0, &0, &15_000, &no_excl(&t.env),
        )
        .is_err());
    // (free one via expiry first so the timer order fits)
    client.expire_order(&ids.get(3).unwrap());
    let timer_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &20_000,
        &0, &0, &15_000, &no_excl(&t.env),
    );
    advance_to(&t.env, 15_001);
    client.claim_expired_timer(&timer_id);
    place_1to1(&client, &t, 1_0000000, 20_000);
}

/// L1: an order's ledger entry lives at least until its own expiry, not
/// just the generic 30-day window, and stays readable after 30 days.
#[test]
fn test_order_ttl_covers_expiry() {
    use soroban_sdk::testutils::storage::Persistent as _;
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let seq = t.env.ledger().sequence();

    // 90-day order (the maximum expiry)
    let far = seq + 1_555_200;
    let far_id = place_1to1(&client, &t, 1_0000000, far);
    // Short order: generic window
    let near_id = place_1to1(&client, &t, 1_0000000, seq + 200);

    let (ttl_far, ttl_near, ttl_pair, ttl_count) = t.env.as_contract(&t.contract_id, || {
        let p = t.env.storage().persistent();
        (
            p.get_ttl(&DataKey::Order(far_id)),
            p.get_ttl(&DataKey::Order(near_id)),
            p.get_ttl(&DataKey::PairIndex(t.token_a.clone(), t.token_b.clone())),
            p.get_ttl(&DataKey::MakerPairCount(
                t.maker.clone(),
                t.token_a.clone(),
                t.token_b.clone(),
            )),
        )
    });
    assert!(ttl_far >= far - seq, "order TTL {ttl_far} must cover expiry");
    assert!(ttl_far <= MAX_TTL_EXTEND_TO);
    assert_eq!(ttl_near, TTL_EXTEND_TO);
    // The pair index and maker counter share the longest order's horizon
    assert!(ttl_pair >= far - seq);
    assert!(ttl_count >= far - seq);

    // 60 days later (well past the old 30-day window) the long order is
    // still readable and fillable
    advance_to(&t.env, seq + 1_036_800);
    assert_eq!(client.get_order(&far_id).status, OrderStatus::Open);
    client.fill_order(&t.taker, &far_id, &gross_for(1_0000000));
}

/// L1: bump_ttl is permissionless and re-extends an order's entries.
#[test]
fn test_bump_ttl() {
    use soroban_sdk::testutils::storage::Persistent as _;
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    let seq = t.env.ledger().sequence();

    let id = place_1to1(&client, &t, 1_0000000, seq + 200);
    let pair_key = DataKey::PairIndex(t.token_a.clone(), t.token_b.clone());

    // Let most of the window elapse: TTL drops under the refresh threshold
    advance_to(&t.env, seq + 450_000);
    let ttl_before = t
        .env
        .as_contract(&t.contract_id, || t.env.storage().persistent().get_ttl(&pair_key));
    assert!(ttl_before < TTL_THRESHOLD);

    // Anyone (no auth mocked for a specific caller) can bump
    client.bump_ttl(&soroban_sdk::vec![&t.env, id]);
    let (ttl_order, ttl_pair) = t.env.as_contract(&t.contract_id, || {
        let p = t.env.storage().persistent();
        (p.get_ttl(&DataKey::Order(id)), p.get_ttl(&pair_key))
    });
    assert_eq!(ttl_order, TTL_EXTEND_TO);
    assert_eq!(ttl_pair, TTL_EXTEND_TO);

    // Unknown ids are reported, not silently skipped
    assert_eq!(
        client.try_bump_ttl(&soroban_sdk::vec![&t.env, 999u64]),
        Err(Ok(SwapBookError::OrderNotFound))
    );
    // An empty list is a no-op
    client.bump_ttl(&soroban_sdk::vec![&t.env]);
}

/// I4: oracle-mode orders reject a negative min_amount_out.
#[test]
fn test_oracle_order_rejects_negative_min_out() {
    let t = setup();
    let (client, _) = setup_oracle(&t);
    let res = client.try_place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &-1, &500,
        &1, &50, &0, &no_excl(&t.env),
    );
    assert_eq!(res, Err(Ok(SwapBookError::InvalidAmount)));
    // Zero remains fine (oracle mode ignores it)
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &0, &500,
        &1, &50, &0, &no_excl(&t.env),
    );
}

/// I4: a set auto_route_after must be strictly before expiry.
#[test]
fn test_auto_route_after_must_precede_expiry() {
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);
    for timer in [500u32, 501] {
        let res = client.try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &1_0000000, &1_0000000, &500,
            &0, &0, &timer, &no_excl(&t.env),
        );
        assert_eq!(res, Err(Ok(SwapBookError::InvalidAmount)));
    }
    // Timer in the past is still rejected, timer just before expiry is fine
    assert!(client
        .try_place_order(
            &t.maker, &t.token_a, &t.token_b,
            &1_0000000, &1_0000000, &500,
            &0, &0, &100, &no_excl(&t.env),
        )
        .is_err());
    client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_0000000, &1_0000000, &500,
        &0, &0, &499, &no_excl(&t.env),
    );
}

/// M1: get_oracle_price refuses a stale pushed price, so external
/// consumers (RFQ settlement) can never read one.
#[test]
fn test_get_oracle_price_enforces_freshness() {
    let t = setup();
    let (client, _) = setup_oracle(&t);
    let (num, den, at) = client.get_oracle_price(&t.token_a, &t.token_b);
    assert_eq!((num, den, at), (62_000, 1, 100));

    // Last fresh ledger
    advance_to(&t.env, 100 + ORACLE_STALE_LEDGERS);
    client.get_oracle_price(&t.token_a, &t.token_b);
    // One past: stale
    advance_to(&t.env, 100 + ORACLE_STALE_LEDGERS + 1);
    assert_eq!(
        client.try_get_oracle_price(&t.token_a, &t.token_b),
        Err(Ok(SwapBookError::OraclePriceStale))
    );
    // A fresh push heals it
    client.update_oracle_price(&t.token_a, &t.token_b, &62_000, &1);
    client.get_oracle_price(&t.token_a, &t.token_b);
}

/// L5: admin setters that were silent now emit events.
#[test]
fn test_admin_setters_emit_events() {
    use soroban_sdk::testutils::Events as _;
    let t = setup();
    let client = SwapBookClient::new(&t.env, &t.contract_id);

    let oracle_admin = Address::generate(&t.env);
    client.set_oracle_admin(&oracle_admin);
    assert_eq!(
        t.env.events().all(),
        soroban_sdk::vec![
            &t.env,
            (
                t.contract_id.clone(),
                (symbol_short!("oracle"), symbol_short!("admin")).into_val(&t.env),
                oracle_admin.into_val(&t.env)
            )
        ]
    );

    let sep40_id = t.env.register(MockSep40, ());
    let feed_a = OracleAsset::Stellar(t.token_a.clone());
    client.set_sep40_feed(&t.token_a, &sep40_id, &feed_a, &0u64);
    client.remove_sep40_feed(&t.token_a);
    assert_eq!(
        t.env.events().all(),
        soroban_sdk::vec![
            &t.env,
            (
                t.contract_id.clone(),
                (symbol_short!("sep40"), symbol_short!("rm_feed")).into_val(&t.env),
                t.token_a.clone().into_val(&t.env)
            )
        ]
    );
}

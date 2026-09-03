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
    // Exact pro-rata for half = ceil(9_999_5000000 / 2) = 4_999_7500000
    // One stroop below must be rejected.
    let res = client.try_partial_fill(&t.taker, &order_id, &5_000_0000000, &4_999_7499999);
    assert!(res.is_err());
    // Exact amount succeeds
    client.partial_fill(&t.taker, &order_id, &5_000_0000000, &4_999_7500000);
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
    // net zero, so the fill is rejected outright
    assert!(client.try_partial_fill(&t.taker, &order_id, &61_999, &1).is_err());
    // Smallest fill that nets the maker something: 2 stroops (1 fee + 1)
    client.partial_fill(&t.taker, &order_id, &124_000, &2);
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
    // At 0.5 bps under par, 5,000 B buys slightly MORE than 5,000 A
    assert!(bought > 5_000_0000000);
    assert!(bought <= 10_000_0000000);

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
    StellarAssetClient::new(&t.env, &t.token_b).mint(&blocked, &1_000_0000000);

    let order_id = client.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &1_000_0000000, &1_000_0000000, &10_000,
        &0, &0, &0,
        &soroban_sdk::vec![&t.env, blocked.clone()],
    );

    // The excluded wallet cannot fill — not even partially
    assert!(client
        .try_fill_order(&blocked, &order_id, &1_000_0000000)
        .is_err());
    assert!(client
        .try_partial_fill(&blocked, &order_id, &1_0000000, &1_0000000)
        .is_err());

    // Anyone else can
    client.fill_order(&t.taker, &order_id, &1_000_0000000);
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

    // Maker wants to sell 1,000 A for B: fill the 400 B order, sit the rest
    let fills = soroban_sdk::vec![
        &t.env,
        FillSpec { order_id: reverse_id, fill_amount_in: 400_0000000, amount_out: 400_0000000 },
    ];
    let new_id = client.match_and_place(
        &t.maker, &t.token_a, &t.token_b,
        &1_000_0000000, &600_0000000, &10_000,
        &0, &0, &0, &no_excl(&t.env), &fills,
    );
    assert!(new_id > 0);

    // The fill leg settled: as taker on the reverse order, the maker
    // receives the counter-order's escrow (400 B) in FULL; the 0.5 bps
    // fee comes out of the payment to the counter-maker, as on any fill.
    let fee = (400_0000000i128 * 5 + 100_000 - 1) / 100_000;
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.maker),
        1_000_000_0000000 + 400_0000000
    );
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&counter),
        400_0000000 - fee
    );
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.fee_vault),
        fee
    );
    // The remainder (600 A) sits escrowed as the new order
    let order = client.get_order(&new_id);
    assert_eq!(order.amount_in_remaining, 600_0000000);
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
    let fills = soroban_sdk::vec![
        &t.env,
        FillSpec { order_id: reverse_id, fill_amount_in: 500_0000000, amount_out: 500_0000000 },
    ];
    let new_id = client.match_and_place(
        &t.maker, &t.token_a, &t.token_b,
        &500_0000000, &500_0000000, &10_000,
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
    // fair = 100 A * 2 = 200 B; floor = ceil(fair * 99%) = 198 B
    let min_pay = (200_0000000i128 * 9_900 + 10_000 - 1) / 10_000;
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
    // fair = 1 A * 62,000 = 62,000 B; floor = ceil(62,000 * 99%)
    let pushed_floor = (62_000_0000000i128 * 9_900 + 10_000 - 1) / 10_000;
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

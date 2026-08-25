#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Env,
};
use swap_book::{SwapBook, SwapBookClient};

// ─── Mock venue adapter ─────────────────────────────────
// Pays out token_out at a fixed rate (bps of amount_in) from its own balance.
// Mirrors the production adapter interface:
//   swap(recipient, token_in, token_out, amount_in, min_out) -> i128

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
        let rate: i128 = env
            .storage()
            .instance()
            .get(&symbol_short!("rate"))
            .unwrap();
        let out = amount_in * rate / 10_000;
        token::Client::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &recipient,
            &out,
        );
        out
    }
}

// ─── Test setup ─────────────────────────────────────────

struct TestCtx {
    env: Env,
    router_id: Address,
    swapbook_id: Address,
    fee_vault: Address,
    token_a: Address,
    token_b: Address,
    user: Address,
    maker: Address,
}

fn setup(venue_rate_bps: i128) -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 100;
        li.timestamp = 1000;
    });

    let admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let user = Address::generate(&env);
    let maker = Address::generate(&env);

    let token_a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&user, &1_000_000_0000000);
    StellarAssetClient::new(&env, &token_a).mint(&maker, &1_000_000_0000000);

    // SwapBook + Router wired together
    let swapbook_id = env.register(SwapBook, (admin.clone(), fee_vault.clone()));
    let router_id = env.register(
        Router,
        (admin.clone(), fee_vault.clone(), swapbook_id.clone()),
    );
    SwapBookClient::new(&env, &swapbook_id).set_router(&router_id);

    // Mock venue funded with plenty of token_b
    let venue_id = env.register(MockVenue, (venue_rate_bps,));
    StellarAssetClient::new(&env, &token_b).mint(&venue_id, &10_000_000_0000000);
    RouterClient::new(&env, &router_id).register_venue(&1u32, &venue_id);
    // v1.1 defaults the protocol fee to 0; these tests exercise the fee
    // math at the historical 0.5 bps rate.
    RouterClient::new(&env, &router_id).set_fee(&5);

    TestCtx {
        env,
        router_id,
        swapbook_id,
        fee_vault,
        token_a,
        token_b,
        user,
        maker,
    }
}

fn seg(venue_id: u32, amount_in: i128, min_amount_out: i128) -> RouteSegment {
    RouteSegment {
        venue_id,
        amount_in,
        min_amount_out,
    }
}

// ─── execute_route ──────────────────────────────────────

#[test]
fn test_execute_route_fee_on_total() {
    let t = setup(10_000); // 1:1 venue
    let client = RouterClient::new(&t.env, &t.router_id);

    let amount = 10_000_0000000i128;
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, amount)];
    // fee = ceil(1e11 * 5 / 1e5) = 5_000_000
    let expected_net = amount - 5_000_000;

    let received = client.execute_route(
        &t.user, &t.token_a, &t.token_b,
        &amount, &expected_net, &segments,
    );
    assert_eq!(received, expected_net);

    let token_b = TokenClient::new(&t.env, &t.token_b);
    assert_eq!(token_b.balance(&t.user), expected_net);
    assert_eq!(token_b.balance(&t.fee_vault), 5_000_000);
    // Router holds nothing
    assert_eq!(token_b.balance(&t.router_id), 0);
    assert_eq!(TokenClient::new(&t.env, &t.token_a).balance(&t.router_id), 0);
}

#[test]
fn test_execute_route_insufficient_output_reverts() {
    let t = setup(9_000); // venue pays only 90%
    let client = RouterClient::new(&t.env, &t.router_id);

    let amount = 10_000_0000000i128;
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, 0)];
    let res = client.try_execute_route(
        &t.user, &t.token_a, &t.token_b,
        &amount, &(amount - 5_000_000), &segments,
    );
    assert!(res.is_err());
    // Revert means the user kept their funds
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.user),
        1_000_000_0000000
    );
}

#[test]
fn test_execute_route_segment_validation() {
    let t = setup(10_000);
    let client = RouterClient::new(&t.env, &t.router_id);
    let amount = 10_000_0000000i128;

    // Sum mismatch
    let bad_sum = soroban_sdk::vec![&t.env, seg(1, amount / 2, 0)];
    assert!(client
        .try_execute_route(&t.user, &t.token_a, &t.token_b, &amount, &1, &bad_sum)
        .is_err());

    // Non-positive segment amount
    let bad_seg = soroban_sdk::vec![&t.env, seg(1, -1, 0), seg(1, amount + 1, 0)];
    assert!(client
        .try_execute_route(&t.user, &t.token_a, &t.token_b, &amount, &1, &bad_seg)
        .is_err());

    // Unknown venue
    let bad_venue = soroban_sdk::vec![&t.env, seg(99, amount, 0)];
    assert!(client
        .try_execute_route(&t.user, &t.token_a, &t.token_b, &amount, &1, &bad_venue)
        .is_err());
}

// ─── route_expired_order (atomic keeper flow) ───────────

#[test]
fn test_route_expired_order_pays_maker_atomically() {
    let t = setup(10_000); // 1:1 venue
    let router = RouterClient::new(&t.env, &t.router_id);
    let book = SwapBookClient::new(&t.env, &t.swapbook_id);

    // Maker places a timer order: 10,000 A -> min 9,999.5 B, route after ledger 150
    let amount = 10_000_0000000i128;
    let min_out = 9_999_5000000i128;
    let order_id = book.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &min_out, &10_000,
        &0, &0, &150, &soroban_sdk::vec![&t.env]);

    t.env.ledger().with_mut(|li| li.sequence_number = 200);

    let segments = soroban_sdk::vec![&t.env, seg(1, amount, min_out)];
    let maker_received = router.route_expired_order(&order_id, &segments);

    // 1:1 venue → out = 1e11, fee = 5_000_000, net = 9_999_5000000 = exactly min_out
    assert_eq!(maker_received, min_out);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.maker),
        min_out
    );
    assert_eq!(
        TokenClient::new(&t.env, &t.token_b).balance(&t.fee_vault),
        5_000_000
    );
    // Order settled on the book
    let order = book.get_order(&order_id);
    assert_eq!(order.amount_in_remaining, 0);
}

#[test]
fn test_route_expired_order_enforces_maker_floor() {
    let t = setup(9_500); // venue pays 95% — below the maker's floor
    let router = RouterClient::new(&t.env, &t.router_id);
    let book = SwapBookClient::new(&t.env, &t.swapbook_id);

    let amount = 10_000_0000000i128;
    let min_out = 9_999_5000000i128;
    let order_id = book.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &min_out, &10_000,
        &0, &0, &150, &soroban_sdk::vec![&t.env]);
    t.env.ledger().with_mut(|li| li.sequence_number = 200);

    let segments = soroban_sdk::vec![&t.env, seg(1, amount, 0)];
    let res = router.try_route_expired_order(&order_id, &segments);
    assert!(res.is_err());

    // Whole tx reverted: order still open and claimable, escrow intact
    let order = book.get_order(&order_id);
    assert_eq!(order.amount_in_remaining, amount);
    assert_eq!(
        TokenClient::new(&t.env, &t.token_a).balance(&t.swapbook_id),
        amount
    );
}

#[test]
fn test_route_expired_order_timer_not_reached() {
    let t = setup(10_000);
    let router = RouterClient::new(&t.env, &t.router_id);
    let book = SwapBookClient::new(&t.env, &t.swapbook_id);

    let amount = 10_000_0000000i128;
    let order_id = book.place_order(
        &t.maker, &t.token_a, &t.token_b,
        &amount, &9_999_5000000, &10_000,
        &0, &0, &150, &soroban_sdk::vec![&t.env]);
    // Still at ledger 100 — timer hasn't fired
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, 0)];
    assert!(router.try_route_expired_order(&order_id, &segments).is_err());
}

// ─── Venue registry ─────────────────────────────────────

#[test]
fn test_venue_registry() {
    let t = setup(10_000);
    let client = RouterClient::new(&t.env, &t.router_id);

    assert_eq!(client.get_venues().len(), 1);
    assert!(client.try_register_venue(&1u32, &t.router_id).is_err()); // duplicate

    let venue2 = Address::generate(&t.env);
    client.register_venue(&2u32, &venue2);
    assert_eq!(client.get_venue(&2u32), venue2);
    assert_eq!(client.get_venues().len(), 2);

    client.remove_venue(&2u32);
    assert!(client.try_get_venue(&2u32).is_err());
    assert_eq!(client.get_venues().len(), 1);
}

// ─── v1.1: settable fee within compiled cap ──────────────

#[test]
fn test_router_fee_settable_within_cap() {
    let t = setup(10_000); // 1:1 venue
    let client = RouterClient::new(&t.env, &t.router_id);
    assert_eq!(client.get_fee(), (5, 100_000)); // setup() sets 5

    // The v1.1 DEFAULT is zero — a freshly deployed router charges nothing
    let fresh = t.env.register(
        Router,
        (Address::generate(&t.env), t.fee_vault.clone(), t.swapbook_id.clone()),
    );
    assert_eq!(RouterClient::new(&t.env, &fresh).get_fee(), (0, 100_000));

    // Fee holiday: user receives the full venue output
    client.set_fee(&0);
    let amount = 10_000_0000000i128;
    let segments = soroban_sdk::vec![&t.env, seg(1, amount, amount)];
    let received = client.execute_route(
        &t.user, &t.token_a, &t.token_b,
        &amount, &amount, &segments,
    );
    assert_eq!(received, amount);
    assert_eq!(TokenClient::new(&t.env, &t.token_b).balance(&t.fee_vault), 0);

    // Restore; the compiled cap holds
    client.set_fee(&5);
    assert!(client.try_set_fee(&6).is_err());
    assert!(client.try_set_fee(&-1).is_err());
}

// ─── v1.1: integrator partner fee split ──────────────────

#[test]
fn test_partner_fee_split_is_additive() {
    let t = setup(10_000); // 1:1 venue, protocol fee 5/100k from setup
    let client = RouterClient::new(&t.env, &t.router_id);
    let partner = Address::generate(&t.env);

    let amount = 10_000_0000000i128;
    let protocol_fee = (amount * 5 + 100_000 - 1) / 100_000;
    let partner_fee = (amount * 100 + 100_000 - 1) / 100_000; // 10 bps
    let expected_net = amount - protocol_fee - partner_fee;

    let segments = soroban_sdk::vec![&t.env, seg(1, amount, amount)];
    let received = client.execute_route_partner(
        &t.user, &t.token_a, &t.token_b,
        &amount, &expected_net, &segments,
        &partner, &100,
    );
    assert_eq!(received, expected_net);
    // Partner got their cut, protocol got its full fee — additive, not split
    let token_b = TokenClient::new(&t.env, &t.token_b);
    assert_eq!(token_b.balance(&partner), partner_fee);
    assert_eq!(token_b.balance(&t.fee_vault), protocol_fee);
    assert_eq!(token_b.balance(&t.user), expected_net);

    // Cap: >100 bps rejected; user floor protects net of BOTH fees
    assert!(client
        .try_execute_route_partner(
            &t.user, &t.token_a, &t.token_b,
            &amount, &1, &soroban_sdk::vec![&t.env, seg(1, amount, 0)],
            &partner, &1_001,
        )
        .is_err());
    assert!(client
        .try_execute_route_partner(
            &t.user, &t.token_a, &t.token_b,
            &amount, &(expected_net + 1),
            &soroban_sdk::vec![&t.env, seg(1, amount, 0)],
            &partner, &100,
        )
        .is_err());
}


// ─── v1.2: atomic multi-hop (execute_path) ───────────────

#[test]
fn test_execute_path_two_hops_one_invocation() {
    let t = setup(10_000); // venue 1 pays 1:1 in any pair
    let client = RouterClient::new(&t.env, &t.router_id);

    // Third token so we can chain A → B → C
    let token_c = t.env
        .register_stellar_asset_contract_v2(Address::generate(&t.env))
        .address();
    let venue1 = client.get_venue(&1u32);
    StellarAssetClient::new(&t.env, &token_c).mint(&venue1, &10_000_000_0000000);

    let amount = 1_000_0000000i128;
    let hops = soroban_sdk::vec![
        &t.env,
        PathHop {
            token_out: t.token_b.clone(),
            legs: soroban_sdk::vec![&t.env, PathLeg { venue_id: 1, weight_bps: 10_000, min_amount_out: 0 }],
        },
        PathHop {
            token_out: token_c.clone(),
            legs: soroban_sdk::vec![&t.env, PathLeg { venue_id: 1, weight_bps: 10_000, min_amount_out: 0 }],
        },
    ];
    // 1:1 both hops; fee (5/100k from setup) applies ONCE, on the final out
    let fee = (amount * 5 + 100_000 - 1) / 100_000;
    let received = client.execute_path(
        &t.user, &t.token_a, &amount, &(amount - fee), &hops,
    );
    assert_eq!(received, amount - fee);
    assert_eq!(TokenClient::new(&t.env, &token_c).balance(&t.user), amount - fee);
    assert_eq!(TokenClient::new(&t.env, &token_c).balance(&t.fee_vault), fee);
    // Nothing rests on the router — the whole chain settled in one call
    assert_eq!(TokenClient::new(&t.env, &t.token_a).balance(&t.router_id), 0);
    assert_eq!(TokenClient::new(&t.env, &t.token_b).balance(&t.router_id), 0);
    assert_eq!(TokenClient::new(&t.env, &token_c).balance(&t.router_id), 0);
}

#[test]
fn test_execute_path_split_hop_weights() {
    let t = setup(10_000); // venue 1 = 1:1
    let client = RouterClient::new(&t.env, &t.router_id);
    // venue 2 pays 1.01
    let venue2 = t.env.register(MockVenue, (10_100i128,));
    StellarAssetClient::new(&t.env, &t.token_b).mint(&venue2, &10_000_000_0000000);
    client.register_venue(&2u32, &venue2);

    let amount = 1_000_0000000i128;
    // 60% via venue 1 (1:1), 40% via venue 2 (1.01); last leg = remainder
    let hops = soroban_sdk::vec![
        &t.env,
        PathHop {
            token_out: t.token_b.clone(),
            legs: soroban_sdk::vec![
                &t.env,
                PathLeg { venue_id: 1, weight_bps: 6_000, min_amount_out: 0 },
                PathLeg { venue_id: 2, weight_bps: 4_000, min_amount_out: 0 },
            ],
        },
    ];
    let leg1_in = amount * 6_000 / 10_000;
    let leg2_in = amount - leg1_in;
    let expected_out = leg1_in + leg2_in * 10_100 / 10_000;
    let fee = (expected_out * 5 + 100_000 - 1) / 100_000;
    let received = client.execute_path(
        &t.user, &t.token_a, &amount, &(expected_out - fee), &hops,
    );
    assert_eq!(received, expected_out - fee);
}

#[test]
fn test_execute_path_atomic_revert_and_validation() {
    let t = setup(9_500); // venue pays 95% — final min will fail
    let client = RouterClient::new(&t.env, &t.router_id);
    let amount = 1_000_0000000i128;
    let user_before = TokenClient::new(&t.env, &t.token_a).balance(&t.user);

    let hops = soroban_sdk::vec![
        &t.env,
        PathHop {
            token_out: t.token_b.clone(),
            legs: soroban_sdk::vec![&t.env, PathLeg { venue_id: 1, weight_bps: 10_000, min_amount_out: 0 }],
        },
    ];
    // Demand full 1:1 — venue pays 95% — WHOLE path reverts
    assert!(client
        .try_execute_path(&t.user, &t.token_a, &amount, &amount, &hops)
        .is_err());
    assert_eq!(TokenClient::new(&t.env, &t.token_a).balance(&t.user), user_before);

    // Weights must sum to 10,000
    let bad_weights = soroban_sdk::vec![
        &t.env,
        PathHop {
            token_out: t.token_b.clone(),
            legs: soroban_sdk::vec![&t.env, PathLeg { venue_id: 1, weight_bps: 9_999, min_amount_out: 0 }],
        },
    ];
    assert!(client
        .try_execute_path(&t.user, &t.token_a, &amount, &1, &bad_weights)
        .is_err());

    // Hop into the same token is nonsense
    let self_hop = soroban_sdk::vec![
        &t.env,
        PathHop {
            token_out: t.token_a.clone(),
            legs: soroban_sdk::vec![&t.env, PathLeg { venue_id: 1, weight_bps: 10_000, min_amount_out: 0 }],
        },
    ];
    assert!(client
        .try_execute_path(&t.user, &t.token_a, &amount, &1, &self_hop)
        .is_err());
}

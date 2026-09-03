#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl,
    testutils::Address as _,
    token::StellarAssetClient,
    Env,
};

// ─── Mock Sushi factory: one pool registered per (a, b, fee) ────────────

#[sdk_contract]
pub struct MockFactory;

#[sdk_contractimpl]
impl MockFactory {
    pub fn set(env: Env, token_a: Address, token_b: Address, fee: u32, pool: Address) {
        env.storage()
            .persistent()
            .set(&(token_a, token_b, fee), &pool);
    }
    pub fn get_pool(
        env: Env,
        token_a: Address,
        token_b: Address,
        fee: u32,
    ) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&(token_a.clone(), token_b.clone(), fee))
            .or_else(|| env.storage().persistent().get(&(token_b, token_a, fee)))
    }
}

// ─── Mock quoter: returns amount_in * fee (so tests can see which fee
//     tier the adapter resolved) ────────────────────────────────────────

#[sdk_contract]
pub struct MockQuoter;

#[sdk_contractimpl]
impl MockQuoter {
    pub fn quote_exact_input_single(
        _env: Env,
        _token_in: Address,
        _token_out: Address,
        fee: u32,
        amount_in: i128,
        _sqrt_price_limit_x96: soroban_sdk::U256,
    ) -> i128 {
        amount_in * fee as i128
    }
}

struct Ctx {
    env: Env,
    adapter: Address,
    factory: Address,
    token_a: Address,
    token_b: Address,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let router = Address::generate(&env);
    let quoter = env.register(MockQuoter, ());
    let factory = env.register(MockFactory, ());
    let adapter = env.register(
        SushiSwapAdapter,
        (admin, router, quoter, factory.clone()),
    );
    // Real token contracts — the factory fallback reads pool balances
    let token_a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    Ctx { env, adapter, factory, token_a, token_b }
}

fn seed_pool(c: &Ctx, pool: &Address, amount: i128) {
    StellarAssetClient::new(&c.env, &c.token_a).mint(pool, &amount);
    StellarAssetClient::new(&c.env, &c.token_b).mint(pool, &amount);
}

#[test]
fn factory_fallback_resolves_unregistered_pairs() {
    let c = setup();
    let adapter = SushiSwapAdapterClient::new(&c.env, &c.adapter);

    // Nothing registered, nothing in the factory → PairNotSet
    assert!(adapter.try_quote(&c.token_a, &c.token_b, &100).is_err());

    // Factory knows a 3000-tier pool → the adapter finds it with NO
    // admin registration (permissionless pair support)
    let pool = Address::generate(&c.env);
    MockFactoryClient::new(&c.env, &c.factory).set(&c.token_a, &c.token_b, &3000, &pool);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 100 * 3000);
    // Both directions resolve
    assert_eq!(adapter.quote(&c.token_b, &c.token_a, &100), 100 * 3000);
}

#[test]
fn registered_pair_wins_over_factory() {
    let c = setup();
    let adapter = SushiSwapAdapterClient::new(&c.env, &c.adapter);

    // Factory has a 3000 pool, but the admin pins a 500 pool for the pair
    let factory_pool = Address::generate(&c.env);
    MockFactoryClient::new(&c.env, &c.factory).set(&c.token_a, &c.token_b, &3000, &factory_pool);
    let pinned_pool = Address::generate(&c.env);
    adapter.set_pair(&c.token_a, &c.token_b, &500, &pinned_pool);

    // The pinned registration takes precedence (fee 500, not 3000)
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 100 * 500);
}

#[test]
fn factory_fallback_picks_deepest_tier_not_first_probed() {
    let c = setup();
    let adapter = SushiSwapAdapterClient::new(&c.env, &c.adapter);
    let mock = MockFactoryClient::new(&c.env, &c.factory);

    // A shallow pool on the first-probed tier (3000) must not shadow a
    // deep pool on a later tier (500) — an attacker can create the
    // shallow one permissionlessly.
    let shallow = Address::generate(&c.env);
    mock.set(&c.token_a, &c.token_b, &3000, &shallow);
    seed_pool(&c, &shallow, 10);
    let deep = Address::generate(&c.env);
    mock.set(&c.token_a, &c.token_b, &500, &deep);
    seed_pool(&c, &deep, 1_000_000);

    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 100 * 500);

    // One-sided depth doesn't count: draining shallow's token_b side and
    // topping up token_a still loses on the min-side ranking
    StellarAssetClient::new(&c.env, &c.token_a).mint(&shallow, &100_000_000);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 100 * 500);
}

#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl,
    testutils::Address as _,
    symbol_short, Address, BytesN, Env, Map, Vec,
};

// ─── Mock Aqua router: get_pools(tokens) -> Map<hash, pool> ─────────────

#[sdk_contract]
pub struct MockAquaRouter;

#[sdk_contractimpl]
impl MockAquaRouter {
    pub fn add_pool(env: Env, tokens: Vec<Address>, hash: BytesN<32>, pool: Address) {
        let mut m: Map<BytesN<32>, Address> = env
            .storage()
            .persistent()
            .get(&tokens)
            .unwrap_or(Map::new(&env));
        m.set(hash, pool);
        env.storage().persistent().set(&tokens, &m);
    }
    pub fn get_pools(env: Env, tokens: Vec<Address>) -> Map<BytesN<32>, Address> {
        env.storage()
            .persistent()
            .get(&tokens)
            .unwrap_or(Map::new(&env))
    }
}

// ─── Mock Aqua pool: tokens, reserves, estimate ─────────────────────────

#[sdk_contract]
pub struct MockAquaPool;

#[sdk_contractimpl]
impl MockAquaPool {
    pub fn __constructor(env: Env, tokens: Vec<Address>, reserves: Vec<u128>, rate_bps: u128) {
        env.storage().instance().set(&symbol_short!("tokens"), &tokens);
        env.storage().instance().set(&symbol_short!("reserves"), &reserves);
        env.storage().instance().set(&symbol_short!("rate"), &rate_bps);
    }
    pub fn get_tokens(env: Env) -> Vec<Address> {
        env.storage().instance().get(&symbol_short!("tokens")).unwrap()
    }
    pub fn get_reserves(env: Env) -> Vec<u128> {
        env.storage().instance().get(&symbol_short!("reserves")).unwrap()
    }
    pub fn estimate_swap(env: Env, _in_idx: u32, _out_idx: u32, amount: u128) -> u128 {
        let rate: u128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        amount * rate / 10_000
    }
}

struct Ctx {
    env: Env,
    adapter: Address,
    aqua_router: Address,
    token_a: Address,
    token_b: Address,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let aqua_router = env.register(MockAquaRouter, ());
    let adapter = env.register(AquaAdapter, (admin, aqua_router.clone()));
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    Ctx { env, adapter, aqua_router, token_a, token_b }
}

fn hash(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

#[test]
fn resolver_finds_unregistered_pool_via_aqua_router() {
    let c = setup();
    let adapter = AquaAdapterClient::new(&c.env, &c.adapter);

    // No pools anywhere → PoolNotSet
    assert!(adapter.try_quote(&c.token_a, &c.token_b, &100).is_err());

    // Aqua's own router knows a pool → the adapter finds it, no set_pool
    let tokens = soroban_sdk::vec![&c.env, c.token_a.clone(), c.token_b.clone()];
    let pool = c.env.register(
        MockAquaPool,
        (tokens.clone(), soroban_sdk::vec![&c.env, 1000u128, 1000u128], 9_990u128),
    );
    MockAquaRouterClient::new(&c.env, &c.aqua_router).add_pool(&tokens, &hash(&c.env, 1), &pool);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 99);
}

#[test]
fn resolver_prefers_deepest_pool_and_registered_pin_wins() {
    let c = setup();
    let adapter = AquaAdapterClient::new(&c.env, &c.adapter);
    let tokens = soroban_sdk::vec![&c.env, c.token_a.clone(), c.token_b.clone()];
    let router = MockAquaRouterClient::new(&c.env, &c.aqua_router);

    // Shallow pool pays better rate; deep pool pays worse. Resolver picks
    // by output-side DEPTH (liquidity), min_out guards the price.
    let shallow = c.env.register(
        MockAquaPool,
        (tokens.clone(), soroban_sdk::vec![&c.env, 10u128, 10u128], 10_000u128),
    );
    let deep = c.env.register(
        MockAquaPool,
        (tokens.clone(), soroban_sdk::vec![&c.env, 1_000_000u128, 1_000_000u128], 9_900u128),
    );
    router.add_pool(&tokens, &hash(&c.env, 1), &shallow);
    router.add_pool(&tokens, &hash(&c.env, 2), &deep);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 99); // deep pool's 0.99 rate

    // Admin pins the shallow pool → pin overrides the resolver
    adapter.set_pool(
        &c.token_a, &c.token_b,
        &tokens, &hash(&c.env, 1), &shallow,
    );
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &100), 100); // pinned 1:1
}

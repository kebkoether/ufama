#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl, symbol_short,
    testutils::Address as _, token, Address, Env, Map, Symbol, Val, Vec,
};

// ─── Mock Curve factory: pool_count / pool_registration(i) ──────────────
//
// Returns the registration as a Map<Symbol, Val> carrying the same keys
// the real PoolRegistration struct encodes (plus extras), which is what
// the adapter's field-tolerant decoder reads.

#[sdk_contract]
pub struct MockCurveFactory;

#[sdk_contractimpl]
impl MockCurveFactory {
    pub fn add_pool(env: Env, pool: Address, coins: Vec<Address>) {
        let mut list: Vec<(Address, Vec<Address>)> = env
            .storage()
            .instance()
            .get(&symbol_short!("pools"))
            .unwrap_or(Vec::new(&env));
        list.push_back((pool, coins));
        env.storage().instance().set(&symbol_short!("pools"), &list);
    }
    pub fn pool_count(env: Env) -> u32 {
        let list: Vec<(Address, Vec<Address>)> = env
            .storage()
            .instance()
            .get(&symbol_short!("pools"))
            .unwrap_or(Vec::new(&env));
        list.len()
    }
    pub fn pool_registration(env: Env, pool_index: u32) -> Map<Symbol, Val> {
        let list: Vec<(Address, Vec<Address>)> = env
            .storage()
            .instance()
            .get(&symbol_short!("pools"))
            .unwrap();
        let (pool, coins) = list.get(pool_index).unwrap();
        let mut m: Map<Symbol, Val> = Map::new(&env);
        m.set(Symbol::new(&env, "coin_count"), coins.len().into_val(&env));
        m.set(Symbol::new(&env, "coins"), coins.into_val(&env));
        m.set(Symbol::new(&env, "pool"), pool.into_val(&env));
        m.set(Symbol::new(&env, "pool_index"), pool_index.into_val(&env));
        m
    }
}

// ─── Mock Curve pool: get_balances / get_dy / exchange ──────────────────
//
// exchange pulls dx via `coin_i.transfer(caller → pool)` — the real
// pool's mechanism (seen in testnet simulation diagnostics) — and pays
// dy to `receiver`. Rate is a flat bps so tests can assert exact output.

#[sdk_contract]
pub struct MockCurvePool;

#[sdk_contractimpl]
impl MockCurvePool {
    pub fn __constructor(env: Env, coins: Vec<Address>, balances: Vec<i128>, rate_bps: i128) {
        env.storage().instance().set(&symbol_short!("coins"), &coins);
        env.storage().instance().set(&symbol_short!("balances"), &balances);
        env.storage().instance().set(&symbol_short!("rate"), &rate_bps);
    }
    pub fn get_balances(env: Env) -> Vec<i128> {
        env.storage().instance().get(&symbol_short!("balances")).unwrap()
    }
    pub fn get_dy(env: Env, _i: u32, _j: u32, dx: i128) -> i128 {
        let rate: i128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        dx * rate / 10_000
    }
    pub fn exchange(
        env: Env,
        caller: Address,
        i: u32,
        j: u32,
        dx: i128,
        min_dy: i128,
        receiver: Address,
    ) -> i128 {
        caller.require_auth();
        let coins: Vec<Address> = env.storage().instance().get(&symbol_short!("coins")).unwrap();
        let rate: i128 = env.storage().instance().get(&symbol_short!("rate")).unwrap();
        let dy = dx * rate / 10_000;
        assert!(dy >= min_dy, "slippage");
        token::Client::new(&env, &coins.get(i).unwrap()).transfer(
            &caller,
            env.current_contract_address(),
            &dx,
        );
        token::Client::new(&env, &coins.get(j).unwrap()).transfer(
            &env.current_contract_address(),
            &receiver,
            &dy,
        );
        dy
    }
}

struct Ctx {
    env: Env,
    adapter: Address,
    factory: Address,
    token_a: Address,
    token_b: Address,
    token_c: Address,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let factory = env.register(MockCurveFactory, ());
    let adapter = env.register(CurveAdapter, (admin, factory.clone()));
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let token_c = Address::generate(&env);
    Ctx { env, adapter, factory, token_a, token_b, token_c }
}

#[test]
fn resolver_finds_unregistered_pool_via_factory() {
    let c = setup();
    let adapter = CurveAdapterClient::new(&c.env, &c.adapter);

    // Empty registry → PoolNotSet
    assert!(adapter.try_quote(&c.token_a, &c.token_b, &100).is_err());

    // Factory knows a 3-coin pool → the adapter finds it, no set_pool
    let coins = soroban_sdk::vec![&c.env, c.token_a.clone(), c.token_b.clone(), c.token_c.clone()];
    let pool = c.env.register(
        MockCurvePool,
        (coins.clone(), soroban_sdk::vec![&c.env, 1000i128, 1000i128, 1000i128], 9_990i128),
    );
    MockCurveFactoryClient::new(&c.env, &c.factory).add_pool(&pool, &coins);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &1000), 999);
    // any pair inside the 3-pool resolves, in either direction
    assert_eq!(adapter.quote(&c.token_c, &c.token_a, &1000), 999);
    let info = adapter.get_pool_for(&c.token_b, &c.token_c);
    assert_eq!(info.pool_address, pool);
    assert_eq!(info.coins.len(), 3);
}

#[test]
fn resolver_prefers_deepest_min_side_and_pin_wins() {
    let c = setup();
    let adapter = CurveAdapterClient::new(&c.env, &c.adapter);
    let factory = MockCurveFactoryClient::new(&c.env, &c.factory);
    let coins = soroban_sdk::vec![&c.env, c.token_a.clone(), c.token_b.clone()];

    // Skewed pool: a mountain of token_b against dust of token_a, with a
    // better headline rate. Honest pool: deep both sides, worse rate.
    let skewed = c.env.register(
        MockCurvePool,
        (coins.clone(), soroban_sdk::vec![&c.env, 1i128, 1_000_000_000i128], 10_000i128),
    );
    let honest = c.env.register(
        MockCurvePool,
        (coins.clone(), soroban_sdk::vec![&c.env, 1_000_000i128, 1_000_000i128], 9_900i128),
    );
    factory.add_pool(&skewed, &coins);
    factory.add_pool(&honest, &coins);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &1000), 990); // honest wins

    // Admin pin overrides the resolver
    adapter.set_pool(&c.token_a, &c.token_b, &skewed, &coins);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &1000), 1000);
    assert_eq!(adapter.quote(&c.token_b, &c.token_a, &1000), 1000); // both directions

    // Un-pin → resolver again
    adapter.remove_pool(&c.token_a, &c.token_b);
    assert_eq!(adapter.quote(&c.token_a, &c.token_b, &1000), 990);
}

#[test]
fn pool_missing_one_token_is_skipped() {
    let c = setup();
    let adapter = CurveAdapterClient::new(&c.env, &c.adapter);
    let coins = soroban_sdk::vec![&c.env, c.token_a.clone(), c.token_c.clone()];
    let pool = c.env.register(
        MockCurvePool,
        (coins.clone(), soroban_sdk::vec![&c.env, 1000i128, 1000i128], 9_990i128),
    );
    MockCurveFactoryClient::new(&c.env, &c.factory).add_pool(&pool, &coins);
    assert!(adapter.try_quote(&c.token_a, &c.token_b, &100).is_err());
}

#[test]
fn swap_pulls_via_exchange_and_pays_recipient_by_delta() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let factory = env.register(MockCurveFactory, ());
    let adapter = env.register(CurveAdapter, (admin.clone(), factory.clone()));

    // Real SAC tokens so transfers actually move balances
    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let token_b = sac_b.address();
    let coins = soroban_sdk::vec![&env, token_a.clone(), token_b.clone()];
    let pool = env.register(
        MockCurvePool,
        (coins.clone(), soroban_sdk::vec![&env, 1_000_000i128, 1_000_000i128], 9_950i128),
    );
    MockCurveFactoryClient::new(&env, &factory).add_pool(&pool, &coins);

    // Seed: pool holds token_b inventory; the "router" pushed 1000 token_a
    // to the adapter before calling swap (the Router's funds-flow contract).
    token::StellarAssetClient::new(&env, &token_b).mint(&pool, &1_000_000);
    token::StellarAssetClient::new(&env, &token_a).mint(&adapter, &1_000);

    let recipient = Address::generate(&env);
    let out = CurveAdapterClient::new(&env, &adapter).swap(
        &recipient, &token_a, &token_b, &1_000, &990,
    );
    assert_eq!(out, 995);
    assert_eq!(token::Client::new(&env, &token_b).balance(&recipient), 995);
    assert_eq!(token::Client::new(&env, &token_a).balance(&pool), 1_000);
    // nothing stranded on the adapter
    assert_eq!(token::Client::new(&env, &token_a).balance(&adapter), 0);
    assert_eq!(token::Client::new(&env, &token_b).balance(&adapter), 0);
}

#[test]
fn swap_rejects_below_min_out_and_bad_amounts() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let factory = env.register(MockCurveFactory, ());
    let adapter = env.register(CurveAdapter, (admin.clone(), factory.clone()));
    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let token_b = sac_b.address();
    let coins = soroban_sdk::vec![&env, token_a.clone(), token_b.clone()];
    let pool = env.register(
        MockCurvePool,
        (coins.clone(), soroban_sdk::vec![&env, 1_000_000i128, 1_000_000i128], 9_950i128),
    );
    MockCurveFactoryClient::new(&env, &factory).add_pool(&pool, &coins);
    token::StellarAssetClient::new(&env, &token_b).mint(&pool, &1_000_000);
    token::StellarAssetClient::new(&env, &token_a).mint(&adapter, &1_000);

    let client = CurveAdapterClient::new(&env, &adapter);
    let recipient = Address::generate(&env);
    // min_out above what the pool pays → the whole call fails (mock
    // pool asserts; a real pool returns its own slippage error)
    assert!(client.try_swap(&recipient, &token_a, &token_b, &1_000, &996).is_err());
    assert_eq!(client.try_swap(&recipient, &token_a, &token_b, &0, &1).err().unwrap().unwrap(),
        CurveAdapterError::InvalidAmount);
    assert_eq!(client.try_swap(&recipient, &token_a, &token_b, &10, &-1).err().unwrap().unwrap(),
        CurveAdapterError::InvalidAmount);
}

#[test]
fn admin_two_step_rotation() {
    let c = setup();
    let adapter = CurveAdapterClient::new(&c.env, &c.adapter);
    let new_admin = Address::generate(&c.env);
    assert_eq!(adapter.try_accept_admin().err().unwrap().unwrap(), CurveAdapterError::NoPendingAdmin);
    adapter.transfer_admin(&new_admin);
    adapter.accept_admin();
    // new admin can set the factory; a second accept has nothing pending
    let f2 = Address::generate(&c.env);
    adapter.set_factory(&f2);
    assert_eq!(adapter.get_factory(), f2);
    assert_eq!(adapter.try_accept_admin().err().unwrap().unwrap(), CurveAdapterError::NoPendingAdmin);
}

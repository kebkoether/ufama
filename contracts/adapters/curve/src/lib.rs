#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
    IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

/// Curve (StableSwap-NG on Soroban) adapter.
///
/// Interface reverse-read from the testnet 3-coin pool
/// CB6PW7DRUI5GO652L7CRUOOPAZ4IBMWKQ7RCM7SGWFFF5YQKV6PIXFXN (2026-10-15):
///   Pool:    get_dy(i: u32, j: u32, dx: i128) -> i128
///            exchange(caller: Address, i: u32, j: u32, dx: i128, min_dy: i128,
///                     receiver: MuxedAddress) -> i128
///            get_balances() -> Vec<i128>
///   Factory: pool_count() -> u32
///            pool_registration(pool_index: u32) -> PoolRegistration { pool, coins, ... }
///
/// Funds flow (ufama Router → this adapter):
///   The Router PUSHES token_in to this adapter, then invokes `swap`.
///   Curve's `exchange` pulls the input with a nested
///   `token_in.transfer(caller → pool, dx)` — verified from the testnet
///   simulation diagnostics (fn_call transfer [caller, pool, dx]) — so we
///   pre-authorize exactly that sub-invocation, the same way the Aqua
///   adapter does. Output is measured by balance delta and forwarded to
///   `recipient`.
///
/// Pool resolution: an admin-registered pin wins; otherwise the adapter
/// walks the factory registry (bounded) and picks the pool holding both
/// tokens with the deepest MIN-side balance — a skewed attacker pool
/// can't win on one fat side. min_amount_out bounds the outcome either
/// way. Multi-hop composes ABOVE this adapter (Router.execute_path).

// ─── Storage ────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// Curve factory (pool registry) contract address
    Factory,
    /// Registered pool for an unordered pair (stored both directions)
    Pool(Address, Address),
    /// Two-step admin rotation: proposed new admin, pending acceptance.
    PendingAdmin,
}

/// A Curve pool used for a pair.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PoolInfo {
    /// Pool contract address (also its LP token)
    pub pool_address: Address,
    /// The pool's coin list — order defines get_dy / exchange indexes
    pub coins: Vec<Address>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum CurveAdapterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    SwapFailed = 4,
    InvalidAmount = 5,
    PoolNotSet = 6,
    TokenNotInPool = 7,
    Overflow = 8,
    NoPendingAdmin = 9,
}

/// Upper bound on factory registrations inspected per resolve. Curve
/// deploys few pools per chain (one 3-pool on testnet today); 16 keeps
/// resolve cost bounded even if the registry grows.
const MAX_SCAN_POOLS: u32 = 16;

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct CurveAdapter;

#[contractimpl]
impl CurveAdapter {
    /// Deploy-time constructor.
    pub fn __constructor(env: Env, admin: Address, factory: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Factory, &factory);
    }

    /// Pin the pool to use for a pair (both directions). Admin only.
    pub fn set_pool(
        env: Env,
        token_a: Address,
        token_b: Address,
        pool_address: Address,
        coins: Vec<Address>,
    ) -> Result<(), CurveAdapterError> {
        Self::require_admin(&env)?;
        let info = PoolInfo { pool_address, coins };
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token_a.clone(), token_b.clone()), &info);
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token_b, token_a), &info);
        Ok(())
    }

    /// Remove a pin so the factory resolver applies again. Admin only.
    pub fn remove_pool(env: Env, token_a: Address, token_b: Address) -> Result<(), CurveAdapterError> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .remove(&DataKey::Pool(token_a.clone(), token_b.clone()));
        env.storage().persistent().remove(&DataKey::Pool(token_b, token_a));
        Ok(())
    }

    /// Quote a swap via the pool's own get_dy (the venue's math, fees
    /// included — Curve's dynamic off-peg fee is applied inside).
    pub fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, CurveAdapterError> {
        if amount_in <= 0 {
            return Err(CurveAdapterError::InvalidAmount);
        }
        let pool = Self::get_pool(&env, &token_in, &token_out)?;
        let (i, j) = Self::token_indexes(&pool, &token_in, &token_out)?;
        let dy: i128 = env.invoke_contract(
            &pool.pool_address,
            &Symbol::new(&env, "get_dy"),
            soroban_sdk::vec![&env, i.into_val(&env), j.into_val(&env), amount_in.into_val(&env)],
        );
        Ok(dy)
    }

    /// Execute a single-hop swap through a Curve pool.
    ///
    /// Expects `amount_in` of token_in to have been pushed to this contract
    /// by the caller beforehand. Sends the output to `recipient` and returns
    /// the actual amount out.
    pub fn swap(
        env: Env,
        recipient: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, CurveAdapterError> {
        if amount_in <= 0 || min_amount_out < 0 {
            return Err(CurveAdapterError::InvalidAmount);
        }
        let pool = Self::get_pool(&env, &token_in, &token_out)?;
        let (i, j) = Self::token_indexes(&pool, &token_in, &token_out)?;

        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // Curve pulls the input with a nested `transfer(caller → pool)` on
        // the token contract — pre-authorize exactly that sub-invocation.
        // ORDER MATTERS: authorize_as_current_contract applies to the NEXT
        // contract invocation this contract makes — it must sit immediately
        // before the exchange call (a balance() read in between would
        // silently consume it; learned on Aqua mainnet 2026-08-17).
        env.authorize_as_current_contract(soroban_sdk::vec![
            &env,
            soroban_sdk::auth::InvokerContractAuthEntry::Contract(
                soroban_sdk::auth::SubContractInvocation {
                    context: soroban_sdk::auth::ContractContext {
                        contract: token_in.clone(),
                        fn_name: Symbol::new(&env, "transfer"),
                        args: soroban_sdk::vec![
                            &env,
                            env.current_contract_address().into_val(&env),
                            pool.pool_address.clone().into_val(&env),
                            amount_in.into_val(&env),
                        ],
                    },
                    sub_invocations: soroban_sdk::vec![&env],
                }
            ),
        ]);

        // exchange(caller, i, j, dx, min_dy, receiver). `receiver` is a
        // MuxedAddress on the pool side; a plain contract Address decodes
        // into it. We receive here and forward, so output is measured by
        // delta — robust to venue-side rounding.
        let _dy: i128 = env.invoke_contract(
            &pool.pool_address,
            &Symbol::new(&env, "exchange"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                i.into_val(&env),
                j.into_val(&env),
                amount_in.into_val(&env),
                min_amount_out.into_val(&env),
                env.current_contract_address().into_val(&env),
            ],
        );

        let balance_after = token_out_client.balance(&env.current_contract_address());
        let actual_out = balance_after - balance_before;
        if actual_out < min_amount_out {
            return Err(CurveAdapterError::SwapFailed);
        }

        token_out_client.transfer(&env.current_contract_address(), &recipient, &actual_out);

        env.events().publish(
            (symbol_short!("curve"), symbol_short!("swap")),
            (token_in, token_out, amount_in, actual_out),
        );
        Ok(actual_out)
    }

    /// Update the factory address. Admin only.
    pub fn set_factory(env: Env, new_factory: Address) -> Result<(), CurveAdapterError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Factory, &new_factory);
        Ok(())
    }

    pub fn get_factory(env: Env) -> Result<Address, CurveAdapterError> {
        env.storage()
            .instance()
            .get(&DataKey::Factory)
            .ok_or(CurveAdapterError::NotInitialized)
    }

    /// The pool this adapter would use for a pair (pin or resolver).
    pub fn get_pool_for(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Result<PoolInfo, CurveAdapterError> {
        Self::get_pool(&env, &token_in, &token_out)
    }

    /// Propose a new admin (two-step rotation). Admin only.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), CurveAdapterError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("proposed")), new_admin);
        Ok(())
    }

    /// Complete an admin rotation — callable only by the proposed admin.
    pub fn accept_admin(env: Env) -> Result<(), CurveAdapterError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(CurveAdapterError::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("accepted")), pending);
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), CurveAdapterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CurveAdapterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn get_pool(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<PoolInfo, CurveAdapterError> {
        if let Some(info) = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(token_in.clone(), token_out.clone()))
        {
            return Ok(info);
        }
        Self::resolve_pool(env, token_in, token_out)
    }

    /// Walk the factory registry and pick the pool holding both tokens
    /// with the deepest min-side balance.
    ///
    /// The registration record is read as a Map<Symbol, Val> and only the
    /// `pool` and `coins` fields are used, so Curve adding fields to
    /// PoolRegistration later can't break decoding here.
    fn resolve_pool(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<PoolInfo, CurveAdapterError> {
        let factory: Address = env
            .storage()
            .instance()
            .get(&DataKey::Factory)
            .ok_or(CurveAdapterError::NotInitialized)?;

        let count: u32 = env.invoke_contract(
            &factory,
            &Symbol::new(env, "pool_count"),
            soroban_sdk::vec![env],
        );
        let scan = count.min(MAX_SCAN_POOLS);

        let mut best: Option<(i128, PoolInfo)> = None;
        for idx in 0..scan {
            let reg: Map<Symbol, Val> = env.invoke_contract(
                &factory,
                &Symbol::new(env, "pool_registration"),
                soroban_sdk::vec![env, idx.into_val(env)],
            );
            let Some(pool_val) = reg.get(Symbol::new(env, "pool")) else { continue };
            let Some(coins_val) = reg.get(Symbol::new(env, "coins")) else { continue };
            let Ok(pool_addr) = Address::try_from_val(env, &pool_val) else { continue };
            let Ok(coins) = Vec::<Address>::try_from_val(env, &coins_val) else { continue };

            let info = PoolInfo { pool_address: pool_addr, coins };
            let Ok((i, j)) = Self::token_indexes(&info, token_in, token_out) else {
                continue;
            };

            let balances: Vec<i128> = env.invoke_contract(
                &info.pool_address,
                &Symbol::new(env, "get_balances"),
                soroban_sdk::vec![env],
            );
            let side = |k: u32| balances.get(k).unwrap_or(0);
            // Rank by the SHALLOWER side (see module docs).
            let depth = side(i).min(side(j));
            if best.as_ref().map(|(d, _)| depth > *d).unwrap_or(true) {
                best = Some((depth, info));
            }
        }
        best.map(|(_, info)| info).ok_or(CurveAdapterError::PoolNotSet)
    }

    fn token_indexes(
        pool: &PoolInfo,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<(u32, u32), CurveAdapterError> {
        let mut in_idx: Option<u32> = None;
        let mut out_idx: Option<u32> = None;
        for k in 0..pool.coins.len() {
            let t = pool.coins.get(k).unwrap();
            if &t == token_in {
                in_idx = Some(k);
            } else if &t == token_out {
                out_idx = Some(k);
            }
        }
        match (in_idx, out_idx) {
            (Some(a), Some(b)) => Ok((a, b)),
            _ => Err(CurveAdapterError::TokenNotInPool),
        }
    }
}

#[cfg(test)]
mod test;

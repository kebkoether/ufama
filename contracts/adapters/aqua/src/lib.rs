#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

/// Aquarius AMM adapter.
///
/// Real Aquarius interface (docs.aqua.network, AquaToken/soroban-amm):
///   Router (mainnet): CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK
///   swap_chained(user, swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
///                token_in, amount: u128, amount_with_slippage: u128) -> u128
///   Per-pool quoting: estimate_swap(in_idx: u32, out_idx: u32, amount: u128) -> u128
///
/// Pool resolution (v1.2): an admin-registered pool wins (ops can pin a
/// specific pool); otherwise the adapter asks Aqua's own router ON-CHAIN
/// via get_pools(tokens) and picks the pool with the deepest output-side
/// reserves — every pool Aqua has or ever creates is tradeable here
/// permissionlessly, mirroring the Sushi adapter's factory fallback.
/// Safe because the caller's min_amount_out bounds the outcome whichever
/// pool executes. Multi-hop routing composes ABOVE this adapter (the
/// Router's execute_path chains single-hop adapter calls atomically).
///
/// Funds flow (AtomicSwap Router contract → this adapter):
///   The router PUSHES token_in to this adapter before invoking `swap`.
///   This adapter then approves the Aqua router and calls swap_chained.
///   NOTE: verify on testnet whether Aqua pulls via allowance
///   (transfer_from) or requires explicit sub-invocation auth
///   (authorize_as_current_contract) — adjust if the latter.

// ─── Storage ────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// The Aqua AMM router contract address
    AquaRouter,
    /// Registered pool for a directed pair (token_in, token_out)
    Pool(Address, Address),
}

/// An Aquarius pool used for a pair.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PoolInfo {
    /// The pool's token list (order defines estimate_swap indexes)
    pub tokens: Vec<Address>,
    /// Pool hash as used in swap_chained's swaps_chain
    pub pool_hash: BytesN<32>,
    /// Pool contract address (for estimate_swap quoting)
    pub pool_address: Address,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum AquaAdapterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    SwapFailed = 4,
    InvalidAmount = 5,
    PoolNotSet = 6,
    TokenNotInPool = 7,
    Overflow = 8,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct AquaAdapter;

#[contractimpl]
impl AquaAdapter {
    /// Deploy-time constructor.
    pub fn __constructor(env: Env, admin: Address, aqua_router: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::AquaRouter, &aqua_router);
    }

    /// Register the pool to use for a pair (both directions). Admin only.
    pub fn set_pool(
        env: Env,
        token_a: Address,
        token_b: Address,
        tokens: Vec<Address>,
        pool_hash: BytesN<32>,
        pool_address: Address,
    ) -> Result<(), AquaAdapterError> {
        Self::require_admin(&env)?;
        let info = PoolInfo {
            tokens,
            pool_hash,
            pool_address,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token_a.clone(), token_b.clone()), &info);
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token_b, token_a), &info);
        Ok(())
    }

    /// Quote a swap via the registered pool's estimate_swap.
    pub fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, AquaAdapterError> {
        if amount_in <= 0 {
            return Err(AquaAdapterError::InvalidAmount);
        }
        let pool = Self::get_pool(&env, &token_in, &token_out)?;
        let (in_idx, out_idx) = Self::token_indexes(&pool, &token_in, &token_out)?;

        let estimated: u128 = env.invoke_contract(
            &pool.pool_address,
            &Symbol::new(&env, "estimate_swap"),
            soroban_sdk::vec![
                &env,
                in_idx.into_val(&env),
                out_idx.into_val(&env),
                (amount_in as u128).into_val(&env),
            ],
        );

        i128::try_from(estimated).map_err(|_| AquaAdapterError::Overflow)
    }

    /// Execute a single-hop swap through Aquarius.
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
    ) -> Result<i128, AquaAdapterError> {
        if amount_in <= 0 || min_amount_out < 0 {
            return Err(AquaAdapterError::InvalidAmount);
        }

        let aqua_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::AquaRouter)
            .ok_or(AquaAdapterError::NotInitialized)?;
        let pool = Self::get_pool(&env, &token_in, &token_out)?;

        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // Aqua's router pulls funds via a nested `transfer(adapter → router)`
        // on the token contract — NOT via allowance — so we pre-authorize
        // exactly that sub-invocation. (Verified on mainnet 2026-08-17: the
        // SAC rejects the pull with Error(Auth, InvalidAction) otherwise.)
        //
        // ORDER MATTERS: authorize_as_current_contract applies to the NEXT
        // contract invocation this contract makes — it must sit immediately
        // before the swap_chained call. (A balance() read between them
        // silently consumed the authorization — also found on mainnet.)
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
                            aqua_router.clone().into_val(&env),
                            amount_in.into_val(&env),
                        ],
                    },
                    sub_invocations: soroban_sdk::vec![&env],
                }
            ),
        ]);

        // swaps_chain: single hop through the registered pool
        let chain_element = (pool.tokens.clone(), pool.pool_hash.clone(), token_out.clone());
        let swaps_chain = soroban_sdk::vec![&env, chain_element];

        let _out: u128 = env.invoke_contract(
            &aqua_router,
            &Symbol::new(&env, "swap_chained"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                swaps_chain.into_val(&env),
                token_in.clone().into_val(&env),
                (amount_in as u128).into_val(&env),
                (min_amount_out as u128).into_val(&env),
            ],
        );

        // Measure by balance delta — robust to venue-side rounding
        let balance_after = token_out_client.balance(&env.current_contract_address());
        let actual_out = balance_after - balance_before;

        if actual_out < min_amount_out {
            return Err(AquaAdapterError::SwapFailed);
        }

        token_out_client.transfer(&env.current_contract_address(), &recipient, &actual_out);

        env.events().publish(
            (symbol_short!("aqua"), symbol_short!("swap")),
            (token_in, token_out, amount_in, actual_out),
        );
        Ok(actual_out)
    }

    /// Update the Aqua router address. Admin only.
    pub fn set_aqua_router(env: Env, new_router: Address) -> Result<(), AquaAdapterError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::AquaRouter, &new_router);
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), AquaAdapterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(AquaAdapterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn get_pool(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<PoolInfo, AquaAdapterError> {
        if let Some(info) = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(token_in.clone(), token_out.clone()))
        {
            return Ok(info);
        }
        Self::resolve_pool(env, token_in, token_out)
    }

    /// Ask Aqua's router for the pair's pools and pick the one with the
    /// deepest output-side reserves. Bounded to the first few pools per
    /// pair (Aqua rarely has more than 2-3 per pair).
    fn resolve_pool(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<PoolInfo, AquaAdapterError> {
        let aqua_router: Address = env
            .storage()
            .instance()
            .get(&DataKey::AquaRouter)
            .ok_or(AquaAdapterError::NotInitialized)?;

        // Aqua keys pools by its own token ordering — try both
        let orders = [
            soroban_sdk::vec![env, token_in.clone(), token_out.clone()],
            soroban_sdk::vec![env, token_out.clone(), token_in.clone()],
        ];
        let mut best: Option<(i128, PoolInfo)> = None;
        for tokens_arg in orders.iter() {
            let pools: soroban_sdk::Map<BytesN<32>, Address> = env.invoke_contract(
                &aqua_router,
                &Symbol::new(env, "get_pools"),
                soroban_sdk::vec![env, tokens_arg.into_val(env)],
            );
            for (inspected, (hash, pool_addr)) in (0_u32..).zip(pools.iter()) {
                if inspected >= 4 {
                    break;
                }
                let tokens: soroban_sdk::Vec<Address> = env.invoke_contract(
                    &pool_addr,
                    &Symbol::new(env, "get_tokens"),
                    soroban_sdk::vec![env],
                );
                // both sides must be in the pool
                let mut out_idx: Option<u32> = None;
                let mut has_in = false;
                for k in 0..tokens.len() {
                    let t = tokens.get(k).unwrap();
                    if &t == token_in {
                        has_in = true;
                    } else if &t == token_out {
                        out_idx = Some(k);
                    }
                }
                let Some(out_idx) = out_idx else { continue };
                if !has_in {
                    continue;
                }
                let reserves: soroban_sdk::Vec<u128> = env.invoke_contract(
                    &pool_addr,
                    &Symbol::new(env, "get_reserves"),
                    soroban_sdk::vec![env],
                );
                let depth = reserves
                    .get(out_idx)
                    .map(|r| i128::try_from(r).unwrap_or(i128::MAX))
                    .unwrap_or(0);
                if best.as_ref().map(|(d, _)| depth > *d).unwrap_or(true) {
                    best = Some((
                        depth,
                        PoolInfo {
                            tokens: tokens.clone(),
                            pool_hash: hash.clone(),
                            pool_address: pool_addr.clone(),
                        },
                    ));
                }
            }
            if best.is_some() {
                break; // first ordering that yields pools is Aqua's canonical one
            }
        }
        best.map(|(_, info)| info).ok_or(AquaAdapterError::PoolNotSet)
    }

    fn token_indexes(
        pool: &PoolInfo,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<(u32, u32), AquaAdapterError> {
        let mut in_idx: Option<u32> = None;
        let mut out_idx: Option<u32> = None;
        for i in 0..pool.tokens.len() {
            let t = pool.tokens.get(i).unwrap();
            if &t == token_in {
                in_idx = Some(i);
            } else if &t == token_out {
                out_idx = Some(i);
            }
        }
        match (in_idx, out_idx) {
            (Some(a), Some(b)) => Ok((a, b)),
            _ => Err(AquaAdapterError::TokenNotInPool),
        }
    }
}

#[cfg(test)]
mod test;

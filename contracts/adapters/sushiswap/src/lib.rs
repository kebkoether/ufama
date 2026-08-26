#![no_std]

//! SushiSwap V3 (Stellar) adapter — REAL ABI.
//!
//! Contract addresses + interface reverse-engineered from sushi.com's own
//! frontend and verified via on-chain interface fetch (2026-08-18):
//!   Router  CDMIM23WOUL5CZBKX3GOA3V5R5AMVIMTCP52KCDQORWELAPLJ27WZCHL
//!   Quoter  CASKWJSINHFW7BF7RUOA4E2FP6B2TYRKFX2UOPWLCPOOPUR6UU3G2RWC
//!   Factory CD3KRKGDRVWPXVB3VXLUMQKMX6XZ6Q2H334IVZD4XXNAMKSRVQL5GLYF
//!
//! CAUTION: Sushi runs TWO factories on mainnet. CCRSMJDITH…GZGF is an
//! older deployment whose pools are stale — the v1.1 adapter shipped
//! pointing at it, which broke unpinned pair resolution (worked around
//! with set_pair pins, scripts/register-sushi-pairs.sh). Deploys must
//! use CD3KRKGD…GLYF, verified 2026-08-25 to resolve the same pools
//! Sushi's own UI trades.
//!
//! Router entry: swap_exact_input_single(params: ExactInputSingleParams)
//! Quoter entry: quote_exact_input_single(token_in, token_out, fee: u32,
//!               amount_in: i128, sqrt_price_limit_x96: U256) -> i128
//!
//! V3 pools are (token_a, token_b, fee_tier) triples — the fee tier is an
//! admin-registered pair attribute here (like the Aqua pool registry).
//!
//! Funds flow: the AtomicSwap Router/TwapBook PUSHES token_in here first;
//! this adapter pre-authorizes the venue's nested pull and pushes the
//! output back to the caller.

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, Env, IntoVal, Symbol, U256,
};

// ─── Storage ────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    SushiRouter,
    SushiQuoter,
    /// Registered (fee tier, pool address) for a directed pair
    Pair(Address, Address),
    /// Sushi factory — enables permissionless pair resolution: pairs the
    /// admin never registered fall back to factory.get_pool lookups.
    SushiFactory,
}

/// Fee tiers probed (most liquid first) when resolving a pair through the
/// factory. Mirrors Uniswap-V3 canonical tiers as deployed by Sushi.
const FACTORY_FEE_TIERS: [u32; 4] = [3000, 500, 10_000, 100];

#[contracttype]
#[derive(Clone, Debug)]
pub struct PairInfo {
    pub fee: u32,
    pub pool: Address,
}

/// Mirror of the pool's OracleHints — field names must match exactly
/// (contracttype structs encode as maps keyed by field name).
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleHints {
    pub checkpoint: u32,
    pub checkpoint_min: u32,
    pub slot: u128,
}

/// Uniswap-V3 sqrt price bounds (Sushi's Stellar port keeps the constants).
/// zero_for_one swaps push price DOWN toward MIN; the opposite toward MAX.
const MIN_SQRT_RATIO_PLUS_1: u128 = 4295128740;
// MAX_SQRT_RATIO - 1 = 0xFFFD8963EFD1FC6A506488495D951D5263988D25 (160 bits)
const MAX_SQRT_LIMB1: u64 = 0x00000000FFFD8963;
const MAX_SQRT_LIMB2: u64 = 0xEFD1FC6A50648849;
const MAX_SQRT_LIMB3: u64 = 0x5D951D5263988D25;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SushiAdapterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    SwapFailed = 4,
    InvalidAmount = 5,
    PairNotSet = 6,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct SushiSwapAdapter;

#[contractimpl]
impl SushiSwapAdapter {
    /// Deploy-time constructor.
    pub fn __constructor(
        env: Env,
        admin: Address,
        sushi_router: Address,
        sushi_quoter: Address,
        sushi_factory: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SushiRouter, &sushi_router);
        env.storage().instance().set(&DataKey::SushiQuoter, &sushi_quoter);
        env.storage().instance().set(&DataKey::SushiFactory, &sushi_factory);
    }

    /// Update the factory address. Admin only.
    pub fn set_factory(env: Env, sushi_factory: Address) -> Result<(), SushiAdapterError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::SushiFactory, &sushi_factory);
        Ok(())
    }

    /// Register the pool (fee tier + pool contract) for a pair, both
    /// directions. Admin only. Pool address is needed to pre-authorize the
    /// venue's nested fund pull wherever it lands (router or pool).
    pub fn set_pair(
        env: Env,
        token_a: Address,
        token_b: Address,
        fee: u32,
        pool: Address,
    ) -> Result<(), SushiAdapterError> {
        Self::require_admin(&env)?;
        let info = PairInfo { fee, pool };
        env.storage()
            .persistent()
            .set(&DataKey::Pair(token_a.clone(), token_b.clone()), &info);
        env.storage()
            .persistent()
            .set(&DataKey::Pair(token_b, token_a), &info);
        Ok(())
    }

    /// Quote via the Sushi quoter/lens contract.
    pub fn quote(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, SushiAdapterError> {
        if amount_in <= 0 {
            return Err(SushiAdapterError::InvalidAmount);
        }
        let quoter: Address = env
            .storage()
            .instance()
            .get(&DataKey::SushiQuoter)
            .ok_or(SushiAdapterError::NotInitialized)?;
        let pair = Self::get_pair(&env, &token_in, &token_out)?;

        let out: i128 = env.invoke_contract(
            &quoter,
            &Symbol::new(&env, "quote_exact_input_single"),
            soroban_sdk::vec![
                &env,
                token_in.into_val(&env),
                token_out.into_val(&env),
                pair.fee.into_val(&env),
                amount_in.into_val(&env),
                U256::from_u32(&env, 0).into_val(&env),
            ],
        );
        Ok(out)
    }

    /// Execute a swap through SushiSwap V3.
    ///
    /// Expects `amount_in` of token_in pushed to this contract beforehand.
    pub fn swap(
        env: Env,
        recipient: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
    ) -> Result<i128, SushiAdapterError> {
        if amount_in <= 0 || min_amount_out < 0 {
            return Err(SushiAdapterError::InvalidAmount);
        }
        let pair = Self::get_pair(&env, &token_in, &token_out)?;
        let pool = pair.pool.clone();

        // We call the POOL directly via its prefunded entry point rather
        // than Sushi's router: the router path requires an auth entry
        // containing dynamic oracle-hint state that no contract can
        // pre-authorize (verified on mainnet 2026-08-18). As the pool's
        // DIRECT invoker, our own require_auth passes via invoker auth,
        // and prefunding removes the nested pull entirely.
        let token0: Address = env.invoke_contract(
            &pool,
            &Symbol::new(&env, "token0"),
            soroban_sdk::vec![&env],
        );
        let zero_for_one = token_in == token0;
        let hints: OracleHints = env.invoke_contract(
            &pool,
            &Symbol::new(&env, "get_oracle_hints"),
            soroban_sdk::vec![&env],
        );
        let sqrt_limit = if zero_for_one {
            U256::from_u128(&env, MIN_SQRT_RATIO_PLUS_1)
        } else {
            U256::from_parts(&env, 0, MAX_SQRT_LIMB1, MAX_SQRT_LIMB2, MAX_SQRT_LIMB3)
        };

        let token_out_client = token::Client::new(&env, &token_out);
        let balance_before = token_out_client.balance(&env.current_contract_address());

        // Direct pool.swap: the pool's require_auth(sender=this contract)
        // passes via invoker auth since we are the DIRECT caller, and the
        // pool's nested pull is a deterministic transfer(this → pool,
        // amount) we can pre-authorize. (swap_prefunded is gated to
        // factory-authorized routers; the Sushi-router path needs an auth
        // context with dynamic oracle-hint state no contract can predict —
        // both verified on mainnet 2026-08-18.)
        // NOTE: the authorization is consumed by the NEXT cross-contract
        // call — it must sit immediately before the swap invocation.
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
                            pool.clone().into_val(&env),
                            amount_in.into_val(&env),
                        ],
                    },
                    sub_invocations: soroban_sdk::vec![&env],
                }
            ),
        ]);

        // swap(sender, recipient, zero_for_one, amount_specified,
        //      sqrt_price_limit_x96, hints) -> SwapResult
        let _result: soroban_sdk::Val = env.invoke_contract(
            &pool,
            &Symbol::new(&env, "swap"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                env.current_contract_address().into_val(&env),
                zero_for_one.into_val(&env),
                amount_in.into_val(&env),
                sqrt_limit.into_val(&env),
                hints.into_val(&env),
            ],
        );

        // Measure by balance delta — robust to venue-side rounding
        let balance_after = token_out_client.balance(&env.current_contract_address());
        let actual_out = balance_after - balance_before;
        if actual_out < min_amount_out {
            return Err(SushiAdapterError::SwapFailed);
        }

        token_out_client.transfer(&env.current_contract_address(), &recipient, &actual_out);

        env.events().publish(
            (symbol_short!("sushi"), symbol_short!("swap")),
            (token_in, token_out, amount_in, actual_out),
        );
        Ok(actual_out)
    }

    /// Update venue contract addresses. Admin only.
    pub fn set_contracts(
        env: Env,
        sushi_router: Address,
        sushi_quoter: Address,
    ) -> Result<(), SushiAdapterError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::SushiRouter, &sushi_router);
        env.storage().instance().set(&DataKey::SushiQuoter, &sushi_quoter);
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), SushiAdapterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SushiAdapterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Resolve the pool for a pair: an admin-registered entry wins (lets
    /// ops pin a specific pool); otherwise ask the Sushi factory across
    /// the canonical fee tiers — so every pool Sushi creates is tradeable
    /// here PERMISSIONLESSLY, no per-pair admin action. Safe because the
    /// caller's min_amount_out bounds the outcome regardless of which
    /// pool executes.
    fn get_pair(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<PairInfo, SushiAdapterError> {
        if let Some(info) = env
            .storage()
            .persistent()
            .get(&DataKey::Pair(token_in.clone(), token_out.clone()))
        {
            return Ok(info);
        }
        let factory: Address = env
            .storage()
            .instance()
            .get(&DataKey::SushiFactory)
            .ok_or(SushiAdapterError::PairNotSet)?;
        for fee in FACTORY_FEE_TIERS {
            let pool: Option<Address> = env.invoke_contract(
                &factory,
                &Symbol::new(env, "get_pool"),
                soroban_sdk::vec![
                    env,
                    token_in.into_val(env),
                    token_out.into_val(env),
                    fee.into_val(env),
                ],
            );
            if let Some(pool) = pool {
                return Ok(PairInfo { fee, pool });
            }
        }
        Err(SushiAdapterError::PairNotSet)
    }
}

#[cfg(test)]
mod test;

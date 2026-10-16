#![no_std]

//! RFQ settlement — atomic delivery-versus-payment of a firm quote.
//!
//! A maker answers a taker's request with a `Quote` and PRE-SIGNS the
//! Soroban authorization entry for exactly one `settle_quote(quote)`
//! invocation. The taker accepts by submitting that invocation with the
//! maker's signed entry attached. Both legs move in one transaction or
//! nothing moves. There is no escrow and this contract never holds funds.
//!
//! Replay safety comes from two layers: the host consumes the maker's
//! auth-entry nonce natively, and the contract records (maker, nonce) in
//! temporary storage until the quote's expiry so a maker-initiated
//! settlement (where the maker is the transaction source and has no
//! host nonce) cannot be replayed either.
//!
//! "At NAV" is enforced on-chain, not just displayed: when the quote
//! carries `max_nav_dev_bps > 0` the contract reads the pair's oracle
//! price from the SwapBook (same SEP-40 feeds that price oracle-pegged
//! standing orders) and refuses to settle outside the band, in either
//! direction — protecting the taker from a wide quote and the maker from
//! a fat-fingered one.
//!
//! Fee: the same 0.5 bps the SwapBook charges, taken from the taker's
//! payment leg and sent to the FeeVault. Admin-settable, hard-capped.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    vec, Address, Env, IntoVal, Symbol, I256,
};

/// Protocol fee per 100,000 of the taker's payment (0.5 bps), capped.
const MAX_FEE_PER_100K: i128 = 5;
const DEFAULT_FEE_PER_100K: i128 = 5;
const FEE_DENOMINATOR: i128 = 100_000;
const BPS_DENOMINATOR: i128 = 10_000;

/// A quote may not be valid for longer than this (~7 days at 5s/ledger).
/// Bounds the lifetime of the replay record.
const MAX_QUOTE_TTL_LEDGERS: u32 = 120_960;

/// Widest NAV band a quote may request (10%). Beyond that the band is
/// meaningless; quotes that want no band pass 0.
const MAX_NAV_BAND_BPS: u32 = 1_000;

/// Instance storage TTL management (ledgers).
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    FeeVault,
    /// SwapBook contract whose `get_oracle_price` supplies NAV.
    SwapBook,
    FeePer100k,
    /// Replay record for a settled (maker, nonce). Temporary storage,
    /// lives until the quote's expiry ledger.
    Used(Address, u64),
}

/// A firm quote, from the TAKER's perspective: the taker pays
/// `amount_in` of `token_in` and receives `amount_out` of `token_out`
/// from the maker.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub maker: Address,
    pub taker: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    /// Last ledger (inclusive) at which this quote may settle.
    pub expiry_ledger: u32,
    /// Maker-chosen unique id; (maker, nonce) settles at most once.
    pub nonce: u64,
    /// Max deviation from the oracle (NAV) price, in bps, either
    /// direction. 0 = no oracle check (pairs without a feed).
    pub max_nav_dev_bps: u32,
}

/// Result of `check_quote` — the exact on-chain view of a quote.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct QuoteCheck {
    /// Oracle fair value of `amount_in` in `token_out` base units
    /// (0 when the quote carries no NAV band).
    pub fair_out: i128,
    /// Signed deviation in bps: positive = taker receives LESS than NAV.
    pub deviation_bps: i128,
    pub fee: i128,
    pub maker_receives: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RfqError {
    NotInitialized = 1,
    Unauthorized = 2,
    InvalidAmount = 3,
    SameToken = 4,
    SameParty = 5,
    Expired = 6,
    ExpiryTooFar = 7,
    AlreadyUsed = 8,
    NavBandTooWide = 9,
    NavBandExceeded = 10,
    OracleUnavailable = 11,
    FeeAboveCap = 12,
    Overflow = 13,
    NoPendingAdmin = 14,
}

#[contract]
pub struct RfqSettle;

#[contractimpl]
impl RfqSettle {
    /// Deploy-time constructor — atomic with deployment.
    pub fn __constructor(env: Env, admin: Address, fee_vault: Address, swap_book: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeVault, &fee_vault);
        env.storage().instance().set(&DataKey::SwapBook, &swap_book);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    // ─── Settlement ─────────────────────────────────────

    /// Settle a firm quote. Requires auth from BOTH parties: the taker
    /// (normally the transaction source) and the maker (normally a
    /// pre-signed authorization entry carried in the transaction).
    /// Returns the protocol fee charged.
    pub fn settle_quote(env: Env, q: Quote) -> Result<i128, RfqError> {
        // Shape checks first: a self-quote would otherwise hit the host's
        // duplicate-auth rule (same address, same frame) before our error.
        Self::validate(&env, &q)?;
        q.taker.require_auth();
        q.maker.require_auth();

        // Replay record — the host already consumes the maker's auth
        // nonce; this covers maker-as-source settlements too and gives
        // `is_used` a definitive answer either way.
        let used_key = DataKey::Used(q.maker.clone(), q.nonce);
        if env.storage().temporary().has(&used_key) {
            return Err(RfqError::AlreadyUsed);
        }
        let ttl = q.expiry_ledger - env.ledger().sequence() + 1;
        env.storage().temporary().set(&used_key, &true);
        env.storage().temporary().extend_ttl(&used_key, ttl, ttl);

        let (fair_out, _) = Self::nav_check(&env, &q)?;

        let fee = Self::calculate_fee(&env, q.amount_in);
        let maker_receives = q.amount_in - fee;
        if maker_receives <= 0 {
            return Err(RfqError::InvalidAmount);
        }

        // Taker's leg: payment to the maker, fee to the vault.
        let token_in = token::Client::new(&env, &q.token_in);
        token_in.transfer(&q.taker, &q.maker, &maker_receives);
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(RfqError::NotInitialized)?;
            token_in.transfer(&q.taker, &fee_vault, &fee);
        }
        // Maker's leg: delivery to the taker.
        token::Client::new(&env, &q.token_out).transfer(&q.maker, &q.taker, &q.amount_out);

        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        env.events().publish(
            (symbol_short!("rfq"), symbol_short!("settled"), q.maker.clone()),
            (
                q.taker.clone(),
                q.token_in.clone(),
                q.token_out.clone(),
                q.amount_in,
                q.amount_out,
                fee,
                q.nonce,
                fair_out,
            ),
        );
        Ok(fee)
    }

    // ─── Views ──────────────────────────────────────────

    /// Everything `settle_quote` would compute, without auth or
    /// transfers. Fails with the same error settlement would.
    pub fn check_quote(env: Env, q: Quote) -> Result<QuoteCheck, RfqError> {
        Self::validate(&env, &q)?;
        if env
            .storage()
            .temporary()
            .has(&DataKey::Used(q.maker.clone(), q.nonce))
        {
            return Err(RfqError::AlreadyUsed);
        }
        let (fair_out, deviation_bps) = Self::nav_check(&env, &q)?;
        let fee = Self::calculate_fee(&env, q.amount_in);
        let maker_receives = q.amount_in - fee;
        if maker_receives <= 0 {
            return Err(RfqError::InvalidAmount);
        }
        Ok(QuoteCheck {
            fair_out,
            deviation_bps,
            fee,
            maker_receives,
        })
    }

    /// Oracle fair value of `amount_in` of `token_in`, in `token_out`
    /// base units, per the SwapBook's feeds for the pair.
    pub fn fair_value(
        env: Env,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> Result<i128, RfqError> {
        if amount_in <= 0 {
            return Err(RfqError::InvalidAmount);
        }
        let (num, den) = Self::read_oracle(&env, &token_in, &token_out)?;
        let fair = Self::muldiv_floor(&env, amount_in, num, den);
        if fair <= 0 {
            return Err(RfqError::OracleUnavailable);
        }
        Ok(fair)
    }

    pub fn is_used(env: Env, maker: Address, nonce: u64) -> bool {
        env.storage().temporary().has(&DataKey::Used(maker, nonce))
    }

    pub fn get_fee(env: Env) -> (i128, i128) {
        (Self::fee_per_100k(&env), FEE_DENOMINATOR)
    }

    /// (admin, fee_vault, swap_book)
    pub fn get_config(env: Env) -> Result<(Address, Address, Address), RfqError> {
        let admin = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RfqError::NotInitialized)?;
        let fee_vault = env
            .storage()
            .instance()
            .get(&DataKey::FeeVault)
            .ok_or(RfqError::NotInitialized)?;
        let swap_book = env
            .storage()
            .instance()
            .get(&DataKey::SwapBook)
            .ok_or(RfqError::NotInitialized)?;
        Ok((admin, fee_vault, swap_book))
    }

    // ─── Admin ──────────────────────────────────────────

    /// Set the fee rate (per 100k). Hard-capped at the deployed 0.5 bps.
    pub fn set_fee(env: Env, fee_per_100k: i128) -> Result<(), RfqError> {
        Self::require_admin(&env)?;
        if !(0..=MAX_FEE_PER_100K).contains(&fee_per_100k) {
            return Err(RfqError::FeeAboveCap);
        }
        env.storage()
            .instance()
            .set(&DataKey::FeePer100k, &fee_per_100k);
        env.events()
            .publish((symbol_short!("fee"), symbol_short!("set")), fee_per_100k);
        Ok(())
    }

    /// Repoint the NAV source (a SwapBook with `get_oracle_price`).
    pub fn set_swap_book(env: Env, swap_book: Address) -> Result<(), RfqError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::SwapBook, &swap_book);
        env.events()
            .publish((symbol_short!("book"), symbol_short!("set")), swap_book);
        Ok(())
    }

    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), RfqError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    pub fn accept_admin(env: Env) -> Result<(), RfqError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(RfqError::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events()
            .publish((symbol_short!("admin"), symbol_short!("set")), pending);
        Ok(())
    }

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), RfqError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RfqError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn validate(env: &Env, q: &Quote) -> Result<(), RfqError> {
        if q.amount_in <= 0 || q.amount_out <= 0 {
            return Err(RfqError::InvalidAmount);
        }
        if q.token_in == q.token_out {
            return Err(RfqError::SameToken);
        }
        if q.maker == q.taker {
            return Err(RfqError::SameParty);
        }
        let seq = env.ledger().sequence();
        if seq > q.expiry_ledger {
            return Err(RfqError::Expired);
        }
        if q.expiry_ledger - seq > MAX_QUOTE_TTL_LEDGERS {
            return Err(RfqError::ExpiryTooFar);
        }
        if q.max_nav_dev_bps > MAX_NAV_BAND_BPS {
            return Err(RfqError::NavBandTooWide);
        }
        Ok(())
    }

    /// Enforce the NAV band when requested. Returns (fair_out,
    /// signed deviation bps); (0, 0) when the quote carries no band.
    fn nav_check(env: &Env, q: &Quote) -> Result<(i128, i128), RfqError> {
        if q.max_nav_dev_bps == 0 {
            return Ok((0, 0));
        }
        let (num, den) = Self::read_oracle(env, &q.token_in, &q.token_out)?;
        let fair = Self::muldiv_floor(env, q.amount_in, num, den);
        if fair <= 0 {
            return Err(RfqError::OracleUnavailable);
        }
        // Signed deviation (positive = taker short of NAV), then the
        // absolute value against the band. Ceil so a hair over fails.
        let shortfall = fair - q.amount_out;
        let abs = if shortfall < 0 { -shortfall } else { shortfall };
        let dev_abs = Self::muldiv_ceil(env, abs, BPS_DENOMINATOR, fair);
        if dev_abs > q.max_nav_dev_bps as i128 {
            return Err(RfqError::NavBandExceeded);
        }
        let dev_signed = if shortfall < 0 { -dev_abs } else { dev_abs };
        Ok((fair, dev_signed))
    }

    /// (num, den): token_out base units per token_in base unit, from the
    /// SwapBook's `get_oracle_price` (SEP-40 feeds, decimals normalized,
    /// freshness enforced there). Any failure → OracleUnavailable.
    fn read_oracle(env: &Env, token_in: &Address, token_out: &Address) -> Result<(i128, i128), RfqError> {
        let swap_book: Address = env
            .storage()
            .instance()
            .get(&DataKey::SwapBook)
            .ok_or(RfqError::NotInitialized)?;
        let res = env.try_invoke_contract::<(i128, i128, u32), soroban_sdk::Error>(
            &swap_book,
            &Symbol::new(env, "get_oracle_price"),
            vec![env, token_in.into_val(env), token_out.into_val(env)],
        );
        match res {
            Ok(Ok((num, den, _))) if num > 0 && den > 0 => Ok((num, den)),
            _ => Err(RfqError::OracleUnavailable),
        }
    }

    fn fee_per_100k(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeePer100k)
            .unwrap_or(DEFAULT_FEE_PER_100K)
    }

    /// Fee rounds up — never zero for a nonzero amount unless the rate is 0.
    fn calculate_fee(env: &Env, amount: i128) -> i128 {
        let rate = Self::fee_per_100k(env);
        if rate == 0 {
            return 0;
        }
        Self::muldiv_ceil(env, amount, rate, FEE_DENOMINATOR)
    }

    fn muldiv_floor(env: &Env, a: i128, b: i128, d: i128) -> i128 {
        if d == 0 {
            panic_with_error!(env, RfqError::OracleUnavailable);
        }
        let r = I256::from_i128(env, a)
            .mul(&I256::from_i128(env, b))
            .div(&I256::from_i128(env, d));
        match r.to_i128() {
            Some(v) => v,
            None => panic_with_error!(env, RfqError::Overflow),
        }
    }

    fn muldiv_ceil(env: &Env, a: i128, b: i128, d: i128) -> i128 {
        if d == 0 {
            panic_with_error!(env, RfqError::OracleUnavailable);
        }
        let num = I256::from_i128(env, a).mul(&I256::from_i128(env, b));
        let r = num
            .add(&I256::from_i128(env, d - 1))
            .div(&I256::from_i128(env, d));
        match r.to_i128() {
            Some(v) => v,
            None => panic_with_error!(env, RfqError::Overflow),
        }
    }
}

#[cfg(test)]
mod test;

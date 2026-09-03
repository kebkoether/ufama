#![no_std]

//! TwapBook — time-weighted execution of large orders.
//!
//! A maker escrows a total amount and a schedule; anyone (a permissionless
//! keeper) then executes slices through registered venue adapters. The
//! contract — not the keeper — enforces the three constraints that matter:
//!
//!   1. PACE — cumulative fill may not run ahead of the schedule
//!      (plus a bounded tolerance band for catch-up)
//!   2. PRICE — every slice's net proceeds must clear the maker's limit
//!      price, or a fresh oracle price ± slippage when no limit
//!   3. CADENCE — a minimum ledger gap between slices
//!
//! Proceeds stream to the maker slice-by-slice, net of the protocol fee.
//! The fee is admin-settable but HARD-CAPPED on-chain at 10 bps
//! (MAX_FEE_PER_100K) — makers can verify the ceiling and the admin can
//! only ever lower the rate within it. A misbehaving keeper can only make
//! execution slower — never worse-priced. Unfilled remainder refunds on
//! cancel (maker) or expiry (anyone).

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error,
    symbol_short, token, Address, Env, IntoVal, Symbol, Vec, I256,
};

/// Protocol fee is expressed per 100,000 of slice output (0.1 bp
/// granularity), rounded up when charged. Admin-settable via set_fee,
/// never above MAX_FEE_PER_100K. 100 per 100,000 = 10 bps = 0.10%.
const MAX_FEE_PER_100K: i128 = 100;
const DEFAULT_FEE_PER_100K: i128 = 100;
const FEE_DENOMINATOR: i128 = 100_000;

const BPS_DENOMINATOR: i128 = 10_000;

/// Oracle price (read from SwapBook) must be newer than this many ledgers.
const ORACLE_STALE_LEDGERS: u32 = 1000;

/// Bounds on order parameters.
const MIN_DURATION_LEDGERS: u32 = 60;      // ~5 min
const MAX_SLIPPAGE_BPS: u32 = 1000;        // 10% (oracle mode)
const MAX_PACE_TOLERANCE_BPS: u32 = 5000;  // 50% of total as catch-up headroom
const MAX_ACTIVE_ORDERS: u32 = 500;

/// Storage TTL management (ledgers).
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    FeeVault,
    /// SwapBook contract — source of oracle prices for market-bound orders
    SwapBook,
    NextOrderId,
    Order(u64),
    /// Index of Active order ids (bounded by MAX_ACTIVE_ORDERS)
    ActiveIndex,
    /// venue_id -> adapter contract address (same registry shape as Router)
    Venue(u32),
    /// Protocol fee numerator per FEE_DENOMINATOR (100,000)
    FeePer100k,
    /// Two-step admin rotation: proposed new admin, pending acceptance.
    PendingAdmin,
}

// ─── Types ──────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum TwapStatus {
    Active,
    Completed,
    Cancelled,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RouteSegment {
    pub venue_id: u32,
    pub amount_in: i128,
    pub min_amount_out: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct TwapOrder {
    pub id: u64,
    pub maker: Address,
    pub token_in: Address,
    pub token_out: Address,
    /// Total escrowed amount to execute over the schedule
    pub total_in: i128,
    /// Cumulative token_in executed so far
    pub filled_in: i128,
    /// Cumulative token_out streamed to the maker (net of fees)
    pub received_out: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    /// Fixed limit price: minimum token_out per token_in as num/den.
    /// Both zero = no fixed limit — the SwapBook oracle bounds each slice.
    pub limit_num: i128,
    pub limit_den: i128,
    /// (oracle mode only) max slippage vs oracle fair value, in bps
    pub max_slippage_bps: u32,
    /// Hard cap per slice, in token_in units
    pub max_slice_in: i128,
    /// Minimum ledgers between slices
    pub min_slice_gap: u32,
    /// Catch-up headroom: cumulative fill may exceed pro-rata schedule by
    /// total_in * pace_tolerance_bps / 10000
    pub pace_tolerance_bps: u32,
    pub last_slice_ledger: u32,
    pub status: TwapStatus,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum TwapError {
    NotInitialized = 1,
    Unauthorized = 2,
    OrderNotFound = 3,
    OrderNotActive = 4,
    InvalidAmount = 5,
    SameToken = 6,
    InvalidSchedule = 7,
    InvalidPricing = 8,
    InvalidParams = 9,
    BookFull = 10,
    VenueNotFound = 11,
    InvalidRoute = 12,
    RouteMismatch = 13,
    SliceTooEarly = 14,
    AheadOfSchedule = 15,
    SliceExceedsCap = 16,
    InsufficientOutput = 17,
    OraclePriceStale = 18,
    OrderExpired = 19,
    OrderNotExpired = 20,
    Overflow = 21,
    NoPendingAdmin = 22,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct TwapBook;

#[contractimpl]
impl TwapBook {
    /// Deploy-time constructor — atomic with deployment, cannot be front-run.
    pub fn __constructor(env: Env, admin: Address, fee_vault: Address, swap_book: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeVault, &fee_vault);
        env.storage().instance().set(&DataKey::SwapBook, &swap_book);
        env.storage().instance().set(&DataKey::NextOrderId, &1u64);
        env.storage()
            .instance()
            .set(&DataKey::ActiveIndex, &Vec::<u64>::new(&env));
        env.storage()
            .instance()
            .set(&DataKey::FeePer100k, &DEFAULT_FEE_PER_100K);
    }

    /// Propose a new admin (two-step rotation). Admin only. The proposed
    /// address must call `accept_admin` to take over, so a mistyped
    /// transfer is recoverable until accepted.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), TwapError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("proposed")),
            new_admin,
        );
        Ok(())
    }

    /// Complete an admin rotation — callable only by the proposed admin,
    /// proving the new key is live before it holds power.
    pub fn accept_admin(env: Env) -> Result<(), TwapError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(TwapError::NoPendingAdmin)?;
        pending.require_auth();
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("accepted")),
            pending,
        );
        Ok(())
    }

    /// Set the protocol fee (per 100,000 of slice output). Admin only,
    /// hard-capped at MAX_FEE_PER_100K — the ceiling is compile-time and
    /// cannot be raised without a new contract makers would have to opt
    /// into. 0 is valid (fee holiday).
    pub fn set_fee(env: Env, fee_per_100k: i128) -> Result<(), TwapError> {
        Self::require_admin(&env)?;
        if !(0..=MAX_FEE_PER_100K).contains(&fee_per_100k) {
            return Err(TwapError::InvalidParams);
        }
        env.storage().instance().set(&DataKey::FeePer100k, &fee_per_100k);
        env.events().publish(
            (symbol_short!("twap"), symbol_short!("fee")),
            fee_per_100k,
        );
        Ok(())
    }

    /// Current protocol fee as (numerator, denominator) — e.g. (100, 100000)
    /// = 10 bps. Denominator is always FEE_DENOMINATOR.
    pub fn get_fee(env: Env) -> (i128, i128) {
        (Self::fee_per_100k(&env), FEE_DENOMINATOR)
    }

    /// Register a venue adapter (same push-funds interface as the Router's).
    /// Admin only.
    pub fn register_venue(
        env: Env,
        venue_id: u32,
        contract_address: Address,
    ) -> Result<(), TwapError> {
        Self::require_admin(&env)?;
        env.storage()
            .persistent()
            .set(&DataKey::Venue(venue_id), &contract_address);
        env.events().publish(
            (symbol_short!("twap"), symbol_short!("venue")),
            (venue_id, contract_address),
        );
        Ok(())
    }

    /// Remove a venue. Admin only.
    pub fn remove_venue(env: Env, venue_id: u32) -> Result<(), TwapError> {
        Self::require_admin(&env)?;
        env.storage().persistent().remove(&DataKey::Venue(venue_id));
        Ok(())
    }

    /// Place a TWAP order. Escrows `total_in` of token_in.
    ///
    /// Pricing: pass limit_num/limit_den > 0 for a fixed floor (min token_out
    /// per token_in). Pass 0/0 to bound each slice by the SwapBook oracle
    /// instead — requires max_slippage_bps in 1..=1000 and a FRESH oracle
    /// price for the pair at placement time.
    pub fn place_twap(
        env: Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        total_in: i128,
        end_ledger: u32,
        limit_num: i128,
        limit_den: i128,
        max_slippage_bps: u32,
        max_slice_in: i128,
        min_slice_gap: u32,
        pace_tolerance_bps: u32,
    ) -> Result<u64, TwapError> {
        maker.require_auth();
        let now = env.ledger().sequence();

        if total_in <= 0 {
            return Err(TwapError::InvalidAmount);
        }
        if token_in == token_out {
            return Err(TwapError::SameToken);
        }
        if end_ledger < now + MIN_DURATION_LEDGERS {
            return Err(TwapError::InvalidSchedule);
        }
        if max_slice_in <= 0 || max_slice_in > total_in {
            return Err(TwapError::InvalidParams);
        }
        if min_slice_gap == 0 || pace_tolerance_bps > MAX_PACE_TOLERANCE_BPS {
            return Err(TwapError::InvalidParams);
        }

        let fixed_limit = limit_num > 0 && limit_den > 0;
        if !fixed_limit {
            if limit_num != 0 || limit_den != 0 {
                return Err(TwapError::InvalidPricing); // half-set limit
            }
            if max_slippage_bps == 0 || max_slippage_bps > MAX_SLIPPAGE_BPS {
                return Err(TwapError::InvalidPricing);
            }
            // Oracle-bound order: a fresh price must exist NOW so the order
            // can't be placed unexecutable.
            Self::read_fresh_oracle(&env, &token_in, &token_out)?;
        }

        let mut index: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveIndex)
            .unwrap_or(Vec::new(&env));
        if index.len() >= MAX_ACTIVE_ORDERS {
            return Err(TwapError::BookFull);
        }

        // Escrow
        token::Client::new(&env, &token_in).transfer(
            &maker,
            env.current_contract_address(),
            &total_in,
        );

        let order_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextOrderId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextOrderId, &(order_id + 1));

        let order = TwapOrder {
            id: order_id,
            maker: maker.clone(),
            token_in: token_in.clone(),
            token_out: token_out.clone(),
            total_in,
            filled_in: 0,
            received_out: 0,
            start_ledger: now,
            end_ledger,
            limit_num,
            limit_den,
            max_slippage_bps,
            max_slice_in,
            min_slice_gap,
            pace_tolerance_bps,
            last_slice_ledger: 0,
            status: TwapStatus::Active,
        };
        Self::write_order(&env, order_id, &order);

        index.push_back(order_id);
        env.storage().instance().set(&DataKey::ActiveIndex, &index);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("twap"), symbol_short!("placed"), order_id),
            (maker, token_in, token_out, total_in, end_ledger),
        );
        Ok(order_id)
    }

    /// Execute one slice of a TWAP order. PERMISSIONLESS — the contract
    /// enforces pace, price, and cadence; the caller only chooses timing,
    /// size (within caps), and the route.
    pub fn execute_slice(
        env: Env,
        order_id: u64,
        amount_in: i128,
        segments: Vec<RouteSegment>,
    ) -> Result<i128, TwapError> {
        let mut order = Self::read_order(&env, order_id)?;
        let now = env.ledger().sequence();

        if order.status != TwapStatus::Active {
            return Err(TwapError::OrderNotActive);
        }
        if now > order.end_ledger {
            return Err(TwapError::OrderExpired); // expire_twap refunds
        }

        // ── CADENCE ──
        if order.last_slice_ledger > 0 && now < order.last_slice_ledger + order.min_slice_gap {
            return Err(TwapError::SliceTooEarly);
        }

        // ── SIZE ──
        let remaining = order.total_in - order.filled_in;
        if amount_in <= 0 || amount_in > remaining {
            return Err(TwapError::InvalidAmount);
        }
        if amount_in > order.max_slice_in {
            return Err(TwapError::SliceExceedsCap);
        }

        // ── PACE ──
        // allowed_cum = total * elapsed / duration + total * tolerance / 10000
        let elapsed = (now - order.start_ledger) as i128;
        let duration = (order.end_ledger - order.start_ledger) as i128;
        let on_schedule = Self::muldiv_floor(&env, order.total_in, elapsed, duration);
        let headroom = Self::muldiv_floor(
            &env,
            order.total_in,
            order.pace_tolerance_bps as i128,
            BPS_DENOMINATOR,
        );
        if order.filled_in + amount_in > on_schedule + headroom {
            return Err(TwapError::AheadOfSchedule);
        }

        // ── EXECUTE ── (push-funds pattern; adapters send token_out back)
        Self::validate_segments(&segments, amount_in)?;
        let total_out = Self::execute_segments(&env, &order.token_in, &order.token_out, &segments)?;

        let fee = Self::muldiv_ceil(&env, total_out, Self::fee_per_100k(&env), FEE_DENOMINATOR);
        let net_out = total_out - fee;

        // ── PRICE FLOOR ──
        let min_net = if order.limit_num > 0 {
            Self::muldiv_ceil(&env, amount_in, order.limit_num, order.limit_den)
        } else {
            let (num, den) = Self::read_fresh_oracle(&env, &order.token_in, &order.token_out)?;
            let fair = Self::muldiv_floor(&env, amount_in, num, den);
            Self::muldiv_ceil(
                &env,
                fair,
                BPS_DENOMINATOR - order.max_slippage_bps as i128,
                BPS_DENOMINATOR,
            )
        };
        if net_out < min_net {
            return Err(TwapError::InsufficientOutput);
        }

        // ── SETTLE ──
        let token_out_client = token::Client::new(&env, &order.token_out);
        token_out_client.transfer(&env.current_contract_address(), &order.maker, &net_out);
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(TwapError::NotInitialized)?;
            token_out_client.transfer(&env.current_contract_address(), &fee_vault, &fee);
        }

        order.filled_in += amount_in;
        order.received_out += net_out;
        order.last_slice_ledger = now;
        let completed = order.filled_in == order.total_in;
        if completed {
            order.status = TwapStatus::Completed;
        }
        Self::write_order(&env, order_id, &order);
        if completed {
            Self::deindex(&env, order_id);
            env.events().publish(
                (symbol_short!("twap"), symbol_short!("complete"), order_id),
                (order.filled_in, order.received_out),
            );
        }

        env.events().publish(
            (symbol_short!("twap"), symbol_short!("slice"), order_id),
            (amount_in, net_out, fee),
        );
        Ok(net_out)
    }

    /// Cancel an active TWAP order — maker only. Refunds the unfilled
    /// remainder immediately; proceeds already streamed stay with the maker.
    pub fn cancel_twap(env: Env, order_id: u64) -> Result<(), TwapError> {
        let mut order = Self::read_order(&env, order_id)?;
        order.maker.require_auth();
        if order.status != TwapStatus::Active {
            return Err(TwapError::OrderNotActive);
        }
        Self::refund_remaining(&env, &mut order, TwapStatus::Cancelled);
        Self::write_order(&env, order_id, &order);
        Self::deindex(&env, order_id);
        env.events().publish(
            (symbol_short!("twap"), symbol_short!("cancel"), order_id),
            (),
        );
        Ok(())
    }

    /// Permissionless cleanup after end_ledger: refund the unfilled
    /// remainder to the maker and close the order.
    pub fn expire_twap(env: Env, order_id: u64) -> Result<(), TwapError> {
        let mut order = Self::read_order(&env, order_id)?;
        if order.status != TwapStatus::Active {
            return Err(TwapError::OrderNotActive);
        }
        if env.ledger().sequence() <= order.end_ledger {
            return Err(TwapError::OrderNotExpired);
        }
        Self::refund_remaining(&env, &mut order, TwapStatus::Expired);
        Self::write_order(&env, order_id, &order);
        Self::deindex(&env, order_id);
        env.events().publish(
            (symbol_short!("twap"), symbol_short!("expired"), order_id),
            (),
        );
        Ok(())
    }

    // ─── Queries ────────────────────────────────────────

    pub fn get_order(env: Env, order_id: u64) -> Result<TwapOrder, TwapError> {
        Self::read_order(&env, order_id)
    }

    pub fn get_active_orders(env: Env) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::ActiveIndex)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_venue(env: Env, venue_id: u32) -> Result<Address, TwapError> {
        env.storage()
            .persistent()
            .get(&DataKey::Venue(venue_id))
            .ok_or(TwapError::VenueNotFound)
    }

    // ─── Internal ───────────────────────────────────────

    fn fee_per_100k(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeePer100k)
            .unwrap_or(DEFAULT_FEE_PER_100K)
    }

    fn require_admin(env: &Env) -> Result<(), TwapError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(TwapError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn read_order(env: &Env, order_id: u64) -> Result<TwapOrder, TwapError> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(TwapError::OrderNotFound)
    }

    fn write_order(env: &Env, order_id: u64, order: &TwapOrder) {
        let key = DataKey::Order(order_id);
        env.storage().persistent().set(&key, order);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn refund_remaining(env: &Env, order: &mut TwapOrder, status: TwapStatus) {
        let remaining = order.total_in - order.filled_in;
        if remaining > 0 {
            token::Client::new(env, &order.token_in).transfer(
                &env.current_contract_address(),
                &order.maker,
                &remaining,
            );
        }
        order.status = status;
    }

    fn deindex(env: &Env, order_id: u64) {
        let index: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::ActiveIndex)
            .unwrap_or(Vec::new(env));
        let mut next = Vec::new(env);
        for i in 0..index.len() {
            let id = index.get(i).unwrap();
            if id != order_id {
                next.push_back(id);
            }
        }
        env.storage().instance().set(&DataKey::ActiveIndex, &next);
    }

    /// Read the SwapBook oracle for the pair; error if unset or stale.
    fn read_fresh_oracle(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<(i128, i128), TwapError> {
        let swap_book: Address = env
            .storage()
            .instance()
            .get(&DataKey::SwapBook)
            .ok_or(TwapError::NotInitialized)?;
        let (num, den, updated_at): (i128, i128, u32) = env.invoke_contract(
            &swap_book,
            &Symbol::new(env, "get_oracle_price"),
            soroban_sdk::vec![
                env,
                token_in.into_val(env),
                token_out.into_val(env),
            ],
        );
        if env.ledger().sequence() > updated_at + ORACLE_STALE_LEDGERS {
            return Err(TwapError::OraclePriceStale);
        }
        Ok((num, den))
    }

    fn validate_segments(segments: &Vec<RouteSegment>, total: i128) -> Result<(), TwapError> {
        if segments.is_empty() {
            return Err(TwapError::InvalidRoute);
        }
        let mut sum: i128 = 0;
        for i in 0..segments.len() {
            let seg = segments.get(i).unwrap();
            if seg.amount_in <= 0 || seg.min_amount_out < 0 {
                return Err(TwapError::InvalidAmount);
            }
            sum += seg.amount_in;
        }
        if sum != total {
            return Err(TwapError::RouteMismatch);
        }
        Ok(())
    }

    /// Push token_in to each adapter, invoke `swap`, sum what comes back.
    /// Identical interface to the Router's venue adapters.
    fn execute_segments(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
        segments: &Vec<RouteSegment>,
    ) -> Result<i128, TwapError> {
        let token_in_client = token::Client::new(env, token_in);
        let mut total_out: i128 = 0;
        for i in 0..segments.len() {
            let seg = segments.get(i).unwrap();
            let venue: Address = env
                .storage()
                .persistent()
                .get(&DataKey::Venue(seg.venue_id))
                .ok_or(TwapError::VenueNotFound)?;
            token_in_client.transfer(&env.current_contract_address(), &venue, &seg.amount_in);
            let received: i128 = env.invoke_contract(
                &venue,
                &Symbol::new(env, "swap"),
                soroban_sdk::vec![
                    env,
                    env.current_contract_address().into_val(env),
                    token_in.into_val(env),
                    token_out.into_val(env),
                    seg.amount_in.into_val(env),
                    seg.min_amount_out.into_val(env),
                ],
            );
            if received < seg.min_amount_out {
                return Err(TwapError::InsufficientOutput);
            }
            total_out += received;
        }
        Ok(total_out)
    }

    fn muldiv_floor(env: &Env, a: i128, b: i128, d: i128) -> i128 {
        if d == 0 {
            panic_with_error!(env, TwapError::InvalidPricing);
        }
        let r = I256::from_i128(env, a)
            .mul(&I256::from_i128(env, b))
            .div(&I256::from_i128(env, d));
        match r.to_i128() {
            Some(v) => v,
            None => panic_with_error!(env, TwapError::Overflow),
        }
    }

    fn muldiv_ceil(env: &Env, a: i128, b: i128, d: i128) -> i128 {
        if d == 0 {
            panic_with_error!(env, TwapError::InvalidPricing);
        }
        let num = I256::from_i128(env, a).mul(&I256::from_i128(env, b));
        let r = num
            .add(&I256::from_i128(env, d - 1))
            .div(&I256::from_i128(env, d));
        match r.to_i128() {
            Some(v) => v,
            None => panic_with_error!(env, TwapError::Overflow),
        }
    }
}

#[cfg(test)]
mod test;

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, panic_with_error,
    symbol_short, token, Address, Env, IntoVal, Symbol, Vec, I256,
};

/// Protocol fee, per 100,000 of the taker's payment (rounded up, min
/// 1 stroop when nonzero). Admin-settable via set_fee but HARD-CAPPED at
/// the deployed 0.5 bps — the admin can hold a fee holiday or restore the
/// rate, never raise it past the cap without a new contract.
const MAX_FEE_PER_100K: i128 = 5;
const DEFAULT_FEE_PER_100K: i128 = 5;
const FEE_DENOMINATOR: i128 = 100_000;

/// Cap on per-order excluded counterparties — bounds the fill-time scan.
const MAX_EXCLUDED: u32 = 5;

/// SEP-40 feeds report timestamps in seconds or (some deployments)
/// milliseconds. Anything above this is clearly milliseconds (~5138 AD in
/// seconds) and gets normalized.
const SEP40_MS_THRESHOLD: u64 = 100_000_000_000;

/// Max tolerated clock skew for a SEP-40 timestamp that is AHEAD of the
/// ledger clock — further in the future is rejected as invalid.
const SEP40_MAX_FUTURE_SKEW_SECS: u64 = 60;

/// Basis-point denominator for slippage calculations
const BPS_DENOMINATOR: i128 = 10_000;

/// Oracle price must have been updated within this many ledgers (~83 min)
const ORACLE_STALE_LEDGERS: u32 = 1000;

/// Maximum allowed slippage tolerance for oracle-pegged orders (10%)
const MAX_SLIPPAGE_BPS: u32 = 1000;

/// Maximum allowed jump between consecutive oracle updates (20%).
/// Larger legitimate moves must be pushed in steps; this bounds the
/// damage of a compromised oracle key.
const MAX_ORACLE_JUMP_BPS: i128 = 2000;

/// Cap on open orders per pair index — keeps the index ledger entry bounded.
const MAX_ORDERS_PER_PAIR: u32 = 200;

/// Cap on how far ahead an order's expiry may sit (~90 days at 5s/ledger).
/// Together with the per-token dust floor this stops 1-stroop forever
/// orders from squatting the bounded pair index.
const MAX_EXPIRY_LEDGERS: u32 = 1_555_200;

/// Cap on OPEN orders one maker may hold on one directed pair. The pair
/// index is bounded (MAX_ORDERS_PER_PAIR) and shared by every maker, so
/// without a per-maker cap a single wallet could fill it with dust-floor
/// orders and lock everyone else out of the pair.
const MAX_OPEN_PER_MAKER_PAIR: u32 = 10;

/// Storage TTL management (ledgers): extend when below threshold, up to target.
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days at 5s/ledger

/// Upper bound on any single TTL extension this contract requests
/// (~180 days at 5s/ledger). Order entries are extended to cover their
/// own expiry (≤ MAX_EXPIRY_LEDGERS ahead), which always fits under this;
/// the cap is a guard against ever asking the host for more than the
/// network's max entry TTL (3,110,400 on pubnet at the time of writing —
/// `env.storage().max_ttl()` is also consulted at runtime).
const MAX_TTL_EXTEND_TO: u32 = 3_110_400;

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    FeeVault,
    NextOrderId,
    Order(u64),
    /// Index of open order IDs for a token pair (token_in, token_out)
    PairIndex(Address, Address),
    /// Authorized router address (can claim timer-expired orders).
    /// This MUST be the Router *contract* so claims stay atomic on-chain.
    Router,
    /// Oracle price for a directed pair, stored as (price_num, price_den)
    OraclePrice(Address, Address),
    /// Authorized oracle updater address
    OracleAdmin,
    /// Protocol fee numerator per FEE_DENOMINATOR (settable ≤ cap)
    FeePer100k,
    /// Max acceptable age (seconds) of a SEP-40 price
    Sep40MaxAge,
    /// SEP-40 feed for a token — carries ITS OWN oracle contract, so
    /// different tokens can price off different oracles (e.g. Reflector's
    /// external-markets oracle for XLM/USDC/EURC, their Stellar-DEX
    /// oracle for the Etherfuse stablebonds).
    Sep40Feed(Address),
    /// Two-step admin rotation: the proposed new admin, pending acceptance.
    PendingAdmin,
    /// Minimum order size (base units) for orders escrowing this token.
    MinOrder(Address),
    /// Number of OPEN / PartialFill orders a maker holds on a directed
    /// pair: (maker, token_in, token_out) → u32. Enforces
    /// MAX_OPEN_PER_MAKER_PAIR; removed when it drops to zero.
    MakerPairCount(Address, Address, Address),
}

// ─── Types ──────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OrderStatus {
    Open,
    PartialFill,
    Filled,
    Cancelled,
    Expired,
    /// Timer expired — claimed by router for DEX execution
    Routed,
}

/// How the order's minimum output price is determined.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PriceMode {
    /// Classic fixed-price order: maker sets an explicit min_amount_out.
    Fixed,
    /// Oracle-pegged order: at fill time the contract reads a stored oracle
    /// price and enforces that the taker's payment is within
    /// `max_slippage_bps` of fair value.
    Oracle,
}

/// Mirror of the SEP-40 `Asset` enum — variant names must match the
/// oracle contract's exactly (XDR encodes the variant symbol).
#[contracttype]
#[derive(Clone, Debug)]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

/// A token's oracle feed: which SEP-40 contract to ask, how the asset is
/// keyed there, and that oracle's price decimals (captured at
/// registration so cross-oracle pairs normalize correctly).
#[contracttype]
#[derive(Clone, Debug)]
pub struct FeedConfig {
    pub oracle: Address,
    pub asset: OracleAsset,
    pub oracle_decimals: u32,
    /// Max acceptable price age (seconds) for THIS feed; 0 = use the
    /// global Sep40MaxAge. Providers push on very different cadences
    /// (Reflector ~5 min, RedStone 12-24h heartbeat) — a single global
    /// age either rejects healthy RedStone feeds or waves through a
    /// half-day-stale Reflector one.
    pub max_age_secs: u64,
}

/// Mirror of the SEP-40 `PriceData` struct (field names must match).
#[contracttype]
#[derive(Clone, Debug)]
pub struct Sep40PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// One fill inside a `match_and_place` plan: take `fill_amount_in` of the
/// reverse-side order's escrow, paying `amount_out` of its token_out.
#[contracttype]
#[derive(Clone, Debug)]
pub struct FillSpec {
    pub order_id: u64,
    pub fill_amount_in: i128,
    pub amount_out: i128,
}

/// Oracle price stored as a rational number (numerator / denominator).
#[contracttype]
#[derive(Clone, Debug)]
pub struct OraclePriceData {
    /// price numerator (amount of token_out per unit of token_in)
    pub num: i128,
    /// price denominator
    pub den: i128,
    /// ledger sequence when this price was last updated
    pub updated_at: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub maker: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_in_remaining: i128,
    /// For Fixed mode: the explicit minimum output.
    /// For Oracle mode: ignored at fill time (oracle price + slippage used instead).
    pub min_amount_out: i128,
    pub expiry: u32,
    pub status: OrderStatus,
    pub created_at: u32,
    /// Pricing strategy for this order
    pub price_mode: PriceMode,
    /// (Oracle mode only) maximum slippage tolerance in basis points
    pub max_slippage_bps: u32,
    /// Ledger sequence after which the router may claim this order and
    /// execute it through DEX liquidity. 0 = no auto-route (sit forever).
    pub auto_route_after: u32,
    /// Addresses that may NOT fill this order (≤ MAX_EXCLUDED). Lets a
    /// liquidity provider running several wallets guarantee on-chain that
    /// they never cross themselves. Empty = anyone may fill.
    pub excluded: Vec<Address>,
}

/// Returned by `claim_expired_timer` so the Router contract can enforce the
/// maker's price on the DEX proceeds within the same invocation.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ClaimedOrder {
    pub order_id: u64,
    pub maker: Address,
    pub token_in: Address,
    pub token_out: Address,
    /// Escrowed amount transferred to the router
    pub amount: i128,
    /// Minimum token_out the maker must receive (net) for this claim,
    /// derived from the order's fixed price or the current oracle price.
    pub min_out: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SwapBookError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    OrderNotFound = 4,
    OrderNotOpen = 5,
    OrderExpired = 6,
    InsufficientOutput = 7,
    InvalidAmount = 8,
    FillExceedsRemaining = 9,
    SameToken = 10,
    OraclePriceNotSet = 11,
    OracleSlippageExceeded = 12,
    TimerNotExpired = 13,
    RouterNotSet = 14,
    OraclePriceStale = 15,
    Overflow = 16,
    InvalidPrice = 17,
    SlippageTooHigh = 18,
    BookFull = 19,
    OrderNotExpired = 20,
    OracleJumpTooLarge = 21,
    ExcludedCounterparty = 22,
    TooManyExclusions = 23,
    FeeAboveCap = 24,
    MatchWrongPair = 25,
    MatchExceedsBudget = 26,
    BelowMinimumOrder = 27,
    ExpiryTooFar = 28,
    NoPendingAdmin = 29,
    MakerPairLimit = 30,
}

// ─── Contract ───────────────────────────────────────────

#[contract]
pub struct SwapBook;

#[contractimpl]
impl SwapBook {
    /// Deploy-time constructor — atomic with deployment, cannot be front-run.
    pub fn __constructor(env: Env, admin: Address, fee_vault: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeVault, &fee_vault);
        env.storage().instance().set(&DataKey::NextOrderId, &1u64);
    }

    /// Set the authorized router address (admin only).
    /// The router MUST be the Router contract, which claims timer-expired
    /// orders and settles the maker atomically.
    pub fn set_router(env: Env, router: Address) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        env.storage().instance().set(&DataKey::Router, &router);
        // The router receives claimed escrow — a redirect must be visible
        // on-chain the moment it happens.
        env.events().publish(
            (symbol_short!("book"), symbol_short!("router")),
            router,
        );
        Ok(())
    }

    /// Propose a new admin (two-step rotation). Admin only. The proposed
    /// address must call `accept_admin` to take over, so a mistyped
    /// transfer is recoverable until accepted.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
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
    pub fn accept_admin(env: Env) -> Result<(), SwapBookError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(SwapBookError::NoPendingAdmin)?;
        pending.require_auth();
        Self::bump_instance_ttl(&env);
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish(
            (symbol_short!("admin"), symbol_short!("accepted")),
            pending,
        );
        Ok(())
    }

    /// Set the minimum order size (base units) for orders escrowing
    /// `token` — the dust floor that keeps 1-stroop orders from squatting
    /// the bounded pair index. Admin only; 0 clears the floor.
    pub fn set_min_order(
        env: Env,
        token: Address,
        min_amount: i128,
    ) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        if min_amount < 0 {
            return Err(SwapBookError::InvalidAmount);
        }
        let key = DataKey::MinOrder(token.clone());
        if min_amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &min_amount);
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        env.events().publish(
            (symbol_short!("book"), symbol_short!("min_order")),
            (token, min_amount),
        );
        Ok(())
    }

    /// Set the authorized oracle admin (contract admin only).
    pub fn set_oracle_admin(env: Env, oracle_admin: Address) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        env.storage()
            .instance()
            .set(&DataKey::OracleAdmin, &oracle_admin);
        // The oracle admin can move every pushed price — a rotation must
        // be visible on-chain the moment it happens.
        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("admin")),
            oracle_admin,
        );
        Ok(())
    }

    /// Update an oracle price for a token pair. Only the oracle admin can call.
    ///
    /// Hardening:
    /// - num and den must be strictly positive
    /// - consecutive updates may not deviate more than MAX_ORACLE_JUMP_BPS
    ///   from the stored price (bounds damage from a compromised key)
    pub fn update_oracle_price(
        env: Env,
        token_in: Address,
        token_out: Address,
        price_num: i128,
        price_den: i128,
    ) -> Result<(), SwapBookError> {
        let oracle_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleAdmin)
            .ok_or(SwapBookError::NotInitialized)?;
        oracle_admin.require_auth();
        Self::bump_instance_ttl(&env);

        if price_num <= 0 || price_den <= 0 {
            return Err(SwapBookError::InvalidPrice);
        }

        let price_key = DataKey::OraclePrice(token_in.clone(), token_out.clone());

        // Deviation cap vs. previous price (cross-multiplied, overflow-safe):
        // |new/old - 1| <= MAX_ORACLE_JUMP_BPS / 10000
        if let Some(prev) = env
            .storage()
            .persistent()
            .get::<DataKey, OraclePriceData>(&price_key)
        {
            let new_x_oldden = I256::from_i128(&env, price_num)
                .mul(&I256::from_i128(&env, prev.den));
            let old_x_newden = I256::from_i128(&env, prev.num)
                .mul(&I256::from_i128(&env, price_den));
            let diff = if new_x_oldden > old_x_newden {
                new_x_oldden.sub(&old_x_newden)
            } else {
                old_x_newden.sub(&new_x_oldden)
            };
            let max_diff = old_x_newden
                .mul(&I256::from_i128(&env, MAX_ORACLE_JUMP_BPS))
                .div(&I256::from_i128(&env, BPS_DENOMINATOR));
            if diff > max_diff {
                return Err(SwapBookError::OracleJumpTooLarge);
            }
        }

        let price = OraclePriceData {
            num: price_num,
            den: price_den,
            updated_at: env.ledger().sequence(),
        };
        env.storage().persistent().set(&price_key, &price);
        env.storage()
            .persistent()
            .extend_ttl(&price_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        env.events().publish(
            (symbol_short!("oracle"), symbol_short!("update")),
            (token_in, token_out, price_num, price_den),
        );
        Ok(())
    }

    /// Place a new swap order.
    ///
    /// `price_mode`: 0 = Fixed (uses min_amount_out), 1 = Oracle (uses live price)
    /// `max_slippage_bps`: Oracle mode only — must be 1..=MAX_SLIPPAGE_BPS
    /// `auto_route_after`: ledger sequence after which router can claim for DEX.
    ///                     0 = no auto-route (sit on book until expiry).
    /// `excluded`: addresses that may not fill this order (≤ MAX_EXCLUDED);
    ///             pass an empty Vec for none.
    pub fn place_order(
        env: Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        expiry: u32,
        price_mode: u32,
        max_slippage_bps: u32,
        auto_route_after: u32,
        excluded: Vec<Address>,
    ) -> Result<u64, SwapBookError> {
        maker.require_auth();
        Self::place_inner(
            &env, maker, token_in, token_out, amount_in, min_amount_out,
            expiry, price_mode, max_slippage_bps, auto_route_after, excluded,
        )
    }

    /// Shared placement path — caller must have authenticated `maker`.
    #[allow(clippy::too_many_arguments)]
    fn place_inner(
        env: &Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        expiry: u32,
        price_mode: u32,
        max_slippage_bps: u32,
        auto_route_after: u32,
        excluded: Vec<Address>,
    ) -> Result<u64, SwapBookError> {
        let env = env.clone();
        if amount_in <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }

        let mode = if price_mode == 1 {
            PriceMode::Oracle
        } else {
            PriceMode::Fixed
        };

        if mode == PriceMode::Fixed && min_amount_out <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }
        // Oracle mode ignores min_amount_out at fill time, but it is still
        // stored and echoed in events — a negative value is never valid.
        if mode == PriceMode::Oracle && min_amount_out < 0 {
            return Err(SwapBookError::InvalidAmount);
        }
        if mode == PriceMode::Oracle
            && (max_slippage_bps == 0 || max_slippage_bps > MAX_SLIPPAGE_BPS)
        {
            return Err(SwapBookError::SlippageTooHigh);
        }

        if token_in == token_out {
            return Err(SwapBookError::SameToken);
        }
        if expiry <= env.ledger().sequence() {
            return Err(SwapBookError::OrderExpired);
        }
        if expiry > env.ledger().sequence().saturating_add(MAX_EXPIRY_LEDGERS) {
            return Err(SwapBookError::ExpiryTooFar);
        }
        let min_key = DataKey::MinOrder(token_in.clone());
        if let Some(min) = env.storage().persistent().get::<DataKey, i128>(&min_key) {
            if amount_in < min {
                return Err(SwapBookError::BelowMinimumOrder);
            }
            env.storage()
                .persistent()
                .extend_ttl(&min_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }

        // If Oracle mode, verify that a fresh oracle price exists for this pair
        if mode == PriceMode::Oracle {
            let price = Self::read_oracle(&env, &token_in, &token_out)?;
            Self::check_oracle_fresh(&env, &price)?;
        }

        // Validate auto_route_after (if set): it must be in the future AND
        // strictly before expiry — a timer that fires after the order has
        // lapsed can never be claimed (claim_expired_timer refuses lapsed
        // orders), so accepting it would only mislead the maker.
        if auto_route_after > 0
            && (auto_route_after <= env.ledger().sequence() || auto_route_after >= expiry)
        {
            return Err(SwapBookError::InvalidAmount);
        }

        if excluded.len() > MAX_EXCLUDED {
            return Err(SwapBookError::TooManyExclusions);
        }

        // Bound the pair index size before escrowing anything
        let pair_key = DataKey::PairIndex(token_in.clone(), token_out.clone());
        let mut order_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&pair_key)
            .unwrap_or(Vec::new(&env));
        if order_ids.len() >= MAX_ORDERS_PER_PAIR {
            return Err(SwapBookError::BookFull);
        }
        // ...and the maker's own share of it
        let count_key =
            DataKey::MakerPairCount(maker.clone(), token_in.clone(), token_out.clone());
        let open_count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if open_count >= MAX_OPEN_PER_MAKER_PAIR {
            return Err(SwapBookError::MakerPairLimit);
        }

        // Transfer token_in from maker to this contract (escrow)
        let token_client = token::Client::new(&env, &token_in);
        token_client.transfer(&maker, env.current_contract_address(), &amount_in);

        // Generate order ID
        let order_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextOrderId)
            .unwrap_or(1u64);
        env.storage()
            .instance()
            .set(&DataKey::NextOrderId, &(order_id + 1));

        let order = Order {
            id: order_id,
            maker: maker.clone(),
            token_in: token_in.clone(),
            token_out: token_out.clone(),
            amount_in,
            amount_in_remaining: amount_in,
            min_amount_out,
            expiry,
            status: OrderStatus::Open,
            created_at: env.ledger().sequence(),
            price_mode: mode,
            max_slippage_bps,
            auto_route_after,
            excluded,
        };

        Self::write_order(&env, order_id, &order);

        // The pair index and the maker's counter must outlive the longest
        // order they describe, so they share the order's TTL horizon.
        let (ttl_threshold, ttl_extend_to) = Self::order_ttl_window(&env, &order);
        order_ids.push_back(order_id);
        env.storage().persistent().set(&pair_key, &order_ids);
        env.storage()
            .persistent()
            .extend_ttl(&pair_key, ttl_threshold, ttl_extend_to);
        env.storage().persistent().set(&count_key, &(open_count + 1));
        env.storage()
            .persistent()
            .extend_ttl(&count_key, ttl_threshold, ttl_extend_to);
        Self::bump_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("placed"), order_id),
            (maker, token_in, token_out, amount_in, min_amount_out),
        );

        Ok(order_id)
    }

    /// Atomically fill reverse-side orders and escrow the remainder as a
    /// new sitting order — the whole plan lands in ONE invocation, so the
    /// book cannot move between the fills and the placement.
    ///
    /// Each `FillSpec` targets an order selling `token_out` for `token_in`
    /// (the reverse side of the new order). The maker acts as taker on
    /// those fills, paying `amount_out` of their token_in per fill —
    /// `amount_out` is the GROSS payment (protocol fee included), exactly
    /// as `quote_fill` reports it. The payments plus the escrowed
    /// remainder must not exceed `amount_in`.
    ///
    /// Returns the new order's id, or 0 if the fills consumed the full
    /// amount and nothing was placed. Placement params mirror place_order.
    #[allow(clippy::too_many_arguments)]
    pub fn match_and_place(
        env: Env,
        maker: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        expiry: u32,
        price_mode: u32,
        max_slippage_bps: u32,
        auto_route_after: u32,
        excluded: Vec<Address>,
        fills: Vec<FillSpec>,
    ) -> Result<u64, SwapBookError> {
        maker.require_auth();

        if amount_in <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }

        let mut spent: i128 = 0;
        for i in 0..fills.len() {
            let spec = fills.get(i).unwrap();
            // Validate amounts BEFORE budget accounting — a negative
            // amount_out must never be able to shrink `spent`.
            if spec.fill_amount_in <= 0 || spec.amount_out <= 0 {
                return Err(SwapBookError::InvalidAmount);
            }
            let order: Order = Self::read_order(&env, spec.order_id)?;
            // Must be the reverse side of the pair being placed
            if order.token_in != token_out || order.token_out != token_in {
                return Err(SwapBookError::MatchWrongPair);
            }
            spent = spent
                .checked_add(spec.amount_out)
                .ok_or(SwapBookError::Overflow)?;
            if spent > amount_in {
                return Err(SwapBookError::MatchExceedsBudget);
            }
            Self::fill_inner(&env, maker.clone(), order, spec.fill_amount_in, spec.amount_out)?;
        }

        let remainder = amount_in - spent;
        if remainder > 0 {
            let order_id = Self::place_inner(
                &env, maker, token_in, token_out, remainder, min_amount_out,
                expiry, price_mode, max_slippage_bps, auto_route_after, excluded,
            )?;
            Ok(order_id)
        } else {
            Ok(0)
        }
    }

    /// Set the protocol fee (per 100,000 of the taker's payment). Admin
    /// only, hard-capped at MAX_FEE_PER_100K (0.5 bps) — the ceiling is
    /// compile-time; 0 is valid (fee holiday).
    pub fn set_fee(env: Env, fee_per_100k: i128) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        if !(0..=MAX_FEE_PER_100K).contains(&fee_per_100k) {
            return Err(SwapBookError::FeeAboveCap);
        }
        env.storage().instance().set(&DataKey::FeePer100k, &fee_per_100k);
        env.events().publish(
            (symbol_short!("book"), symbol_short!("fee")),
            fee_per_100k,
        );
        Ok(())
    }

    /// Current protocol fee as (numerator, denominator).
    pub fn get_fee(env: Env) -> (i128, i128) {
        (Self::fee_per_100k(&env), FEE_DENOMINATOR)
    }

    /// Set the max acceptable SEP-40 price age in seconds. Admin only.
    pub fn set_sep40_max_age(env: Env, max_age_secs: u64) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        env.storage().instance().set(&DataKey::Sep40MaxAge, &max_age_secs);
        env.events().publish(
            (symbol_short!("sep40"), symbol_short!("max_age")),
            max_age_secs,
        );
        Ok(())
    }

    /// Register a token's SEP-40 feed — the oracle contract to ask AND
    /// how the asset is keyed there. Admin only. The oracle's price
    /// decimals are read on-chain here and stored with the feed, so pairs
    /// whose tokens use DIFFERENT oracles still cross-rate correctly.
    /// Pairs where BOTH tokens have feeds price exclusively off SEP-40
    /// (fail closed); others keep the pushed price.
    /// `max_age_secs`: per-feed freshness bound; 0 = use the global
    /// Sep40MaxAge (set it per the provider's push cadence — e.g. ~600 for
    /// Reflector's 5-min updates, 86400+ for RedStone's 12-24h heartbeat).
    pub fn set_sep40_feed(
        env: Env,
        token: Address,
        oracle: Address,
        asset: OracleAsset,
        max_age_secs: u64,
    ) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        let oracle_decimals: u32 = env.invoke_contract(
            &oracle,
            &Symbol::new(&env, "decimals"),
            soroban_sdk::vec![&env],
        );
        let cfg = FeedConfig { oracle: oracle.clone(), asset, oracle_decimals, max_age_secs };
        env.storage()
            .persistent()
            .set(&DataKey::Sep40Feed(token.clone()), &cfg);
        env.storage().persistent().extend_ttl(
            &DataKey::Sep40Feed(token.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );
        env.events().publish(
            (symbol_short!("sep40"), symbol_short!("feed")),
            (token, oracle),
        );
        Ok(())
    }

    /// Remove a token's SEP-40 feed (pairs including it fall back to the
    /// pushed price). Admin only.
    pub fn remove_sep40_feed(env: Env, token: Address) -> Result<(), SwapBookError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);
        env.storage()
            .persistent()
            .remove(&DataKey::Sep40Feed(token.clone()));
        // Dropping a feed silently downgrades every pair containing the
        // token to the pushed price — observers must see it.
        env.events().publish(
            (symbol_short!("sep40"), symbol_short!("rm_feed")),
            token,
        );
        Ok(())
    }

    /// Permissionless TTL maintenance: extend the ledger entries of the
    /// given orders (and their pair indexes / maker counters) so a
    /// long-dated order never archives before its own expiry. Anyone may
    /// call; it moves no funds and changes no order state.
    pub fn bump_ttl(env: Env, order_ids: Vec<u64>) -> Result<(), SwapBookError> {
        for i in 0..order_ids.len() {
            let order_id = order_ids.get(i).unwrap();
            let order = Self::read_order(&env, order_id)?;
            let (threshold, extend_to) = Self::order_ttl_window(&env, &order);
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::Order(order_id), threshold, extend_to);
            let pair_key = DataKey::PairIndex(order.token_in.clone(), order.token_out.clone());
            if env.storage().persistent().has(&pair_key) {
                env.storage()
                    .persistent()
                    .extend_ttl(&pair_key, threshold, extend_to);
            }
            let count_key = DataKey::MakerPairCount(
                order.maker.clone(),
                order.token_in.clone(),
                order.token_out.clone(),
            );
            if env.storage().persistent().has(&count_key) {
                env.storage()
                    .persistent()
                    .extend_ttl(&count_key, threshold, extend_to);
            }
        }
        Self::bump_instance_ttl(&env);
        Ok(())
    }

    /// Cancel an open order. Only the maker can cancel.
    /// Returns escrowed tokens to the maker.
    pub fn cancel_order(env: Env, order_id: u64) -> Result<(), SwapBookError> {
        let mut order: Order = Self::read_order(&env, order_id)?;
        order.maker.require_auth();

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }

        let token_client = token::Client::new(&env, &order.token_in);
        token_client.transfer(
            &env.current_contract_address(),
            &order.maker,
            &order.amount_in_remaining,
        );

        order.status = OrderStatus::Cancelled;
        order.amount_in_remaining = 0;
        Self::write_order(&env, order_id, &order);
        Self::close_order_indexes(&env, &order);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("cancel"), order_id),
            (),
        );
        Ok(())
    }

    /// Permissionless cleanup: refund and close an order whose expiry has
    /// passed. Anyone may call (keeper-friendly); funds always go to the maker.
    pub fn expire_order(env: Env, order_id: u64) -> Result<(), SwapBookError> {
        let mut order: Order = Self::read_order(&env, order_id)?;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }
        if env.ledger().sequence() <= order.expiry {
            return Err(SwapBookError::OrderNotExpired);
        }

        if order.amount_in_remaining > 0 {
            let token_client = token::Client::new(&env, &order.token_in);
            token_client.transfer(
                &env.current_contract_address(),
                &order.maker,
                &order.amount_in_remaining,
            );
        }

        order.status = OrderStatus::Expired;
        order.amount_in_remaining = 0;
        Self::write_order(&env, order_id, &order);
        Self::close_order_indexes(&env, &order);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("expired"), order_id),
            (),
        );
        Ok(())
    }

    /// Fill an order completely. The taker provides `amount_out` of token_out,
    /// and receives the maker's escrowed token_in.
    pub fn fill_order(
        env: Env,
        taker: Address,
        order_id: u64,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        let order: Order = Self::read_order(&env, order_id)?;
        let remaining = order.amount_in_remaining;
        Self::fill_internal(&env, taker, order, remaining, amount_out)
    }

    /// Partially fill an order.
    ///
    /// `fill_amount_in` is the portion of the maker's token_in the taker wants.
    /// `amount_out` is what the taker pays in token_out.
    pub fn partial_fill(
        env: Env,
        taker: Address,
        order_id: u64,
        fill_amount_in: i128,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        let order: Order = Self::read_order(&env, order_id)?;
        Self::fill_internal(&env, taker, order, fill_amount_in, amount_out)
    }

    // ─── Query Functions ────────────────────────────────

    /// Get a specific order by ID.
    pub fn get_order(env: Env, order_id: u64) -> Result<Order, SwapBookError> {
        Self::read_order(&env, order_id)
    }

    /// Get all open order IDs for a token pair.
    pub fn get_orders(env: Env, token_in: Address, token_out: Address) -> Vec<u64> {
        let pair_key = DataKey::PairIndex(token_in, token_out);
        env.storage()
            .persistent()
            .get(&pair_key)
            .unwrap_or(Vec::new(&env))
    }

    /// Quote a fill from the TAKER's perspective.
    ///
    /// The taker wants to acquire `token_buy` and pay with `token_pay`.
    /// Scans orders where makers sell `token_buy` for `token_pay`
    /// (i.e. PairIndex(token_buy, token_pay)) and greedily computes how much
    /// `token_buy` the taker receives for spending up to `amount_pay`.
    ///
    /// Returns (amount_bought, amount_paid). `amount_paid` is the GROSS
    /// amount the taker must send — the maker's floor plus the protocol
    /// fee — so a quote passed straight to `partial_fill` is fillable.
    pub fn quote_fill(
        env: Env,
        token_buy: Address,
        token_pay: Address,
        amount_pay: i128,
    ) -> (i128, i128) {
        if amount_pay <= 0 {
            return (0, 0);
        }
        let order_ids = Self::get_orders(env.clone(), token_buy.clone(), token_pay.clone());
        let current_ledger = env.ledger().sequence();
        let mut budget = amount_pay;
        let mut bought: i128 = 0;

        for i in 0..order_ids.len() {
            if budget <= 0 {
                break;
            }
            let order_id = order_ids.get(i).unwrap();
            let order: Order = match env
                .storage()
                .persistent()
                .get(&DataKey::Order(order_id))
            {
                Some(o) => o,
                None => continue,
            };
            if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
                continue;
            }
            if current_ledger > order.expiry {
                continue;
            }

            // Max token_buy affordable from this order at its minimum price
            let (max_fill, _) = match Self::max_affordable_fill(&env, &order, budget) {
                Ok(v) => v,
                Err(_) => continue, // e.g. stale oracle — skip
            };
            if max_fill <= 0 {
                continue;
            }
            let pay = match Self::required_gross_payment(&env, &order, max_fill) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if pay > budget {
                continue;
            }
            bought += max_fill;
            budget -= pay;
        }

        (bought, amount_pay - budget)
    }

    // ─── Timer / Router Functions ──────────────────────

    /// Claim a timer-expired order. Only the authorized Router CONTRACT can
    /// call this (invoker auth). The escrowed tokens transfer to the router,
    /// which must — within the same invocation — execute the DEX route and
    /// pay the maker at least `min_out` of token_out.
    ///
    /// `min_out` is derived on-chain from the order's own price terms:
    ///   Fixed  → pro-rata min_amount_out over the remaining amount
    ///   Oracle → current fresh oracle fair value minus max_slippage_bps
    pub fn claim_expired_timer(env: Env, order_id: u64) -> Result<ClaimedOrder, SwapBookError> {
        let router: Address = env
            .storage()
            .instance()
            .get(&DataKey::Router)
            .ok_or(SwapBookError::RouterNotSet)?;
        router.require_auth();

        let mut order: Order = Self::read_order(&env, order_id)?;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }
        if order.auto_route_after == 0 {
            return Err(SwapBookError::TimerNotExpired);
        }
        if env.ledger().sequence() <= order.auto_route_after {
            return Err(SwapBookError::TimerNotExpired);
        }
        // Past its own expiry the maker's instruction has lapsed — the
        // order must be refunded via expire_order, never routed.
        if env.ledger().sequence() > order.expiry {
            return Err(SwapBookError::OrderExpired);
        }

        let remaining = order.amount_in_remaining;
        // The maker's price floor for the routed swap
        let min_out = Self::required_payment(&env, &order, remaining)?;

        let token_in_client = token::Client::new(&env, &order.token_in);
        token_in_client.transfer(&env.current_contract_address(), &router, &remaining);

        order.amount_in_remaining = 0;
        order.status = OrderStatus::Routed;
        Self::write_order(&env, order_id, &order);
        Self::close_order_indexes(&env, &order);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("claimed"), order_id),
            (router, remaining, min_out),
        );

        Ok(ClaimedOrder {
            order_id,
            maker: order.maker,
            token_in: order.token_in,
            token_out: order.token_out,
            amount: remaining,
            min_out,
        })
    }

    /// Get all orders whose auto_route_after timer has expired.
    pub fn get_expired_timer_orders(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Vec<u64> {
        let order_ids = Self::get_orders(env.clone(), token_in, token_out);
        let current_ledger = env.ledger().sequence();
        let mut expired = Vec::new(&env);

        for i in 0..order_ids.len() {
            let order_id = order_ids.get(i).unwrap();
            if let Some(order) = env
                .storage()
                .persistent()
                .get::<DataKey, Order>(&DataKey::Order(order_id))
            {
                if (order.status == OrderStatus::Open
                    || order.status == OrderStatus::PartialFill)
                    && order.auto_route_after > 0
                    && current_ledger > order.auto_route_after
                {
                    expired.push_back(order_id);
                }
            }
        }

        expired
    }

    /// Read the current oracle price for a pair. Enforces the same
    /// freshness bound as fills (ORACLE_STALE_LEDGERS for pushed prices;
    /// SEP-40 reads are age-checked at the source), so an external
    /// consumer (e.g. the RFQ settlement contract) can never act on a
    /// stale pushed price.
    pub fn get_oracle_price(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Result<(i128, i128, u32), SwapBookError> {
        let price = Self::read_oracle(&env, &token_in, &token_out)?;
        Self::check_oracle_fresh(&env, &price)?;
        Ok((price.num, price.den, price.updated_at))
    }

    // ─── Internal Helpers ───────────────────────────────

    fn require_admin(env: &Env) -> Result<(), SwapBookError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(SwapBookError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn read_order(env: &Env, order_id: u64) -> Result<Order, SwapBookError> {
        env.storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .ok_or(SwapBookError::OrderNotFound)
    }

    fn write_order(env: &Env, order_id: u64, order: &Order) {
        let key = DataKey::Order(order_id);
        env.storage().persistent().set(&key, order);
        let (threshold, extend_to) = Self::order_ttl_window(env, order);
        env.storage()
            .persistent()
            .extend_ttl(&key, threshold, extend_to);
    }

    /// (threshold, extend_to) for an order's ledger entries: the usual
    /// 30-day refresh, widened to cover the order's own expiry so a
    /// 90-day order never archives while still live. Capped at
    /// MAX_TTL_EXTEND_TO and at the network's max entry TTL. The threshold
    /// is raised alongside, so an entry that no longer covers its expiry
    /// is always re-extended, not skipped.
    fn order_ttl_window(env: &Env, order: &Order) -> (u32, u32) {
        let needed = order
            .expiry
            .saturating_sub(env.ledger().sequence())
            .saturating_add(1);
        let cap = MAX_TTL_EXTEND_TO.min(env.storage().max_ttl());
        let extend_to = TTL_EXTEND_TO.max(needed).min(cap);
        let threshold = TTL_THRESHOLD.max(needed).min(extend_to);
        (threshold, extend_to)
    }

    /// Keep the instance (admin, router, fee, next id, ...) alive.
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    /// Bookkeeping when an order leaves Open/PartialFill (filled to zero,
    /// cancelled, expired, routed): drop it from the pair index and
    /// release the maker's per-pair slot.
    fn close_order_indexes(env: &Env, order: &Order) {
        Self::remove_from_pair_index(env, &order.token_in, &order.token_out, order.id);
        let count_key = DataKey::MakerPairCount(
            order.maker.clone(),
            order.token_in.clone(),
            order.token_out.clone(),
        );
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if count <= 1 {
            env.storage().persistent().remove(&count_key);
        } else {
            env.storage().persistent().set(&count_key, &(count - 1));
            env.storage()
                .persistent()
                .extend_ttl(&count_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
    }

    /// Read the price for a directed pair. Precedence: when a SEP-40
    /// oracle is configured AND both tokens have registered feeds, the
    /// pair prices exclusively off SEP-40 (fail closed on missing/stale
    /// data — no silent fallback to the weaker pushed price). Pairs
    /// without full feed coverage use the pushed price as before.
    fn read_oracle(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
    ) -> Result<OraclePriceData, SwapBookError> {
        {
            let feed_in = Self::read_feed(env, token_in);
            let feed_out = Self::read_feed(env, token_out);
            if let (Some(feed_in), Some(feed_out)) = (feed_in, feed_out) {
                let p_in = Self::sep40_lastprice(env, &feed_in)?;
                let p_out = Self::sep40_lastprice(env, &feed_out)?;
                // Cross rate with TWO normalizations: the tokens' own
                // decimals (fair value maps token_in base units to
                // token_out base units), AND — since each feed may come
                // from a DIFFERENT oracle — each oracle's price decimals
                // (identical oracles cancel; mixed ones must not skew).
                let dec_in = token::Client::new(env, token_in).decimals();
                let dec_out = token::Client::new(env, token_out).decimals();
                // Cancel the shared power of ten BEFORE multiplying: an
                // 18-decimal token against a 14-decimal feed would need
                // p * 10^32, past i128 range. After cancellation only the
                // exponent DIFFERENCE remains (≤ ~17 across 7/8/18-dec
                // tokens and 8/14-dec oracles), which always fits.
                let e_num = dec_out + feed_out.oracle_decimals;
                let e_den = dec_in + feed_in.oracle_decimals;
                let common = if e_num < e_den { e_num } else { e_den };
                let num = p_in
                    .checked_mul(Self::pow10(e_num - common)?)
                    .ok_or(SwapBookError::Overflow)?;
                let den = p_out
                    .checked_mul(Self::pow10(e_den - common)?)
                    .ok_or(SwapBookError::Overflow)?;
                return Ok(OraclePriceData {
                    num,
                    den,
                    // Timestamp freshness was just enforced against
                    // max_age; the ledger-sequence staleness check is
                    // satisfied by construction for SEP-40 reads.
                    updated_at: env.ledger().sequence(),
                });
            }
        }
        let price_key = DataKey::OraclePrice(token_in.clone(), token_out.clone());
        let price: OraclePriceData = env
            .storage()
            .persistent()
            .get(&price_key)
            .ok_or(SwapBookError::OraclePriceNotSet)?;
        env.storage()
            .persistent()
            .extend_ttl(&price_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(price)
    }

    /// A token's SEP-40 feed config, keeping the entry alive on read.
    fn read_feed(env: &Env, token: &Address) -> Option<FeedConfig> {
        let key = DataKey::Sep40Feed(token.clone());
        let feed: Option<FeedConfig> = env.storage().persistent().get(&key);
        if feed.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        feed
    }

    /// Fetch one SEP-40 lastprice, enforcing positivity and max age.
    /// The feed's own max_age wins; 0 falls back to the global Sep40MaxAge.
    fn sep40_lastprice(
        env: &Env,
        feed: &FeedConfig,
    ) -> Result<i128, SwapBookError> {
        let max_age: u64 = if feed.max_age_secs > 0 {
            feed.max_age_secs
        } else {
            env.storage()
                .instance()
                .get(&DataKey::Sep40MaxAge)
                .ok_or(SwapBookError::OraclePriceNotSet)?
        };
        let price: Option<Sep40PriceData> = env.invoke_contract(
            &feed.oracle,
            &Symbol::new(env, "lastprice"),
            soroban_sdk::vec![env, feed.asset.clone().into_val(env)],
        );
        let price = price.ok_or(SwapBookError::OraclePriceNotSet)?;
        if price.price <= 0 {
            return Err(SwapBookError::InvalidPrice);
        }
        // Normalize feeds that report milliseconds
        let ts = if price.timestamp > SEP40_MS_THRESHOLD {
            price.timestamp / 1000
        } else {
            price.timestamp
        };
        let now = env.ledger().timestamp();
        if now.saturating_sub(ts) > max_age {
            return Err(SwapBookError::OraclePriceStale);
        }
        // A future-dated timestamp is as suspect as a stale one — a buggy
        // feed must not bypass the freshness gate by reporting ahead of
        // the ledger clock (small skew tolerated).
        if ts > now.saturating_add(SEP40_MAX_FUTURE_SKEW_SECS) {
            return Err(SwapBookError::OraclePriceStale);
        }
        Ok(price.price)
    }

    /// 10^exp as i128; rejects exponents that could not fit (token
    /// decimals above 38 are not representable).
    fn pow10(exp: u32) -> Result<i128, SwapBookError> {
        10i128.checked_pow(exp).ok_or(SwapBookError::Overflow)
    }

    fn check_oracle_fresh(env: &Env, price: &OraclePriceData) -> Result<(), SwapBookError> {
        if env.ledger().sequence() > price.updated_at + ORACLE_STALE_LEDGERS {
            return Err(SwapBookError::OraclePriceStale);
        }
        Ok(())
    }

    /// Shared fill path for full and partial fills (external entry —
    /// authenticates the taker, then delegates).
    fn fill_internal(
        env: &Env,
        taker: Address,
        order: Order,
        fill_amount_in: i128,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        taker.require_auth();
        Self::fill_inner(env, taker, order, fill_amount_in, amount_out)
    }

    /// Fill path after taker authentication (match_and_place authenticates
    /// the maker once and calls this directly for each planned fill).
    fn fill_inner(
        env: &Env,
        taker: Address,
        mut order: Order,
        fill_amount_in: i128,
        amount_out: i128,
    ) -> Result<(), SwapBookError> {
        let order_id = order.id;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartialFill {
            return Err(SwapBookError::OrderNotOpen);
        }
        if order.excluded.contains(&taker) {
            return Err(SwapBookError::ExcludedCounterparty);
        }
        if taker == order.maker {
            // Self-fills are pointless and would double-count events
            return Err(SwapBookError::ExcludedCounterparty);
        }
        if env.ledger().sequence() > order.expiry {
            return Err(SwapBookError::OrderExpired);
        }
        if fill_amount_in <= 0 || amount_out <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }
        if fill_amount_in > order.amount_in_remaining {
            return Err(SwapBookError::FillExceedsRemaining);
        }

        // ── Price validation: the maker's floor is NET of the protocol
        // fee. The fee comes out of the taker's payment, so the floor is
        // compared against what the maker actually receives — the taker
        // can never underpay the maker by the fee. ──
        // Fee rounds up (min 1 stroop) so no fill is fee-free
        let fee = Self::calculate_fee(env, amount_out);
        let maker_receives = amount_out - fee;
        let required_out = Self::required_payment(env, &order, fill_amount_in)?;
        if maker_receives < required_out {
            return Err(match order.price_mode {
                PriceMode::Fixed => SwapBookError::InsufficientOutput,
                PriceMode::Oracle => SwapBookError::OracleSlippageExceeded,
            });
        }
        // A fill so small the fee consumes the whole payment would strip
        // escrow while paying the maker nothing (reachable only when the
        // floor itself rounds to zero, e.g. a dust oracle fill).
        if maker_receives <= 0 {
            return Err(SwapBookError::InvalidAmount);
        }

        let token_out_client = token::Client::new(env, &order.token_out);
        token_out_client.transfer(&taker, &order.maker, &maker_receives);
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(SwapBookError::NotInitialized)?;
            token_out_client.transfer(&taker, &fee_vault, &fee);
        }

        let token_in_client = token::Client::new(env, &order.token_in);
        token_in_client.transfer(
            &env.current_contract_address(),
            &taker,
            &fill_amount_in,
        );

        order.amount_in_remaining -= fill_amount_in;
        if order.amount_in_remaining == 0 {
            order.status = OrderStatus::Filled;
            Self::close_order_indexes(env, &order);
        } else {
            order.status = OrderStatus::PartialFill;
        }
        Self::write_order(env, order_id, &order);

        env.events().publish(
            (symbol_short!("order"), symbol_short!("filled"), order_id),
            (taker, fill_amount_in, amount_out, fee),
        );
        Ok(())
    }

    /// The minimum token_out the MAKER must receive (net of protocol fee)
    /// for `fill_amount_in` of the order, per its pricing mode. Always
    /// rounds UP.
    fn required_payment(
        env: &Env,
        order: &Order,
        fill_amount_in: i128,
    ) -> Result<i128, SwapBookError> {
        match order.price_mode {
            PriceMode::Fixed => Ok(Self::muldiv_ceil(
                env,
                order.min_amount_out,
                fill_amount_in,
                order.amount_in,
            )),
            PriceMode::Oracle => {
                let price = Self::read_oracle(env, &order.token_in, &order.token_out)?;
                Self::check_oracle_fresh(env, &price)?;
                // fair value of the fill at the oracle price
                let fair = Self::muldiv_floor(env, fill_amount_in, price.num, price.den);
                // minimum acceptable = fair * (1 - slippage), rounded up
                let slippage = order.max_slippage_bps as i128;
                Ok(Self::muldiv_ceil(
                    env,
                    fair,
                    BPS_DENOMINATOR - slippage,
                    BPS_DENOMINATOR,
                ))
            }
        }
    }

    /// The GROSS token_out a taker must send so that, after the protocol
    /// fee is taken out, the maker still receives `required_payment`:
    /// the smallest g with g - ceil(g * fee / D) >= net, which is
    /// ceil(net * D / (D - fee)). This is what `quote_fill` reports and
    /// what `fill_inner` accepts.
    fn required_gross_payment(
        env: &Env,
        order: &Order,
        fill_amount_in: i128,
    ) -> Result<i128, SwapBookError> {
        let net = Self::required_payment(env, order, fill_amount_in)?;
        Ok(Self::gross_for_net(env, net))
    }

    fn gross_for_net(env: &Env, net: i128) -> i128 {
        let fee = Self::fee_per_100k(env);
        Self::muldiv_ceil(env, net, FEE_DENOMINATOR, FEE_DENOMINATOR - fee)
    }

    /// Given a taker budget of token_pay, the largest fill of the order's
    /// token_in that the budget can afford, fee included. Returns
    /// (fill_amount, gross_payment).
    fn max_affordable_fill(
        env: &Env,
        order: &Order,
        budget: i128,
    ) -> Result<(i128, i128), SwapBookError> {
        // Strip the fee from the budget, invert the price to estimate the
        // max fill, then verify with the exact (ceiling) gross payment and
        // step down if rounding pushed it over budget.
        let net_budget = Self::muldiv_floor(
            env,
            budget,
            FEE_DENOMINATOR - Self::fee_per_100k(env),
            FEE_DENOMINATOR,
        );
        let mut fill = match order.price_mode {
            PriceMode::Fixed => {
                Self::muldiv_floor(env, net_budget, order.amount_in, order.min_amount_out)
            }
            PriceMode::Oracle => {
                let price = Self::read_oracle(env, &order.token_in, &order.token_out)?;
                Self::check_oracle_fresh(env, &price)?;
                let slippage = order.max_slippage_bps as i128;
                // net_budget / (price * (1 - slippage))
                let fair = Self::muldiv_floor(
                    env,
                    net_budget,
                    BPS_DENOMINATOR,
                    BPS_DENOMINATOR - slippage,
                );
                Self::muldiv_floor(env, fair, price.den, price.num)
            }
        };
        if fill > order.amount_in_remaining {
            fill = order.amount_in_remaining;
        }
        while fill > 0 {
            let pay = Self::required_gross_payment(env, order, fill)?;
            if pay <= budget {
                return Ok((fill, pay));
            }
            fill -= 1;
        }
        Ok((0, 0))
    }

    fn fee_per_100k(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeePer100k)
            .unwrap_or(DEFAULT_FEE_PER_100K)
    }

    /// Protocol fee (≤ 0.5 bps, settable), rounded up — never zero for a
    /// nonzero amount unless the rate itself is zero.
    fn calculate_fee(env: &Env, amount: i128) -> i128 {
        Self::muldiv_ceil(env, amount, Self::fee_per_100k(env), FEE_DENOMINATOR)
    }

    /// floor(a * b / d) via 256-bit intermediate — no i128 overflow.
    fn muldiv_floor(env: &Env, a: i128, b: i128, d: i128) -> i128 {
        if d == 0 {
            panic_with_error!(env, SwapBookError::InvalidPrice);
        }
        let r = I256::from_i128(env, a)
            .mul(&I256::from_i128(env, b))
            .div(&I256::from_i128(env, d));
        match r.to_i128() {
            Some(v) => v,
            None => panic_with_error!(env, SwapBookError::Overflow),
        }
    }

    /// ceil(a * b / d) via 256-bit intermediate — no i128 overflow.
    /// Assumes non-negative operands (all amounts are validated > 0).
    fn muldiv_ceil(env: &Env, a: i128, b: i128, d: i128) -> i128 {
        if d == 0 {
            panic_with_error!(env, SwapBookError::InvalidPrice);
        }
        let num = I256::from_i128(env, a).mul(&I256::from_i128(env, b));
        let r = num
            .add(&I256::from_i128(env, d - 1))
            .div(&I256::from_i128(env, d));
        match r.to_i128() {
            Some(v) => v,
            None => panic_with_error!(env, SwapBookError::Overflow),
        }
    }

    /// Remove an order ID from the pair index.
    fn remove_from_pair_index(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
        order_id: u64,
    ) {
        let pair_key = DataKey::PairIndex(token_in.clone(), token_out.clone());
        if let Some(order_ids) = env
            .storage()
            .persistent()
            .get::<DataKey, Vec<u64>>(&pair_key)
        {
            let mut new_ids = Vec::new(env);
            for i in 0..order_ids.len() {
                let id = order_ids.get(i).unwrap();
                if id != order_id {
                    new_ids.push_back(id);
                }
            }
            env.storage().persistent().set(&pair_key, &new_ids);
            env.storage()
                .persistent()
                .extend_ttl(&pair_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
    }
}

#[cfg(test)]
mod test;

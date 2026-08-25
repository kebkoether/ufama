#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, Env, IntoVal, Symbol, Vec, I256,
};

/// Protocol fee per 100,000 of total output (rounded up). Admin-settable
/// via set_fee, hard-capped at 0.5 bps. DEFAULTS TO ZERO — instant swaps
/// are advertised as "venue fees only"; the cap exists so a fee could be
/// enabled later without exceeding what users can verify on-chain.
const MAX_FEE_PER_100K: i128 = 5;
const DEFAULT_FEE_PER_100K: i128 = 0;
const FEE_DENOMINATOR: i128 = 100_000;

/// Cap on the integrator partner fee: 1,000 per 100,000 = 100 bps = 1%.
/// Matches the backend's MAX_PARTNER_FEE_BPS for classic legs.
const MAX_PARTNER_FEE_PER_100K: i128 = 1_000;

/// Atomic multi-hop: maximum swaps in one execute_path invocation.
const MAX_PATH_HOPS: u32 = 5;
/// Weight denominator for splitting a hop across venues.
const WEIGHT_DENOMINATOR: i128 = 10_000;

// ─── Storage Keys ───────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    FeeVault,
    /// Map of venue_id -> adapter contract address
    Venue(u32),
    /// List of all registered venue IDs
    VenueIds,
    /// Address of the SwapBook contract
    SwapBook,
    /// Protocol fee numerator per FEE_DENOMINATOR (settable ≤ cap)
    FeePer100k,
}

// ─── Types ──────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct RouteSegment {
    /// Which venue to route through (ID from venue registry)
    pub venue_id: u32,
    /// Amount of token_in for this leg
    pub amount_in: i128,
    /// Minimum token_out expected from this leg
    pub min_amount_out: i128,
}

/// One venue's share of a single hop in an atomic path. Amounts are NOT
/// fixed by the caller — each hop swaps whatever the previous hop
/// actually delivered, split by weight (basis points of the carry; the
/// last leg takes the remainder so nothing is stranded by rounding).
/// This is what makes the path atomic-composable: no conservative
/// min-out chaining between hops, the real output flows through.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PathLeg {
    pub venue_id: u32,
    /// Share of this hop's input, in parts of 10,000
    pub weight_bps: i128,
    /// Per-leg minimum output (0 = rely on the final min)
    pub min_amount_out: i128,
}

/// One hop of an atomic path: swap the carried balance into `token_out`
/// across one or more venue legs.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PathHop {
    pub token_out: Address,
    pub legs: Vec<PathLeg>,
}

/// Mirror of SwapBook's ClaimedOrder (identical field names → identical XDR).
#[contracttype]
#[derive(Clone, Debug)]
pub struct ClaimedOrder {
    pub order_id: u64,
    pub maker: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount: i128,
    pub min_out: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    VenueNotFound = 4,
    VenueAlreadyRegistered = 5,
    InvalidRoute = 6,
    InsufficientOutput = 7,
    InvalidAmount = 8,
    RouteMismatch = 9,
    SameToken = 10,
    SwapBookNotSet = 11,
    FeeAboveCap = 12,
    PartnerFeeAboveCap = 13,
    PathTooLong = 14,
    InvalidPath = 15,
}

// ─── Contract ───────────────────────────────────────────
//
// Venue adapters are called via dynamic cross-contract invocation.
// Funds flow: the router PUSHES token_in to the adapter, then invokes
// `swap`; the adapter executes on its venue and pushes token_out back.
// (Direct transfers use invoker auth — no allowance juggling between
// our own contracts.)

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    /// Deploy-time constructor — atomic with deployment, cannot be front-run.
    pub fn __constructor(env: Env, admin: Address, fee_vault: Address, swap_book: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeVault, &fee_vault);
        env.storage().instance().set(&DataKey::SwapBook, &swap_book);
        env.storage()
            .instance()
            .set(&DataKey::VenueIds, &Vec::<u32>::new(&env));
    }

    /// Set the protocol fee (per 100,000 of total output). Admin only,
    /// hard-capped at MAX_FEE_PER_100K (0.5 bps); 0 is valid (fee holiday).
    pub fn set_fee(env: Env, fee_per_100k: i128) -> Result<(), RouterError> {
        Self::require_admin(&env)?;
        if !(0..=MAX_FEE_PER_100K).contains(&fee_per_100k) {
            return Err(RouterError::FeeAboveCap);
        }
        env.storage().instance().set(&DataKey::FeePer100k, &fee_per_100k);
        env.events().publish(
            (symbol_short!("route"), symbol_short!("fee")),
            fee_per_100k,
        );
        Ok(())
    }

    /// Current protocol fee as (numerator, denominator).
    pub fn get_fee(env: Env) -> (i128, i128) {
        (Self::fee_per_100k(&env), FEE_DENOMINATOR)
    }

    /// Register a new DEX venue adapter. Admin only.
    pub fn register_venue(
        env: Env,
        venue_id: u32,
        contract_address: Address,
    ) -> Result<(), RouterError> {
        Self::require_admin(&env)?;

        if env.storage().persistent().has(&DataKey::Venue(venue_id)) {
            return Err(RouterError::VenueAlreadyRegistered);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Venue(venue_id), &contract_address);

        let mut venue_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::VenueIds)
            .unwrap_or(Vec::new(&env));
        venue_ids.push_back(venue_id);
        env.storage().instance().set(&DataKey::VenueIds, &venue_ids);

        env.events().publish(
            (symbol_short!("venue"), symbol_short!("register")),
            (venue_id, contract_address),
        );
        Ok(())
    }

    /// Remove a venue. Admin only.
    pub fn remove_venue(env: Env, venue_id: u32) -> Result<(), RouterError> {
        Self::require_admin(&env)?;

        if !env.storage().persistent().has(&DataKey::Venue(venue_id)) {
            return Err(RouterError::VenueNotFound);
        }
        env.storage().persistent().remove(&DataKey::Venue(venue_id));

        let venue_ids: Vec<u32> = env
            .storage()
            .instance()
            .get(&DataKey::VenueIds)
            .unwrap_or(Vec::new(&env));
        let mut new_ids = Vec::new(&env);
        for i in 0..venue_ids.len() {
            let id = venue_ids.get(i).unwrap();
            if id != venue_id {
                new_ids.push_back(id);
            }
        }
        env.storage().instance().set(&DataKey::VenueIds, &new_ids);

        env.events().publish(
            (symbol_short!("venue"), symbol_short!("remove")),
            venue_id,
        );
        Ok(())
    }

    /// ATOMIC MULTI-HOP: execute a whole path (up to MAX_PATH_HOPS swaps,
    /// venues mixed freely per hop) in ONE invocation. One signature; if
    /// any hop disappoints, the entire path reverts and the user keeps
    /// exactly what they started with. Funds never rest in a wallet
    /// between hops, and each hop swaps the previous hop's ACTUAL output
    /// (no conservative min-out chaining as with multi-transaction plans).
    ///
    /// The protocol fee applies once, on the FINAL output, and
    /// `min_final_out` protects the user net of it.
    pub fn execute_path(
        env: Env,
        user: Address,
        token_in: Address,
        total_amount_in: i128,
        min_final_out: i128,
        hops: Vec<PathHop>,
    ) -> Result<i128, RouterError> {
        user.require_auth();

        if total_amount_in <= 0 || min_final_out <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        if hops.is_empty() {
            return Err(RouterError::InvalidPath);
        }
        if hops.len() > MAX_PATH_HOPS {
            return Err(RouterError::PathTooLong);
        }
        // Validate every hop before moving any funds
        let mut prev_token = token_in.clone();
        for i in 0..hops.len() {
            let hop = hops.get(i).unwrap();
            if hop.token_out == prev_token {
                return Err(RouterError::InvalidPath);
            }
            if hop.legs.is_empty() {
                return Err(RouterError::InvalidPath);
            }
            let mut weight_sum: i128 = 0;
            for j in 0..hop.legs.len() {
                let leg = hop.legs.get(j).unwrap();
                if leg.weight_bps <= 0 || leg.min_amount_out < 0 {
                    return Err(RouterError::InvalidPath);
                }
                weight_sum += leg.weight_bps;
            }
            if weight_sum != WEIGHT_DENOMINATOR {
                return Err(RouterError::InvalidPath);
            }
            prev_token = hop.token_out;
        }

        // Pull the input, then walk the chain
        token::Client::new(&env, &token_in).transfer(
            &user,
            env.current_contract_address(),
            &total_amount_in,
        );

        let mut carry_token = token_in.clone();
        let mut carry: i128 = total_amount_in;
        for i in 0..hops.len() {
            let hop = hops.get(i).unwrap();
            let carry_client = token::Client::new(&env, &carry_token);
            let mut hop_out: i128 = 0;
            let mut remaining = carry;
            for j in 0..hop.legs.len() {
                let leg = hop.legs.get(j).unwrap();
                // last leg takes the remainder — rounding strands nothing
                let leg_in = if j == hop.legs.len() - 1 {
                    remaining
                } else {
                    carry * leg.weight_bps / WEIGHT_DENOMINATOR
                };
                if leg_in <= 0 {
                    return Err(RouterError::InvalidAmount);
                }
                remaining -= leg_in;

                let venue: Address = env
                    .storage()
                    .persistent()
                    .get(&DataKey::Venue(leg.venue_id))
                    .ok_or(RouterError::VenueNotFound)?;
                carry_client.transfer(&env.current_contract_address(), &venue, &leg_in);
                let received: i128 = env.invoke_contract(
                    &venue,
                    &Symbol::new(&env, "swap"),
                    soroban_sdk::vec![
                        &env,
                        env.current_contract_address().into_val(&env),
                        carry_token.into_val(&env),
                        hop.token_out.into_val(&env),
                        leg_in.into_val(&env),
                        leg.min_amount_out.into_val(&env),
                    ],
                );
                if received < leg.min_amount_out {
                    return Err(RouterError::InsufficientOutput);
                }
                hop_out += received;
            }
            carry_token = hop.token_out.clone();
            carry = hop_out;
        }

        // Fee once, on the final output; user floor enforced net of it
        let fee = Self::calculate_fee(&env, carry);
        let user_receives = carry - fee;
        if user_receives < min_final_out {
            return Err(RouterError::InsufficientOutput);
        }
        let out_client = token::Client::new(&env, &carry_token);
        out_client.transfer(&env.current_contract_address(), &user, &user_receives);
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(RouterError::NotInitialized)?;
            out_client.transfer(&env.current_contract_address(), &fee_vault, &fee);
        }

        env.events().publish(
            (symbol_short!("route"), symbol_short!("path")),
            (user, token_in, carry_token, total_amount_in, user_receives, fee),
        );
        Ok(user_receives)
    }

    /// Execute a multi-venue routed swap for `user`.
    ///
    /// Verifies: segments are positive and sum to total_amount_in; every
    /// venue exists; net output (after the 0.5 bps protocol fee on the
    /// TOTAL output) meets min_total_out — otherwise the whole tx reverts.
    pub fn execute_route(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        total_amount_in: i128,
        min_total_out: i128,
        segments: Vec<RouteSegment>,
    ) -> Result<i128, RouterError> {
        Self::route_inner(
            &env, user, token_in, token_out, total_amount_in, min_total_out,
            segments, None,
        )
    }

    /// execute_route with an integrator partner fee carved from the
    /// output ON TOP of the protocol fee — the partner's cut never comes
    /// out of protocol revenue, and `min_total_out` protects the user
    /// net of BOTH fees. `partner_fee_per_100k` is capped at 100 bps.
    #[allow(clippy::too_many_arguments)]
    pub fn execute_route_partner(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        total_amount_in: i128,
        min_total_out: i128,
        segments: Vec<RouteSegment>,
        partner: Address,
        partner_fee_per_100k: i128,
    ) -> Result<i128, RouterError> {
        if !(0..=MAX_PARTNER_FEE_PER_100K).contains(&partner_fee_per_100k) {
            return Err(RouterError::PartnerFeeAboveCap);
        }
        Self::route_inner(
            &env, user, token_in, token_out, total_amount_in, min_total_out,
            segments, Some((partner, partner_fee_per_100k)),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn route_inner(
        env: &Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        total_amount_in: i128,
        min_total_out: i128,
        segments: Vec<RouteSegment>,
        partner: Option<(Address, i128)>,
    ) -> Result<i128, RouterError> {
        user.require_auth();

        if total_amount_in <= 0 || min_total_out <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        if token_in == token_out {
            return Err(RouterError::SameToken);
        }
        Self::validate_segments(&segments, total_amount_in)?;

        // Pull total token_in from user
        let token_in_client = token::Client::new(env, &token_in);
        token_in_client.transfer(&user, env.current_contract_address(), &total_amount_in);

        let total_out = Self::execute_segments(env, &token_in, &token_out, &segments)?;

        // Protocol fee on total output (rounded up), then the partner fee
        let fee = Self::calculate_fee(env, total_out);
        let partner_fee = match &partner {
            Some((_, per_100k)) if *per_100k > 0 => {
                Self::muldiv_ceil(env, total_out, *per_100k, FEE_DENOMINATOR)?
            }
            _ => 0,
        };
        let user_receives = total_out - fee - partner_fee;

        if user_receives < min_total_out {
            return Err(RouterError::InsufficientOutput);
        }

        let token_out_client = token::Client::new(env, &token_out);
        token_out_client.transfer(&env.current_contract_address(), &user, &user_receives);
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(RouterError::NotInitialized)?;
            token_out_client.transfer(&env.current_contract_address(), &fee_vault, &fee);
        }
        if partner_fee > 0 {
            let (partner_addr, _) = partner.as_ref().unwrap();
            token_out_client.transfer(&env.current_contract_address(), partner_addr, &partner_fee);
            env.events().publish(
                (symbol_short!("route"), symbol_short!("partner")),
                (partner_addr.clone(), partner_fee),
            );
        }

        env.events().publish(
            (symbol_short!("route"), symbol_short!("exec")),
            (user, token_in, token_out, total_amount_in, user_receives, fee),
        );
        Ok(user_receives)
    }

    /// Simple single-venue swap. Backend picks the best venue.
    pub fn swap(
        env: Env,
        user: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        venue_id: u32,
    ) -> Result<i128, RouterError> {
        let segment = RouteSegment {
            venue_id,
            amount_in,
            min_amount_out,
        };
        let segments = soroban_sdk::vec![&env, segment];
        Self::execute_route(
            env,
            user,
            token_in,
            token_out,
            amount_in,
            min_amount_out,
            segments,
        )
    }

    /// PERMISSIONLESS keeper entry point: route a timer-expired SwapBook
    /// order through DEX venues and settle the maker — all in one invocation.
    ///
    /// 1. Claims the order from SwapBook (escrow moves to this contract;
    ///    SwapBook authorizes us via invoker auth and returns the maker's
    ///    on-chain price floor `min_out`).
    /// 2. Executes the provided route segments.
    /// 3. Deducts the protocol fee, enforces net proceeds >= min_out,
    ///    and pays the maker.
    ///
    /// Anyone may call this — a caller gains nothing (proceeds always go to
    /// the maker) and a bad route simply reverts, leaving the order claimable
    /// again... (revert restores the order's Open state too).
    pub fn route_expired_order(
        env: Env,
        order_id: u64,
        segments: Vec<RouteSegment>,
    ) -> Result<i128, RouterError> {
        let swap_book: Address = env
            .storage()
            .instance()
            .get(&DataKey::SwapBook)
            .ok_or(RouterError::SwapBookNotSet)?;

        // Claim escrow + price floor from SwapBook (invoker auth)
        let claimed: ClaimedOrder = env.invoke_contract(
            &swap_book,
            &Symbol::new(&env, "claim_expired_timer"),
            soroban_sdk::vec![&env, order_id.into_val(&env)],
        );

        Self::validate_segments(&segments, claimed.amount)?;

        let total_out =
            Self::execute_segments(&env, &claimed.token_in, &claimed.token_out, &segments)?;

        let fee = Self::calculate_fee(&env, total_out);
        let maker_receives = total_out - fee;

        // The maker's own price terms are the floor — never settle below it.
        if maker_receives < claimed.min_out {
            return Err(RouterError::InsufficientOutput);
        }

        let token_out_client = token::Client::new(&env, &claimed.token_out);
        token_out_client.transfer(
            &env.current_contract_address(),
            &claimed.maker,
            &maker_receives,
        );
        if fee > 0 {
            let fee_vault: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeVault)
                .ok_or(RouterError::NotInitialized)?;
            token_out_client.transfer(&env.current_contract_address(), &fee_vault, &fee);
        }

        env.events().publish(
            (symbol_short!("route"), symbol_short!("timer"), order_id),
            (claimed.maker, claimed.amount, maker_receives, fee),
        );
        Ok(maker_receives)
    }

    // ─── Query Functions ────────────────────────────────

    /// Get the contract address for a venue.
    pub fn get_venue(env: Env, venue_id: u32) -> Result<Address, RouterError> {
        env.storage()
            .persistent()
            .get(&DataKey::Venue(venue_id))
            .ok_or(RouterError::VenueNotFound)
    }

    /// Get all registered venue IDs.
    pub fn get_venues(env: Env) -> Vec<u32> {
        env.storage()
            .instance()
            .get(&DataKey::VenueIds)
            .unwrap_or(Vec::new(&env))
    }

    // ─── Internal ───────────────────────────────────────

    fn validate_segments(
        segments: &Vec<RouteSegment>,
        total_amount_in: i128,
    ) -> Result<(), RouterError> {
        if segments.is_empty() {
            return Err(RouterError::InvalidRoute);
        }
        let mut segment_sum: i128 = 0;
        for i in 0..segments.len() {
            let seg = segments.get(i).unwrap();
            if seg.amount_in <= 0 || seg.min_amount_out < 0 {
                return Err(RouterError::InvalidAmount);
            }
            segment_sum += seg.amount_in;
        }
        if segment_sum != total_amount_in {
            return Err(RouterError::RouteMismatch);
        }
        Ok(())
    }

    /// Execute each leg: push token_in to the adapter, invoke its `swap`,
    /// sum the outputs the adapters push back.
    fn execute_segments(
        env: &Env,
        token_in: &Address,
        token_out: &Address,
        segments: &Vec<RouteSegment>,
    ) -> Result<i128, RouterError> {
        let token_in_client = token::Client::new(env, token_in);
        let mut total_out: i128 = 0;

        for i in 0..segments.len() {
            let seg = segments.get(i).unwrap();

            let venue_contract: Address = env
                .storage()
                .persistent()
                .get(&DataKey::Venue(seg.venue_id))
                .ok_or(RouterError::VenueNotFound)?;

            // Push this leg's input to the adapter (invoker auth — we are
            // the direct invoker of the token contract).
            token_in_client.transfer(
                &env.current_contract_address(),
                &venue_contract,
                &seg.amount_in,
            );

            // Adapter interface:
            // swap(recipient, token_in, token_out, amount_in, min_out) -> i128
            let amount_received: i128 = env.invoke_contract(
                &venue_contract,
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

            if amount_received < seg.min_amount_out {
                return Err(RouterError::InsufficientOutput);
            }
            total_out += amount_received;
        }

        Ok(total_out)
    }

    fn fee_per_100k(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::FeePer100k)
            .unwrap_or(DEFAULT_FEE_PER_100K)
    }

    /// Protocol fee (≤ 0.5 bps, settable), rounded up.
    fn calculate_fee(env: &Env, amount: i128) -> i128 {
        let num = Self::fee_per_100k(env);
        if amount <= 0 || num == 0 {
            return 0;
        }
        // 256-bit intermediate — parity with SwapBook's fee math
        Self::muldiv_ceil(env, amount, num, FEE_DENOMINATOR).unwrap_or(i128::MAX)
    }

    /// ceil(a * b / d) via 256-bit intermediate — no i128 overflow.
    fn muldiv_ceil(env: &Env, a: i128, b: i128, d: i128) -> Result<i128, RouterError> {
        let num = I256::from_i128(env, a).mul(&I256::from_i128(env, b));
        let r = num
            .add(&I256::from_i128(env, d - 1))
            .div(&I256::from_i128(env, d));
        r.to_i128().ok_or(RouterError::InvalidAmount)
    }

    fn require_admin(env: &Env) -> Result<(), RouterError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RouterError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }
}

#[cfg(test)]
mod test;

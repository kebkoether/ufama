#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contracterror as sdk_contracterror,
    contractimpl as sdk_contractimpl,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::StellarAssetClient, token::TokenClient, Address, Env, IntoVal,
};

// ─── Mock SwapBook: get_oracle_price(token_in, token_out) ───────────────

#[sdk_contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum MockBookError {
    OraclePriceNotSet = 11,
}

#[sdk_contract]
pub struct MockBook;

#[sdk_contractimpl]
impl MockBook {
    /// Price reported as fresh (updated_at = current ledger), like a
    /// SEP-40 read.
    pub fn set_price(env: Env, token_in: Address, token_out: Address, num: i128, den: i128) {
        env.storage()
            .instance()
            .set(&(token_in, token_out), &(num, den, 0u32));
    }
    /// Price with an explicit updated_at ledger, like the SwapBook's
    /// admin-pushed path (which returns the stored age unchecked).
    pub fn set_price_at(
        env: Env,
        token_in: Address,
        token_out: Address,
        num: i128,
        den: i128,
        updated_at: u32,
    ) {
        env.storage()
            .instance()
            .set(&(token_in, token_out), &(num, den, updated_at));
    }
    pub fn get_oracle_price(
        env: Env,
        token_in: Address,
        token_out: Address,
    ) -> Result<(i128, i128, u32), MockBookError> {
        let p: Option<(i128, i128, u32)> = env.storage().instance().get(&(token_in, token_out));
        match p {
            Some((num, den, 0)) => Ok((num, den, env.ledger().sequence())),
            Some((num, den, at)) => Ok((num, den, at)),
            None => Err(MockBookError::OraclePriceNotSet),
        }
    }
}

struct Ctx {
    env: Env,
    client: RfqSettleClient<'static>,
    book: MockBookClient<'static>,
    admin: Address,
    fee_vault: Address,
    maker: Address,
    taker: Address,
    /// 7-decimal "USDC"
    usdc: Address,
    /// 7-decimal "bond" (an RWA share)
    bond: Address,
}

const ONE: i128 = 10_000_000;

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 1_000;
        li.timestamp = 1_000;
    });
    let admin = Address::generate(&env);
    let fee_vault = Address::generate(&env);
    let maker = Address::generate(&env);
    let taker = Address::generate(&env);

    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let bond = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &usdc).mint(&taker, &(1_000_000 * ONE));
    StellarAssetClient::new(&env, &bond).mint(&maker, &(1_000_000 * ONE));

    let book_id = env.register(MockBook, ());
    let book = MockBookClient::new(&env, &book_id);
    // NAV: 1 bond = 10.5 USDC  →  USDC→bond price = 1/10.5
    book.set_price(&usdc, &bond, &ONE, &(105 * ONE / 10));

    let id = env.register(RfqSettle, (admin.clone(), fee_vault.clone(), book_id.clone()));
    let client = RfqSettleClient::new(&env, &id);
    Ctx {
        env,
        client,
        book,
        admin,
        fee_vault,
        maker,
        taker,
        usdc,
        bond,
    }
}

fn quote(c: &Ctx, amount_in: i128, amount_out: i128, band: u32) -> Quote {
    Quote {
        maker: c.maker.clone(),
        taker: c.taker.clone(),
        token_in: c.usdc.clone(),
        token_out: c.bond.clone(),
        amount_in,
        amount_out,
        expiry_ledger: c.env.ledger().sequence() + 60,
        nonce: 1,
        max_nav_dev_bps: band,
    }
}

fn bal(c: &Ctx, token: &Address, who: &Address) -> i128 {
    TokenClient::new(&c.env, token).balance(who)
}

#[test]
fn settles_both_legs_and_charges_fee_on_takers_payment() {
    let c = setup();
    // 1,050 USDC for 100 bonds — exactly NAV
    let q = quote(&c, 1_050 * ONE, 100 * ONE, 25);
    let fee = c.client.settle_quote(&q);
    // 0.5 bps of 1,050 USDC = 0.0525 USDC = 525_000 stroops
    assert_eq!(fee, 525_000);
    assert_eq!(bal(&c, &c.usdc, &c.maker), 1_050 * ONE - 525_000);
    assert_eq!(bal(&c, &c.usdc, &c.fee_vault), 525_000);
    assert_eq!(bal(&c, &c.usdc, &c.taker), 1_000_000 * ONE - 1_050 * ONE);
    assert_eq!(bal(&c, &c.bond, &c.taker), 100 * ONE);
    assert_eq!(bal(&c, &c.bond, &c.maker), 1_000_000 * ONE - 100 * ONE);
    assert!(c.client.is_used(&c.maker, &1));
}

#[test]
fn same_nonce_cannot_settle_twice() {
    let c = setup();
    let q = quote(&c, 1_050 * ONE, 100 * ONE, 0);
    c.client.settle_quote(&q);
    assert_eq!(
        c.client.try_settle_quote(&q),
        Err(Ok(RfqError::AlreadyUsed))
    );
    // a fresh nonce is a fresh quote
    let mut q2 = q.clone();
    q2.nonce = 2;
    c.client.settle_quote(&q2);
    assert_eq!(bal(&c, &c.bond, &c.taker), 200 * ONE);
}

#[test]
fn expired_and_too_far_quotes_are_refused() {
    let c = setup();
    let mut q = quote(&c, 1_050 * ONE, 100 * ONE, 0);
    q.expiry_ledger = c.env.ledger().sequence() - 1;
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::Expired)));
    q.expiry_ledger = c.env.ledger().sequence() + MAX_QUOTE_TTL_LEDGERS + 1;
    assert_eq!(
        c.client.try_settle_quote(&q),
        Err(Ok(RfqError::ExpiryTooFar))
    );
    // exactly at expiry still settles
    q.expiry_ledger = c.env.ledger().sequence();
    c.client.settle_quote(&q);
}

#[test]
fn nav_band_is_enforced_both_directions() {
    let c = setup();
    // NAV for 1,050 USDC is 100 bonds. 25 bps band = ±0.25 bonds.
    let inside = quote(&c, 1_050 * ONE, 100 * ONE - 2_000_000, 25); // -0.2 bond
    let chk = c.client.check_quote(&inside);
    assert_eq!(chk.fair_out, 100 * ONE);
    assert_eq!(chk.deviation_bps, 20);
    c.client.settle_quote(&inside);

    let mut too_little = quote(&c, 1_050 * ONE, 100 * ONE - 3_000_000, 25); // -0.3 bond
    too_little.nonce = 2;
    assert_eq!(
        c.client.try_settle_quote(&too_little),
        Err(Ok(RfqError::NavBandExceeded))
    );
    let mut too_much = quote(&c, 1_050 * ONE, 100 * ONE + 3_000_000, 25); // maker overpays
    too_much.nonce = 3;
    assert_eq!(
        c.client.try_check_quote(&too_much),
        Err(Ok(RfqError::NavBandExceeded))
    );
    // Negative deviation reported for a better-than-NAV quote inside the band
    let mut generous = quote(&c, 1_050 * ONE, 100 * ONE + 1_000_000, 25);
    generous.nonce = 4;
    assert_eq!(c.client.check_quote(&generous).deviation_bps, -10);
}

#[test]
fn band_zero_skips_the_oracle_and_missing_feed_fails_closed() {
    let c = setup();
    // Reverse direction has no feed in the mock book
    let mut q = quote(&c, 100 * ONE, 1_050 * ONE, 0);
    q.token_in = c.bond.clone();
    q.token_out = c.usdc.clone();
    StellarAssetClient::new(&c.env, &c.bond).mint(&c.taker, &(100 * ONE));
    StellarAssetClient::new(&c.env, &c.usdc).mint(&c.maker, &(1_050 * ONE));
    c.client.settle_quote(&q); // no band → no oracle read
    let mut banded = q.clone();
    banded.nonce = 2;
    banded.max_nav_dev_bps = 10;
    assert_eq!(
        c.client.try_settle_quote(&banded),
        Err(Ok(RfqError::OracleUnavailable))
    );
    assert_eq!(
        c.client.try_fair_value(&c.bond, &c.usdc, &ONE),
        Err(Ok(RfqError::OracleUnavailable))
    );
    assert_eq!(c.client.fair_value(&c.usdc, &c.bond, &(1_050 * ONE)), 100 * ONE);
}

#[test]
fn band_wider_than_cap_is_refused() {
    let c = setup();
    let q = quote(&c, 1_050 * ONE, 100 * ONE, MAX_NAV_BAND_BPS + 1);
    assert_eq!(
        c.client.try_settle_quote(&q),
        Err(Ok(RfqError::NavBandTooWide))
    );
}

#[test]
fn malformed_quotes_are_refused() {
    let c = setup();
    let mut q = quote(&c, 0, 100 * ONE, 0);
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::InvalidAmount)));
    q.amount_in = 1_050 * ONE;
    q.amount_out = 0;
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::InvalidAmount)));
    q.amount_out = 100 * ONE;
    q.token_out = c.usdc.clone();
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::SameToken)));
    q.token_out = c.bond.clone();
    q.taker = c.maker.clone();
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::SameParty)));
    // fee would consume the whole payment → maker gets nothing → refused
    let dust = quote(&c, 1, 1, 0);
    assert_eq!(c.client.try_settle_quote(&dust), Err(Ok(RfqError::InvalidAmount)));
}

#[test]
fn fee_is_capped_and_can_be_zeroed() {
    let c = setup();
    assert_eq!(c.client.get_fee(), (5, 100_000));
    assert_eq!(c.client.try_set_fee(&6), Err(Ok(RfqError::FeeAboveCap)));
    assert_eq!(c.client.try_set_fee(&-1), Err(Ok(RfqError::FeeAboveCap)));
    c.client.set_fee(&0);
    let q = quote(&c, 1_050 * ONE, 100 * ONE, 0);
    assert_eq!(c.client.settle_quote(&q), 0);
    assert_eq!(bal(&c, &c.usdc, &c.fee_vault), 0);
    assert_eq!(bal(&c, &c.usdc, &c.maker), 1_050 * ONE);
    c.client.set_fee(&5);
    let mut again = quote(&c, 1_050 * ONE, 100 * ONE, 0);
    again.nonce = 2;
    assert_eq!(c.client.check_quote(&again).fee, 525_000);
}

#[test]
fn admin_rotation_is_two_step_and_book_can_be_repointed() {
    let c = setup();
    let (admin, vault, _) = c.client.get_config();
    assert_eq!(admin, c.admin);
    assert_eq!(vault, c.fee_vault);
    assert_eq!(c.client.try_accept_admin(), Err(Ok(RfqError::NoPendingAdmin)));
    let new_admin = Address::generate(&c.env);
    c.client.transfer_admin(&new_admin);
    c.client.accept_admin();
    assert_eq!(c.client.get_config().0, new_admin);

    // Repoint to a book that prices the pair differently; fair value follows
    let other = c.env.register(MockBook, ());
    MockBookClient::new(&c.env, &other).set_price(&c.usdc, &c.bond, &ONE, &(10 * ONE));
    c.client.set_swap_book(&other);
    assert_eq!(c.client.fair_value(&c.usdc, &c.bond, &(1_000 * ONE)), 100 * ONE);
    let _ = &c.book;
}

#[test]
fn stale_pushed_price_is_refused_even_if_the_book_returns_it() {
    let c = setup();
    c.env.ledger().with_mut(|li| li.sequence_number = 10_000);
    let seq = c.env.ledger().sequence();
    let den = 105 * ONE / 10;
    // One ledger past the staleness window → refused everywhere
    c.book
        .set_price_at(&c.usdc, &c.bond, &ONE, &den, &(seq - ORACLE_STALE_LEDGERS - 1));
    let q = quote(&c, 1_050 * ONE, 100 * ONE, 25);
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::OracleStale)));
    assert_eq!(c.client.try_check_quote(&q), Err(Ok(RfqError::OracleStale)));
    assert_eq!(
        c.client.try_fair_value(&c.usdc, &c.bond, &ONE),
        Err(Ok(RfqError::OracleStale))
    );
    // A quote without a band never reads the oracle
    let mut unbanded = q.clone();
    unbanded.max_nav_dev_bps = 0;
    c.client.settle_quote(&unbanded);
    // Exactly at the window → still accepted
    c.book
        .set_price_at(&c.usdc, &c.bond, &ONE, &den, &(seq - ORACLE_STALE_LEDGERS));
    let mut fresh_enough = q.clone();
    fresh_enough.nonce = 2;
    c.client.settle_quote(&fresh_enough);
}

#[test]
fn maker_can_cancel_a_nonce_before_it_settles() {
    let c = setup();
    assert!(!c.client.is_used(&c.maker, &7));
    c.client.cancel_nonce(&c.maker, &7);
    assert!(c.client.is_used(&c.maker, &7));
    let mut q = quote(&c, 1_050 * ONE, 100 * ONE, 0);
    q.nonce = 7;
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::AlreadyUsed)));
    assert_eq!(c.client.try_check_quote(&q), Err(Ok(RfqError::AlreadyUsed)));
    assert_eq!(
        c.client.try_cancel_nonce(&c.maker, &7),
        Err(Ok(RfqError::AlreadyUsed))
    );
    // Other nonces and other makers are unaffected
    q.nonce = 8;
    c.client.settle_quote(&q);
    assert!(!c.client.is_used(&c.taker, &7));
}

#[test]
fn used_record_outlives_the_quote_it_settled() {
    let c = setup();
    let q = quote(&c, 1_050 * ONE, 100 * ONE, 0); // expires in 60 ledgers
    c.client.settle_quote(&q);
    // Well past the quote's own expiry, still inside USED_TTL_LEDGERS
    c.env.ledger().with_mut(|li| li.sequence_number += 5_000);
    assert!(c.client.is_used(&c.maker, &1));
    let mut again = quote(&c, 1_050 * ONE, 100 * ONE, 0); // fresh expiry, same nonce
    again.nonce = 1;
    assert_eq!(
        c.client.try_settle_quote(&again),
        Err(Ok(RfqError::AlreadyUsed))
    );
}

#[test]
fn overflow_is_reported_as_an_error_not_a_trap() {
    let c = setup();
    c.book.set_price(&c.usdc, &c.bond, &i128::MAX, &1);
    let q = quote(&c, i128::MAX / 2, 100 * ONE, 25);
    assert_eq!(
        c.client.try_fair_value(&c.usdc, &c.bond, &(i128::MAX / 2)),
        Err(Ok(RfqError::Overflow))
    );
    assert_eq!(c.client.try_check_quote(&q), Err(Ok(RfqError::Overflow)));
    assert_eq!(c.client.try_settle_quote(&q), Err(Ok(RfqError::Overflow)));
}

/// The maker's pre-signed entry authorizes exactly one tree:
/// settle_quote(q) → token_out.transfer(maker, taker, amount_out).
/// A different quote (here: more bonds for the same payment) must not
/// be satisfiable by that entry, and neither party's entry covers the
/// other's leg.
#[test]
fn maker_auth_entry_is_bound_to_the_exact_quote() {
    let c = setup();
    let q = quote(&c, 1_050 * ONE, 100 * ONE, 0);
    let fee: i128 = 525_000;
    let contract = c.client.address.clone();

    // Tampered quote: taker asks for 1 more bond than the maker signed.
    let mut tampered = q.clone();
    tampered.amount_out = 101 * ONE;

    // Maker signed over `q`...
    let maker_sub = [MockAuthInvoke {
        contract: &c.bond,
        fn_name: "transfer",
        args: (c.maker.clone(), c.taker.clone(), q.amount_out).into_val(&c.env),
        sub_invokes: &[],
    }];
    let maker_root = MockAuthInvoke {
        contract: &contract,
        fn_name: "settle_quote",
        args: (q.clone(),).into_val(&c.env),
        sub_invokes: &maker_sub,
    };
    // ...while the taker authorizes the tampered invocation.
    let taker_sub = [
        MockAuthInvoke {
            contract: &c.usdc,
            fn_name: "transfer",
            args: (c.taker.clone(), c.maker.clone(), tampered.amount_in - fee).into_val(&c.env),
            sub_invokes: &[],
        },
        MockAuthInvoke {
            contract: &c.usdc,
            fn_name: "transfer",
            args: (c.taker.clone(), c.fee_vault.clone(), fee).into_val(&c.env),
            sub_invokes: &[],
        },
    ];
    let taker_root_tampered = MockAuthInvoke {
        contract: &contract,
        fn_name: "settle_quote",
        args: (tampered.clone(),).into_val(&c.env),
        sub_invokes: &taker_sub,
    };
    c.env.mock_auths(&[
        MockAuth { address: &c.maker, invoke: &maker_root },
        MockAuth { address: &c.taker, invoke: &taker_root_tampered },
    ]);
    assert!(c.client.try_settle_quote(&tampered).is_err());
    assert_eq!(bal(&c, &c.bond, &c.taker), 0);

    // The genuine pair of entries settles.
    let taker_root = MockAuthInvoke {
        contract: &contract,
        fn_name: "settle_quote",
        args: (q.clone(),).into_val(&c.env),
        sub_invokes: &taker_sub,
    };
    c.env.mock_auths(&[
        MockAuth { address: &c.maker, invoke: &maker_root },
        MockAuth { address: &c.taker, invoke: &taker_root },
    ]);
    assert_eq!(c.client.settle_quote(&q), fee);
    assert_eq!(bal(&c, &c.bond, &c.taker), 100 * ONE);
}

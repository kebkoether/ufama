#![cfg(test)]

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Env, IntoVal,
};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let vault_id = env.register(FeeVault, (admin.clone(),));

    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    (env, vault_id, admin, token)
}

#[test]
fn test_balance_is_real_token_balance() {
    let (env, vault_id, _admin, token) = setup();
    let client = FeeVaultClient::new(&env, &vault_id);

    assert_eq!(client.get_balance(&token), 0);

    // Fees arrive as direct transfers (how SwapBook/Router pay them)
    StellarAssetClient::new(&env, &token).mint(&vault_id, &123_456);
    assert_eq!(client.get_balance(&token), 123_456);
}

#[test]
fn test_withdraw_up_to_balance() {
    let (env, vault_id, _admin, token) = setup();
    let client = FeeVaultClient::new(&env, &vault_id);
    let to = Address::generate(&env);

    StellarAssetClient::new(&env, &token).mint(&vault_id, &1_000_000);

    // Over-withdrawal rejected
    assert!(client.try_withdraw(&token, &1_000_001, &to).is_err());
    // Zero / negative rejected
    assert!(client.try_withdraw(&token, &0, &to).is_err());
    assert!(client.try_withdraw(&token, &-5, &to).is_err());

    client.withdraw(&token, &400_000, &to);
    assert_eq!(TokenClient::new(&env, &token).balance(&to), 400_000);
    assert_eq!(client.get_balance(&token), 600_000);

    // Full drain works — no shadow accounting to strand funds
    client.withdraw(&token, &600_000, &to);
    assert_eq!(client.get_balance(&token), 0);
}

#[test]
fn test_admin_two_step_rotation() {
    let (env, vault_id, admin, _token) = setup();
    let client = FeeVaultClient::new(&env, &vault_id);

    assert_eq!(client.get_admin(), admin);
    // Nothing pending: accept has nothing to do
    assert_eq!(client.try_accept_admin(), Err(Ok(FeeVaultError::NoPendingAdmin)));

    // Proposing does NOT hand over power yet
    let new_admin = Address::generate(&env);
    client.transfer_admin(&new_admin);
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                vault_id.clone(),
                (symbol_short!("admin"), symbol_short!("proposed")).into_val(&env),
                new_admin.clone().into_val(&env)
            )
        ]
    );
    assert_eq!(client.get_admin(), admin);

    // A mistyped proposal is recoverable: re-propose overrides it
    let typo = Address::generate(&env);
    client.transfer_admin(&typo);
    client.transfer_admin(&new_admin);

    // Acceptance needs the PENDING address's auth — the old admin alone
    // cannot complete it
    env.set_auths(&[]);
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &vault_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_accept_admin().is_err());
    assert_eq!(client.get_admin(), admin);

    env.mock_all_auths();
    client.accept_admin();
    assert_eq!(
        env.events().all(),
        soroban_sdk::vec![
            &env,
            (
                vault_id.clone(),
                (symbol_short!("admin"), symbol_short!("accepted")).into_val(&env),
                new_admin.clone().into_val(&env)
            )
        ]
    );
    assert_eq!(client.get_admin(), new_admin);

    // Consumed: a second accept has nothing pending
    assert_eq!(client.try_accept_admin(), Err(Ok(FeeVaultError::NoPendingAdmin)));
}

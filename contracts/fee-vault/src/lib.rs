#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, token, Address, Env,
};

// ─── Storage Keys ───────────────────────────────────────

/// Instance TTL management (ledgers): extend when below threshold, up to
/// target — same window as the SwapBook.
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days at 5s/ledger

#[contracttype]
pub enum DataKey {
    Admin,
    /// Two-step admin rotation: the proposed new admin, pending acceptance.
    PendingAdmin,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum FeeVaultError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InsufficientBalance = 4,
    InvalidAmount = 5,
    NoPendingAdmin = 6,
}

// ─── Contract ───────────────────────────────────────────
//
// Fee tokens are transferred directly to this contract's address by the
// SwapBook and Router contracts. The vault's balance IS the token balance —
// there is deliberately no shadow accounting to drift out of sync.

#[contract]
pub struct FeeVault;

#[contractimpl]
impl FeeVault {
    /// Deploy-time constructor — atomic with deployment, cannot be front-run.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Withdraw accumulated fees. Admin only.
    pub fn withdraw(
        env: Env,
        token: Address,
        amount: i128,
        to: Address,
    ) -> Result<(), FeeVaultError> {
        Self::require_admin(&env)?;
        Self::bump_instance_ttl(&env);

        if amount <= 0 {
            return Err(FeeVaultError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if amount > balance {
            return Err(FeeVaultError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (symbol_short!("fees"), symbol_short!("withdraw")),
            (token, amount, to),
        );
        Ok(())
    }

    /// Query the fee balance for a given token — the actual token balance
    /// held by this contract.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        let token_client = token::Client::new(&env, &token);
        token_client.balance(&env.current_contract_address())
    }

    /// Get the admin address.
    pub fn get_admin(env: Env) -> Result<Address, FeeVaultError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeVaultError::NotInitialized)
    }

    /// Propose a new admin (two-step rotation). Admin only. The proposed
    /// address must call `accept_admin` to take over, so a mistyped
    /// transfer is recoverable until accepted — the vault's withdraw key
    /// is never handed to an address that has not proven it is live.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), FeeVaultError> {
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

    /// Complete an admin rotation — callable only by the proposed admin.
    pub fn accept_admin(env: Env) -> Result<(), FeeVaultError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(FeeVaultError::NoPendingAdmin)?;
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

    // ─── Internal ───────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), FeeVaultError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeVaultError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    /// Keep the instance (admin, pending admin) alive.
    fn bump_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;

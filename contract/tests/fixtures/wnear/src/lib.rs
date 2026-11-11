use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestWrap {
    token: FungibleToken,
    withdraw_fails: bool,
}

#[near]
impl TestWrap {
    #[init]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(b"w".to_vec()), withdraw_fails: false }
    }

    pub fn set_withdraw_fails(&mut self, fails: bool) {
        self.withdraw_fails = fails;
    }

    pub fn register(&mut self, account_id: AccountId) {
        if self.token.accounts.get(&account_id).is_none() {
            self.token.internal_register_account(&account_id);
        }
    }

    #[payable]
    pub fn near_deposit(&mut self) {
        let account = env::predecessor_account_id();
        self.token.internal_deposit(&account, env::attached_deposit().as_yoctonear());
    }

    #[payable]
    pub fn near_withdraw(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        assert!(!self.withdraw_fails, "forced_withdraw_failure");
        let account = env::predecessor_account_id();
        self.token.internal_withdraw(&account, amount.0);
        Promise::new(account).transfer(NearToken::from_yoctonear(amount.0))
    }
}

#[allow(deprecated)]
near_contract_standards::impl_fungible_token_core!(TestWrap, token);

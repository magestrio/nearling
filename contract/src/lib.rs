use near_sdk::{AccountId, PanicOnDefault, near};

/// The contract's state. Init holds only the owner: no game state exists before the first change.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::accounts;

    #[test]
    fn new_stores_the_owner() {
        let contract = Contract::new(accounts(1));
        assert_eq!(contract.owner_id(), accounts(1));
        assert_eq!(contract.version(), "0.1.0");
    }
}

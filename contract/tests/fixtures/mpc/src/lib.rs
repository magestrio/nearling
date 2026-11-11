use near_sdk::{PanicOnDefault, env, near};
use near_sdk::serde_json::{Value, json};

/// The current MPC sign wire shape, with deterministic dummy responses for sandbox tests.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    fail_sign: bool,
    last_request: Option<String>,
}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self { fail_sign: false, last_request: None }
    }

    pub fn set_fail_sign(&mut self, fail_sign: bool) {
        self.fail_sign = fail_sign;
    }

    pub fn last_request(&self) -> Option<Value> {
        self.last_request.as_ref().map(|request| near_sdk::serde_json::from_str(request).expect("saved JSON"))
    }

    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        assert_eq!(env::attached_deposit().as_yoctonear(), 1, "sign_deposit");
        assert!(!self.fail_sign, "forced_sign_failure");
        let domain = request["domain_id"].as_u64().expect("domain_id");
        let path = request["path"].as_str().expect("path");
        let expected = if domain == 0 { "base:" } else { "solana:" };
        assert!(path.starts_with(expected), "wrong_path");
        let variant = if domain == 0 { "Ecdsa" } else { "Eddsa" };
        assert!(request["payload_v2"][variant].as_str().is_some(), "payload_v2");
        self.last_request = Some(request.to_string());
        if domain == 0 {
            json!({"scheme":"Secp256k1", "big_r":{"affine_point":"02"},
                "s":{"scalar":"00"}, "recovery_id":0})
        } else {
            json!({"scheme":"Ed25519", "signature": vec![0u8; 64]})
        }
    }
}

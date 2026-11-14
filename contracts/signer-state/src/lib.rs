//! MooPay signer state.
//!
//! The TEE signer keeps each user's passkeys, strict mode, lock flag and daily totals here, so the host that runs the
//! enclave cannot roll its disk back to an older state and reset a limit. The signer reads a user's entry before every
//! signature and writes the new one before it signs.
//!
//! The contract is deliberately dumb: it stores an opaque string per user and checks who is writing and that the
//! writer saw the latest version. All rules live in the signer, whose code hash is approved on chain by the key service.
//! Only the signer's account can write; only governance can replace the signer (for example when the enclave moves).
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const MAX_STATE: usize = 8 * 1024;
const MAX_USER: usize = 64;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Users,
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct Entry {
    /// Starts at 1 on the first write and goes up by one on every write.
    pub version: u64,
    pub state: String,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct SignerState {
    governance: AccountId,
    signer: AccountId,
    users: LookupMap<String, Entry>,
}

#[near]
impl SignerState {
    #[init]
    pub fn new(governance: AccountId, signer: AccountId) -> Self {
        Self { governance, signer, users: LookupMap::new(Key::Users) }
    }

    pub fn get(&self, user: String) -> Option<Entry> {
        self.users.get(&user).cloned()
    }

    pub fn signer(&self) -> AccountId {
        self.signer.clone()
    }

    pub fn governance(&self) -> AccountId {
        self.governance.clone()
    }

    /// Signer only. `expected_version` is the version the signer last read (0 when there is none), so two writers cannot
    /// overwrite each other and an old copy cannot replace a newer one.
    pub fn set(&mut self, user: String, state: String, expected_version: u64) -> u64 {
        require!(env::predecessor_account_id() == self.signer, "only the signer can write");
        require!(!user.is_empty() && user.len() <= MAX_USER, "bad user id");
        require!(state.len() <= MAX_STATE, "state is too large");
        let current = self.users.get(&user).map(|e| e.version).unwrap_or(0);
        require!(current == expected_version, "stale version: read the latest state first");
        let next = current + 1;
        self.users.insert(user.clone(), Entry { version: next, state });
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"moopay-signer-state\",\"event\":\"set\",\"user\":\"{}\",\"version\":{}}}", user, next));
        next
    }

    /// Governance only: point the contract at a new signer account (for example after the enclave is replaced).
    pub fn set_signer(&mut self, signer: AccountId) {
        require!(env::predecessor_account_id() == self.governance, "only governance");
        env::log_str(&format!("EVENT_JSON:{{\"standard\":\"moopay-signer-state\",\"event\":\"signer\",\"signer\":\"{}\"}}", signer));
        self.signer = signer;
    }

    /// Governance only: hand governance to another account, such as a multisig. Nothing here can undo a wrong address.
    pub fn set_governance(&mut self, governance: AccountId) {
        require!(env::predecessor_account_id() == self.governance, "only governance");
        self.governance = governance;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn as_caller(who: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acct(who)).build());
    }
    fn fresh() -> SignerState {
        as_caller("gov.near");
        SignerState::new(acct("gov.near"), acct("signer.near"))
    }

    #[test]
    fn signer_writes_and_versions_go_up() {
        let mut c = fresh();
        as_caller("signer.near");
        assert!(c.get("alice".into()).is_none());
        assert_eq!(c.set("alice".into(), "a".into(), 0), 1);
        assert_eq!(c.set("alice".into(), "b".into(), 1), 2);
        let e = c.get("alice".into()).unwrap();
        assert_eq!((e.version, e.state.as_str()), (2, "b"));
        assert!(c.get("bob".into()).is_none(), "users are separate");
    }

    #[test]
    #[should_panic(expected = "only the signer can write")]
    fn nobody_else_can_write() {
        let mut c = fresh();
        as_caller("mallory.near");
        c.set("alice".into(), "x".into(), 0);
    }

    #[test]
    #[should_panic(expected = "only the signer can write")]
    fn not_even_governance_can_write_state() {
        let mut c = fresh();
        as_caller("gov.near");
        c.set("alice".into(), "x".into(), 0);
    }

    #[test]
    #[should_panic(expected = "stale version")]
    fn an_old_copy_cannot_replace_a_newer_one() {
        let mut c = fresh();
        as_caller("signer.near");
        c.set("alice".into(), "a".into(), 0);
        c.set("alice".into(), "b".into(), 1);
        c.set("alice".into(), "rolled back".into(), 1);
    }

    #[test]
    #[should_panic(expected = "stale version")]
    fn the_first_write_must_expect_version_zero() {
        let mut c = fresh();
        as_caller("signer.near");
        c.set("alice".into(), "x".into(), 5);
    }

    #[test]
    #[should_panic(expected = "state is too large")]
    fn state_size_is_capped() {
        let mut c = fresh();
        as_caller("signer.near");
        c.set("alice".into(), "x".repeat(MAX_STATE + 1), 0);
    }

    #[test]
    #[should_panic(expected = "bad user id")]
    fn user_ids_are_bounded() {
        let mut c = fresh();
        as_caller("signer.near");
        c.set("u".repeat(MAX_USER + 1), "x".into(), 0);
    }

    #[test]
    fn only_governance_can_replace_the_signer_and_the_old_one_stops_working() {
        let mut c = fresh();
        as_caller("gov.near");
        c.set_signer(acct("signer2.near"));
        assert_eq!(c.signer(), acct("signer2.near"));
        as_caller("signer2.near");
        assert_eq!(c.set("alice".into(), "x".into(), 0), 1);
    }

    #[test]
    #[should_panic(expected = "only governance")]
    fn the_signer_cannot_replace_itself() {
        let mut c = fresh();
        as_caller("signer.near");
        c.set_signer(acct("signer.near"));
    }

    #[test]
    #[should_panic(expected = "only the signer can write")]
    fn the_replaced_signer_is_locked_out() {
        let mut c = fresh();
        as_caller("gov.near");
        c.set_signer(acct("signer2.near"));
        as_caller("signer.near");
        c.set("alice".into(), "x".into(), 0);
    }

    #[test]
    fn governance_can_move_to_a_multisig() {
        let mut c = fresh();
        as_caller("gov.near");
        c.set_governance(acct("safe.near"));
        assert_eq!(c.governance(), acct("safe.near"));
    }
}

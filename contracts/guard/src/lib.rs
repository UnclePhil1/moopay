//! MooPay Guard: the spending rules, enforced by the chain instead of by a server.
//!
//! The idea. The agent's server holds a key. If that server is breached, the thief gets the key. So the key is not allowed
//! to move money directly. It may only call this contract, and this contract refuses anything outside the rules:
//!
//!   * only allowlisted tokens (and NEAR),
//!   * at most `per_tx` in one payment,
//!   * at most `per_day` in any rolling 24 hours (queued payments count too),
//!   * a payment to a receiver the owner has not trusted, or above `hold_above`, waits `hold` before it can go out,
//!     and the owner can cancel it from their own wallet in that time.
//!
//! The owner is the user's own wallet. Only the owner can change limits, trust receivers, cancel, or withdraw. The agent can
//! only ask for transfers. A breached agent key therefore loses at most `per_day` per token, and the owner has the hold
//! window to notice and cancel anything unusual.
//!
//! Limits are in each token's smallest unit, set by the owner. They are not in dollars: a contract cannot read a price
//! without trusting an oracle, and a guard should not depend on one. For stablecoins the units are dollars.
//!
//! Not audited. Not yet used by the MooPay server. See README.md in this folder.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const DAY_NS: u64 = 86_400_000_000_000;
const MINUTE_NS: u64 = 60_000_000_000;
/// Rolling-window entries kept. Bounded so one call can never run out of gas walking the list.
const MAX_WINDOW: usize = 200;
const MAX_QUEUE: u64 = 100;
const FT_GAS: Gas = Gas::from_tgas(30);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// The key used for native NEAR in limits and in the window.
const NEAR: &str = "near";

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// What the agent may do with one token. All amounts are in the token's smallest unit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limit {
    pub per_tx: U128,
    pub per_day: U128,
    /// A payment above this waits out the hold even to a trusted receiver.
    pub hold_above: U128,
}

/// A payment that went out, kept for 24 hours so the rolling total can be worked out.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Outflow {
    pub at: u64,
    pub token: String,
    pub amount: U128,
}

/// A payment waiting out its hold.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub token: String,
    pub receiver: AccountId,
    pub amount: U128,
    pub release_at: u64,
    pub why: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    agent: AccountId,
    hold_ns: u64,
    limits: IterableMap<String, Limit>,
    trusted: LookupSet<AccountId>,
    window: Vec<Outflow>,
    queue: IterableMap<u64, Pending>,
    next_id: u64,
}

#[near]
impl Guard {
    /// `owner` is the user's own wallet. `agent` is the account whose limited key the MooPay server holds.
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, hold_minutes: u64) -> Self {
        require!(owner != agent, "the owner and the agent must be different accounts");
        require!(hold_minutes <= 24 * 60, "a hold can be at most 24 hours");
        Self { owner, agent, hold_ns: hold_minutes * MINUTE_NS, limits: IterableMap::new(b"l".to_vec()), trusted: LookupSet::new(b"t".to_vec()), window: Vec::new(), queue: IterableMap::new(b"q".to_vec()), next_id: 0 }
    }

    /* ---- the agent's one door ---- */

    /// Ask to send `amount` of `token` (an FT contract id, or "near") to `receiver`.
    /// Returns None when it was sent now, or the id of the queued payment when it must wait.
    pub fn transfer(&mut self, token: String, receiver: AccountId, amount: U128) -> Option<u64> {
        let who = env::predecessor_account_id();
        require!(who == self.agent || who == self.owner, "only the agent or the owner can send");
        require!(receiver != env::current_account_id(), "cannot send to the guard itself");
        let limit = self.limit_of(&token);
        let now = env::block_timestamp();
        self.prune(now);
        require!(amount.0 > 0, "the amount must be above zero");
        require!(amount.0 <= limit.per_tx.0, "above the limit for one payment");
        require!(self.used(&token, None).saturating_add(amount.0) <= limit.per_day.0, "this would pass the 24 hour limit");
        let new_receiver = !self.trusted.contains(&receiver);
        let big = amount.0 > limit.hold_above.0;
        // the owner is the user themselves, so their own request never waits
        if who != self.owner && self.hold_ns > 0 && (new_receiver || big) {
            require!(self.queue.len() < MAX_QUEUE as u32, "too many payments are waiting");
            let id = self.next_id;
            self.next_id += 1;
            let why = if new_receiver { "new receiver" } else { "large payment" };
            self.queue.insert(id, Pending { token, receiver, amount, release_at: now + self.hold_ns, why: why.to_string() });
            return Some(id);
        }
        self.send(&token, receiver, amount.0, now);
        None
    }

    /// Sends a queued payment once its hold is over. Anyone may call it, so a payment is never stuck if the server is down,
    /// and nobody, including the agent, can release it early.
    pub fn release(&mut self, id: u64) {
        let p = self.queue.get(&id).unwrap_or_else(|| env::panic_str("no such waiting payment")).clone();
        let now = env::block_timestamp();
        require!(now >= p.release_at, "this payment is still on hold");
        self.prune(now);
        let limit = self.limit_of(&p.token);
        // the 24 hour limit is checked again: other payments may have used it up while this one waited
        require!(self.used(&p.token, Some(id)).saturating_add(p.amount.0) <= limit.per_day.0, "this would pass the 24 hour limit");
        self.queue.remove(&id);
        self.send(&p.token, p.receiver, p.amount.0, now);
    }

    /* ---- the owner's controls ---- */

    /// Stops a waiting payment. This is the "that wasn't me" button: the owner signs it from their own wallet.
    pub fn cancel(&mut self, id: u64) {
        self.only_owner();
        require!(self.queue.remove(&id).is_some(), "no such waiting payment");
    }

    /// Allow a token (or "near") with its limits, or change them.
    pub fn set_limit(&mut self, token: String, per_tx: U128, per_day: U128, hold_above: U128) {
        self.only_owner();
        require!(per_tx.0 <= per_day.0, "one payment cannot be above the daily limit");
        if token != NEAR { let _: AccountId = token.parse().unwrap_or_else(|_| env::panic_str("not a valid token account")); }
        self.limits.insert(token, Limit { per_tx, per_day, hold_above });
    }

    pub fn remove_limit(&mut self, token: String) {
        self.only_owner();
        self.limits.remove(&token);
    }

    pub fn trust(&mut self, receiver: AccountId) {
        self.only_owner();
        self.trusted.insert(receiver);
    }

    pub fn untrust(&mut self, receiver: AccountId) {
        self.only_owner();
        self.trusted.remove(&receiver);
    }

    /// Swap the agent's account, for example after its key leaked. Waiting payments stay waiting.
    pub fn set_agent(&mut self, agent: AccountId) {
        self.only_owner();
        require!(agent != self.owner, "the owner and the agent must be different accounts");
        self.agent = agent;
    }

    pub fn set_hold_minutes(&mut self, minutes: u64) {
        self.only_owner();
        require!(minutes <= 24 * 60, "a hold can be at most 24 hours");
        self.hold_ns = minutes * MINUTE_NS;
    }

    /// Take money out, to the owner. Always works, with no limits and no hold: the money is the owner's.
    pub fn withdraw(&mut self, token: String, amount: U128) -> Promise {
        self.only_owner();
        self.pay(&token, self.owner.clone(), amount.0)
    }

    /* ---- views ---- */

    pub fn config(&self) -> (AccountId, AccountId, u64) { (self.owner.clone(), self.agent.clone(), self.hold_ns / MINUTE_NS) }
    pub fn limit(&self, token: String) -> Option<Limit> { self.limits.get(&token).cloned() }
    pub fn is_trusted(&self, receiver: AccountId) -> bool { self.trusted.contains(&receiver) }
    pub fn waiting(&self) -> Vec<(u64, Pending)> { self.queue.iter().map(|(k, v)| (*k, v.clone())).collect() }
    /// What has gone out (or is waiting to) in the last 24 hours, for one token.
    pub fn used_24h(&self, token: String) -> U128 {
        let now = env::block_timestamp();
        let sent: u128 = self.window.iter().filter(|o| o.token == token && now.saturating_sub(o.at) < DAY_NS).map(|o| o.amount.0).sum();
        U128(sent.saturating_add(self.queued(&token, None)))
    }
}

/* ---- inside ---- */
impl Guard {
    fn only_owner(&self) { require!(env::predecessor_account_id() == self.owner, "only the owner can do this"); }
    fn limit_of(&self, token: &str) -> Limit { self.limits.get(token).unwrap_or_else(|| env::panic_str("this token is not allowed")).clone() }
    fn prune(&mut self, now: u64) { self.window.retain(|o| now.saturating_sub(o.at) < DAY_NS); }
    fn queued(&self, token: &str, except: Option<u64>) -> u128 {
        self.queue.iter().filter(|(k, p)| p.token == token && Some(**k) != except).map(|(_, p)| p.amount.0).fold(0u128, |a, b| a.saturating_add(b))
    }
    /// Sent in the window, plus waiting, for one token.
    fn used(&self, token: &str, except: Option<u64>) -> u128 {
        let sent: u128 = self.window.iter().filter(|o| o.token == token).map(|o| o.amount.0).fold(0u128, |a, b| a.saturating_add(b));
        sent.saturating_add(self.queued(token, except))
    }
    fn send(&mut self, token: &str, receiver: AccountId, amount: u128, now: u64) {
        require!(self.window.len() < MAX_WINDOW, "too many payments in the last 24 hours");
        self.window.push(Outflow { at: now, token: token.to_string(), amount: U128(amount) });
        let _ = self.pay(token, receiver, amount);
    }
    fn pay(&self, token: &str, receiver: AccountId, amount: u128) -> Promise {
        if token == NEAR {
            Promise::new(receiver).transfer(NearToken::from_yoctonear(amount))
        } else {
            let ft: AccountId = token.parse().unwrap_or_else(|_| env::panic_str("not a valid token account"));
            ext_ft::ext(ft).with_attached_deposit(ONE_YOCTO).with_static_gas(FT_GAS).ft_transfer(receiver, U128(amount), None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const HOLD: u64 = 15;
    const USDC: &str = "usdc.token.near";
    fn owner() -> AccountId { accounts(0) }
    fn agent() -> AccountId { accounts(1) }
    fn bob() -> AccountId { accounts(2) }
    fn eve() -> AccountId { accounts(3) }
    fn at(who: AccountId, t: u64) { testing_env!(VMContextBuilder::new().current_account_id(accounts(4)).predecessor_account_id(who).block_timestamp(t).build()); }
    /// $10 per payment, $25 a day, anything above $5 waits. USDC has 6 decimals.
    fn guard() -> Guard {
        at(owner(), 1);
        let mut g = Guard::new(owner(), agent(), HOLD);
        g.set_limit(USDC.into(), U128(10_000_000), U128(25_000_000), U128(5_000_000));
        g
    }
    fn usd(n: u128) -> U128 { U128(n * 1_000_000) }

    #[test]
    fn a_trusted_receiver_gets_small_payments_at_once() {
        let mut g = guard(); g.trust(bob());
        at(agent(), 10);
        assert_eq!(g.transfer(USDC.into(), bob(), usd(3)), None);
        assert_eq!(g.used_24h(USDC.into()), usd(3));
    }

    #[test]
    #[should_panic(expected = "above the limit for one payment")]
    fn one_payment_cannot_pass_the_per_payment_limit() {
        let mut g = guard(); g.trust(bob());
        at(agent(), 10);
        g.transfer(USDC.into(), bob(), usd(11));
    }

    #[test]
    #[should_panic(expected = "this token is not allowed")]
    fn a_token_that_was_not_allowed_is_refused() {
        let mut g = guard();
        at(agent(), 10);
        g.transfer("scam.token.near".into(), bob(), usd(1));
    }

    #[test]
    #[should_panic(expected = "only the agent or the owner can send")]
    fn a_stranger_cannot_ask_for_a_transfer() {
        let mut g = guard();
        at(eve(), 10);
        g.transfer(USDC.into(), bob(), usd(1));
    }

    #[test]
    fn the_daily_limit_rolls_and_frees_up_after_24_hours() {
        let mut g = guard(); g.trust(bob());
        at(agent(), 10);
        g.transfer(USDC.into(), bob(), usd(5)); g.transfer(USDC.into(), bob(), usd(5)); g.transfer(USDC.into(), bob(), usd(5));
        g.transfer(USDC.into(), bob(), usd(5)); g.transfer(USDC.into(), bob(), usd(5));
        assert_eq!(g.used_24h(USDC.into()), usd(25));
        at(agent(), 10 + DAY_NS + 1);
        assert_eq!(g.used_24h(USDC.into()), usd(0), "a day later the window is empty");
        assert_eq!(g.transfer(USDC.into(), bob(), usd(5)), None);
    }

    #[test]
    #[should_panic(expected = "this would pass the 24 hour limit")]
    fn the_sixth_payment_in_a_day_is_refused() {
        let mut g = guard(); g.trust(bob());
        at(agent(), 10);
        for _ in 0..5 { g.transfer(USDC.into(), bob(), usd(5)); }
        g.transfer(USDC.into(), bob(), usd(1));
    }

    #[test]
    fn a_new_receiver_waits_and_the_wait_cannot_be_skipped() {
        let mut g = guard();
        at(agent(), 100);
        let id = g.transfer(USDC.into(), bob(), usd(2)).expect("queued");
        assert_eq!(g.waiting().len(), 1);
        assert_eq!(g.waiting()[0].1.why, "new receiver");
        assert_eq!(g.used_24h(USDC.into()), usd(2), "waiting money already counts against the day");
        at(eve(), 100 + HOLD * MINUTE_NS);
        g.release(id);
        assert_eq!(g.waiting().len(), 0);
        assert_eq!(g.used_24h(USDC.into()), usd(2));
    }

    #[test]
    #[should_panic(expected = "still on hold")]
    fn the_wait_cannot_be_skipped_even_by_the_agent() {
        let mut g = guard();
        at(agent(), 100);
        let id = g.transfer(USDC.into(), bob(), usd(2)).unwrap();
        at(agent(), 100 + (HOLD - 1) * MINUTE_NS);
        g.release(id);
    }

    #[test]
    fn a_large_payment_to_a_trusted_receiver_also_waits() {
        let mut g = guard(); g.trust(bob());
        at(agent(), 10);
        assert!(g.transfer(USDC.into(), bob(), usd(6)).is_some());
    }

    #[test]
    fn only_the_owner_can_cancel_and_a_cancelled_payment_frees_the_limit() {
        let mut g = guard();
        at(agent(), 100);
        let id = g.transfer(USDC.into(), bob(), usd(9)).unwrap();
        assert_eq!(g.used_24h(USDC.into()), usd(9));
        at(owner(), 200);
        g.cancel(id);
        assert_eq!(g.waiting().len(), 0);
        assert_eq!(g.used_24h(USDC.into()), usd(0));
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn the_agent_cannot_cancel_raise_limits_or_trust_anyone() {
        let mut g = guard();
        at(agent(), 100);
        g.set_limit(USDC.into(), usd(1000), usd(1000), usd(1000));
    }

    #[test]
    #[should_panic(expected = "only the owner can do this")]
    fn the_agent_cannot_trust_its_own_receiver() {
        let mut g = guard();
        at(agent(), 100);
        g.trust(eve());
    }

    #[test]
    fn the_owner_is_never_held_up_and_can_swap_the_agent() {
        let mut g = guard();
        at(owner(), 100);
        assert_eq!(g.transfer(USDC.into(), bob(), usd(2)), None, "the owner's own payment goes at once");
        g.set_agent(eve());
        assert_eq!(g.config().1, eve());
    }

    #[test]
    #[should_panic(expected = "only the agent or the owner can send")]
    fn a_swapped_out_agent_can_no_longer_send() {
        let mut g = guard();
        at(owner(), 100);
        g.set_agent(eve());
        at(agent(), 101);
        g.transfer(USDC.into(), bob(), usd(1));
    }

    #[test]
    fn a_stalled_payment_is_rechecked_against_the_day_when_it_is_released() {
        let mut g = guard(); g.trust(bob());
        at(agent(), 100);
        let id = g.transfer(USDC.into(), eve(), usd(5)).unwrap(); // waits (new receiver)
        for _ in 0..4 { g.transfer(USDC.into(), bob(), usd(5)); } // $20 now out, $5 waiting: the day is full
        at(eve(), 100 + HOLD * MINUTE_NS);
        g.release(id);
        assert_eq!(g.used_24h(USDC.into()), usd(25));
    }
}

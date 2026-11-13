# MooPay Guard (NEAR contract)

A spending guard that the chain enforces, so the rules still hold if the agent's server is breached.

**Status: written and unit tested, not deployed, not audited, and not used by the MooPay server yet.** Today the same rules are enforced by the server (`src/agent/policy.ts`). This contract is the next step: move enforcement on chain.

## How it would be used

1. The user deploys the guard on an account they control and funds it. The owner is their own wallet.
2. The MooPay server holds a limited key for the `agent` account. That key can only call `transfer` on the guard. It cannot withdraw, change limits or trust receivers.
3. A stolen server key can lose at most `per_day` per token, and only after the hold.

## Rules it enforces

| Rule | Detail |
| --- | --- |
| Allowed tokens | Only tokens the owner added with `set_limit` (and `"near"`). |
| Per payment | `amount <= per_tx`. |
| Rolling 24 hours | Sent plus waiting payments never pass `per_day`. Checked again at release. |
| Hold | A new receiver, or an amount above `hold_above`, waits the hold (default 15 minutes). |
| Cancel | Only the owner can cancel a waiting payment. Anyone can release it after the wait, nobody before. |
| Owner only | Limits, trusted receivers, agent swap, hold time, cancel, withdraw. |

Limits are in each token's smallest unit, not dollars. A contract cannot read a price without trusting an oracle, so for stablecoins the units are dollars and for other tokens the owner sets a number.

## Not covered

- No price oracle, so no dollar caps on volatile tokens.
- If the `ft_transfer` call fails after it was counted, the amount stays counted for the day. That errs on the safe side.
- Gas for the agent's calls comes from the agent account.
- No audit. Do not hold real money in it before one.

## Test

```bash
cargo test
```

Build for NEAR (needs `rustup target add wasm32-unknown-unknown`):

```bash
cargo build --target wasm32-unknown-unknown --release
```

The dependency versions are pinned in `Cargo.toml` and `Cargo.lock` because the newest `near-sdk` needs a newer Rust than 1.92.

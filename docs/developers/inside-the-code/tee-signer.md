# TEE signer: design and build plan

Status: in progress. Nothing here is live. The live app still derives wallet keys on the MooPay server (`Store.keyOf`).

## Problem

`Store.keyOf(u)` derives each user's NEAR key from a server seed and hands the raw `secretKey` to about 30 call sites (`ops.ts`, `claims.ts`, `near.ts`, two routes). Anyone who controls the server, or its `SEED_KEY` secret, can sign for every user without a passkey.

## Target

A small signer service runs inside a Phala Cloud TEE (Intel TDX) with Phala's on-chain key service on Base.

- The enclave's root key comes from `getKey()` and is released only to code whose compose hash is approved on chain by the contract owner (a multisig, later with a timelock).
- Each user's NEAR key is derived inside the enclave from that root key and the user id. It never leaves the enclave, except in the sealed recovery export below.
- The MooPay server stops holding keys. It sends the signer an unsigned transaction and gets back a signature or a refusal.

## Signer API

| Call | Input | Output |
| --- | --- | --- |
| `pubkey` | user id | NEAR public key and implicit account id |
| `sign` | user id, unsigned transaction, passkey assertion when required | signature, or a refusal with the reason |
| `register-passkey` | user id, WebAuthn credential | stored public key |
| `export-sealed` | user id, passkey assertion, recovery-code salt | the wallet key sealed to the recovery code |
| `attest` | nonce | TDX quote and event log, so anyone can verify the code |

The signer decodes the transaction itself (receiver, action, amount, token contract) and checks it against the user's rules before signing. It never trusts a description from the server.

## What the signer enforces

Three layers, in order:

1. **Allowlist.** Only the transaction kinds MooPay uses: NEAR transfer, `ft_transfer`, `near_deposit`, `near_withdraw`, staking calls, `storage_deposit`. Adding keys, deploying code, deleting accounts and any other call are refused.
2. **Hard caps.** Per asset, in the asset's smallest unit: one cap per payment and one per day (UTC), whatever signature is attached. The signer has no price feed, so it cannot enforce dollar limits itself; the server's dollar rules stay as the first check. An asset with no cap is refused. Attached NEAR on a contract call counts as NEAR leaving.
3. **The unattended allowance and the passkey.** A small per-asset allowance may be signed with no passkey. It is the whole allowance for an account without a passkey, and it covers scheduled runs. Anything above it, and every payment when the user has turned on strict mode, needs a passkey signature for that exact payment.

### What a passkey signature covers

The challenge is `sha256("moopay.pay.v1|user|nonce|payment text")`. The nonce is one-time and issued by the signer, and the payment text lists each outflow as method, asset, amount and recipient. The browser builds the same text from the card it shows, so the fingerprint signs what the user saw. A signature for one payment is refused for a different amount, a different recipient, another user's wallet, or a second use. The same construction (`moopay.action.v1`) covers adding a passkey, turning strict mode on or off, and unlocking.

### First passkey and the waiting period

The first passkey on an account is trust-on-first-use: whoever registers it first owns the account's protection. To blunt a thief who registers one, it only counts after a waiting period (24 hours by default), and until then the account stays on the small allowance. Once any passkey exists, adding another needs a signature from one of them, even during the waiting period. Locking is always allowed; unlocking needs the passkey.

### What a passkey does not prove

A passkey proves the owner's device approved a payment, not that the owner read it. If an attacker controls the MooPay server and also serves a modified approval page, the page can show one payment and have the user sign another. Hosting the approval page from a source the server cannot change (a pinned static build) is a follow-up.

## State

The signer's disk can be rolled back by the host operator, so rules and counters cannot live only on it.

- Passkey public keys and counters, strict mode, the lock flag and today's totals (all payments, and the part sent with no passkey) are kept in a small NEAR contract, `contracts/signer-state`. The existing `contracts/guard` is a different design (it holds funds and limits an agent), so it is not used for this.
- The contract stores one opaque string per user with a version. Only the signer's writer account can write, and a write must name the version it last read.
- For every call the signer reads the user's record fresh, then, **before it signs**, writes the new totals. If the write fails or the version is stale, nothing is signed. A restart, a rolled-back disk or a lagging RPC therefore cannot hand back a spent limit.
- Calls for one user run one at a time, so payments sent together cannot both slip under the daily cap.
- The contract does not enforce limits itself, because signing happens off chain. The limits are enforced by the signer's code, which the on-chain key service only releases the key to when its hash is approved.
- Cost: about 0.01 to 0.02 NEAR of storage per user, held by the contract account, and one small transaction per signature from the signer's writer account.
- If the chain cannot be reached, the signer refuses to sign. That is the safe failure, and it means NEAR RPC outages stop payments.

## Known limits

- One enclave, not MPC. Trust is placed in Intel TDX and the Phala host.
- The contract owner can approve any code hash. Ownership must move to a multisig, then a timelock.
- Existing wallets use server-derived keys. Moving them means sending funds to new enclave-derived addresses.
- If Phala is down, signing is down. The sealed recovery export is the way out.

## Build order

1. Map every place the server uses `secretKey` (done: `keyOf` plus `near.ts` call sites).
2. Add a `Signer` interface to `NearOps` so write calls take a key reference instead of a raw secret.
3. Build the signer service and its tests with a local stand-in for the dstack socket. (Done: `src/signer/`, with tests in `tests/unit/signer.test.ts`. Not deployed.)
4. Passkey verification, strict mode, lock and the unattended allowance inside the signer. (Done, with tests. State is in memory until step 5.)
5. Anchor passkeys and limits on chain. (Done: `contracts/signer-state` and `src/signer/state.ts`, tested against an in-memory store and a fake reader. Not deployed, so the real write path has not run against a chain.)
6. Build the image in CI and pin it by digest. Deploy with on-chain KMS.
7. Prove unapproved code gets no key.
8. Migrate existing wallets.
9. Move contract ownership to a Safe.

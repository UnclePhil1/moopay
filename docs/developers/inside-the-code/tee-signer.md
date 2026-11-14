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

1. Only the transaction kinds MooPay uses: NEAR transfer, `ft_transfer`, `near_deposit`, `near_withdraw`, staking calls, `storage_deposit`.
2. Limits per asset, in the asset's smallest unit: one cap per payment and one per day (UTC). The signer has no price feed, so it cannot enforce dollar limits itself; the server's dollar rules stay as the first check, and the signer's caps are the hard ceiling behind them. An asset with no cap is refused. Attached NEAR on a contract call counts as NEAR leaving. The new-recipient limit and payout-wallet rule come with the passkey step.
3. A WebAuthn assertion bound to the exact transaction hash for anything that needs approval.
4. A lower daily cap for accounts without a passkey.
5. A lock flag that refuses everything until the passkey unlocks it.

## State

The signer's disk can be rolled back by the host operator, so rules and counters cannot live only on it.

- Passkey public keys, limits, daily totals and the lock flag are anchored in the NEAR guard contract (`contracts/guard`).
- The signer reads them before every signature and writes the new totals after.
- If it cannot reach the contract, it refuses to sign.

## Known limits

- One enclave, not MPC. Trust is placed in Intel TDX and the Phala host.
- The contract owner can approve any code hash. Ownership must move to a multisig, then a timelock.
- Existing wallets use server-derived keys. Moving them means sending funds to new enclave-derived addresses.
- If Phala is down, signing is down. The sealed recovery export is the way out.

## Build order

1. Map every place the server uses `secretKey` (done: `keyOf` plus `near.ts` call sites).
2. Add a `Signer` interface to `NearOps` so write calls take a key reference instead of a raw secret.
3. Build the signer service and its tests with a local stand-in for the dstack socket. (Done: `src/signer/`, with tests in `tests/unit/signer.test.ts`. Not deployed.)
4. Passkey verification and rules inside the signer.
5. Anchor passkeys and limits in `contracts/guard`.
6. Build the image in CI and pin it by digest. Deploy with on-chain KMS.
7. Prove unapproved code gets no key.
8. Migrate existing wallets.
9. Move contract ownership to a Safe.

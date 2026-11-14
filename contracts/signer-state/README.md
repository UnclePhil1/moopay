# MooPay signer state (NEAR contract)

The on-chain record for the TEE signer (`src/signer/`). It keeps each user's passkeys, strict-mode flag, lock flag and today's totals, so the host that runs the enclave cannot roll the enclave's disk back and reset a limit.

**Status: written and unit tested (11 tests), builds to wasm. Not deployed, not audited, not used by the live app yet.**

## What it does

- Stores one opaque string per user, with a version number.
- Only the signer account can write. A write must name the version the signer last read, so an old copy cannot replace a newer one and two writers cannot overwrite each other.
- Only governance can replace the signer account (for example when the enclave is replaced) or hand governance on. Governance cannot write state.

All rules live in the signer, whose code hash the key service approves on chain. The contract only keeps the record and checks who is writing. It does not enforce the limits itself: signing happens off chain, so the signer reads the record before every signature and writes it **before** it signs.

## Cost

Each user's entry is about 1 to 2 KB, which locks roughly 0.01 to 0.02 NEAR of the contract account's balance for storage. Every signature costs one small transaction paid by the signer's writer account (a fraction of a cent of gas).

## Set up

1. Deploy the wasm to an account you control, and call `new({ governance, signer })`. `governance` should be a multisig. `signer` is the writer account the signer prints at start (`[signer] state writer account: ...`).
2. Send that writer account a little NEAR for gas.
3. Start the signer with `SIGNER_STATE_CONTRACT` set to the contract account. It refuses to start without it.

## Test and build

```bash
cargo test --offline
cargo build --offline --target wasm32-unknown-unknown --release
```

The dependency versions are pinned in `Cargo.toml` and `Cargo.lock` (the same as `contracts/guard`).

# Tornado Nova (and Privacy Cash) — architecture guide

Sources: `tornadocash/tornado-pool-relayer` (NestJS), `Privacy-Cash/privacy-cash` (Anchor program + circom).
Privacy Cash states its SDK follows a UTXO model inspired by Tornado Nova; the shared `extData` shape
below shows the same lineage. Read from source, not executed.

## Model
Arbitrary-amount shielded pool using UTXOs. Each transaction is a 2-input / 2-output JoinSplit:
spend up to two notes, create up to two notes, with a public amount (deposit > 0, withdraw < 0, transfer = 0).

## Commitment / nullifier (Privacy Cash circuit `transaction.circom`)
```
commitment = Poseidon(amount, pubKey, blinding, mintAddress)
nullifier  = hash(commitment, merklePath, sign(privKey, commitment, merklePath))
```
Circuit instance: `Transaction(26, 2, 2)` — Merkle depth 26, 2 in, 2 out.
Public inputs: `root, publicAmount, extDataHash, inputNullifier[2], outputCommitment[2]`.

## Transaction objects
Nova relayer (`src/types/index.ts`):
```ts
ExtData  { recipient, relayer, fee, extAmount, encryptedOutput1, encryptedOutput2 }
ArgsProof{ proof, root, inputNullifiers[], outputCommitments[], publicAmount, extDataHash }
Job      { extData, args, status, txHash?, confirmations?, failedReason? }
```
Privacy Cash Solana program (`lib.rs`):
```rust
Proof   { proof_a[64], proof_b[128], proof_c[64], root, public_amount, ext_data_hash,
          input_nullifiers[2], output_commitments[2] }
ExtData { recipient, ext_amount: i64, fee: u64, fee_recipient, mint_address }
transact(proof, ext_data_minified, encrypted_output1, encrypted_output2)   // + transact_spl
CommitmentData { index, commitment, encrypted_output }
```
`extDataHash` binds recipient/fee/relayer to the proof, same idea as Classic's public inputs.
`encryptedOutput*` lets the receiver rediscover their note by scanning events.

## Nova relayer HTTP
- `POST /transaction` body `{ "body": "<JSON string of {extData,args}>" }` → returns job id.
- `GET /job/:jobId`, `GET /status`, `GET /`.
- Chains: mainnet (1) and Gnosis (100).
- Privacy Cash has no relayer HTTP API in the repo; the signer pays gas and `fee_recipient` is an on-chain field.

## What to borrow for MooPay
- `extData` with fee + recipient bound by a hash (`extDataHash`) — do the same: hash(recipient, chain, asset, amount, fee) goes into the commitment or claim message.
- Encrypted-output-per-note so a receiver can find their claim without the server knowing who they are.
- Variable amounts via public amount sign convention.
- Single-use nullifier set to prevent double-claim.

## Limits
A 2-in/2-out circuit and depth-26 tree are heavy for a hackathon. MooPay's SHA256 hash-lock is a
simplification: no hiding of amounts or linkage on-chain unless the escrow itself is shielded.

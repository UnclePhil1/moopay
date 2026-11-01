# Tornado Cash Classic — architecture guide

Sources: docs.gitbook (Core Deposit Circuit, How to become a relayer), `tornadocash/tornado-relayer` (archived).
Everything here was read from docs/source; none of it was executed.

## Model
Fixed-denomination pools. A deposit adds one commitment to a Merkle tree. A withdrawal proves
knowledge of a leaf preimage without revealing which leaf, and burns a nullifier to stop double-spend.

## Note and commitment
```
nullifier = random 31 bytes
secret    = random 31 bytes
commitment    = PedersenHash(nullifier || secret)        // 62-byte preimage, Baby Jubjub point, 32-byte BE int
nullifierHash = PedersenHash(nullifier)
leaf          = MiMC(commitment)                         // what is inserted in the tree
```
The user keeps (nullifier, secret) as the "note". Losing it = losing the funds.

## Tree
- Binary, depth 20 (2^20 leaves), BN128 field, MiMC node hash.
- Zero leaf = `keccak256("tornado") mod p`.
- Contract keeps the last 100 roots; a withdrawal may prove against any of them.

## Withdraw proof (Groth16)
Public (6): `root, nullifierHash, recipient, relayer, fee, refund`
Private: `nullifier, secret, pathElements[], pathIndices[]`
`recipient/relayer/fee/refund` are public inputs so a relayer cannot change them after the proof is made.

## Relayer (HTTP)
| Route | Purpose |
|---|---|
| `POST /v1/tornadoWithdraw` (alias `POST /relay`) | submit withdraw, returns `{id}` |
| `GET /v1/jobs/:id` | poll job status |
| `GET /v1/status`, `GET /` | health / fee info |
| `POST /v1/miningReward`, `/v1/miningWithdraw` | anonymity-mining (skip) |

Withdraw body (validated with Ajv, `src/modules/validator.js`):
```json
{ "proof": "0x…(512 hex)",
  "contract": "0x…pool address (must be known)",
  "args": ["root","nullifierHash","recipient","relayer","fee","refund"] }
```
`root/nullifierHash/fee/refund` are 0x + 64 hex; `relayer` must be an address the relayer controls.

Relayer economics: protocol fee 0.3% of the withdrawal, taken from relayer-staked TORN; relayers are
discovered by ENS TXT records (`mainnet-tornado.<name>.eth`).

## What to borrow for MooPay
- The "note = random secret, commitment published, secret revealed once to claim" lifecycle.
- Binding recipient + fee into the proof/commitment so a relayer/solver cannot redirect funds.
- Job-id pattern for relayers: POST returns `{id}`, client polls.
- Root history window so claims don't fail when the tree moves.

## What not to copy
Pedersen/MiMC and the Groth16 circuit are the part a plain SHA256 hash-lock does not give you.

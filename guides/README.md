# MooPay guides — index

Read-only reference for building MooPay. See `../PROMPT.md` for the build prompt.

## Protocol architecture (written from source I read, not executed)
| File | Covers |
|---|---|
| `tornado-classic.md` | Pedersen/MiMC notes, depth-20 tree, withdraw proof inputs, HTTP relayer |
| `tornado-nova.md` | UTXO JoinSplit, `extData`, Nova relayer, Privacy Cash (Solana) |
| `railgun.md` | Poseidon notes, ciphertext structs, Waku broadcaster topics, Proof of Innocence |
| `swish.md` | Solana front end, protocol router, claim links, The Plug |

## NEAR docs (downloaded verbatim, `near/`)
| File | Source |
|---|---|
| `near-intents.md` | docs.near-intents.org/index.md |
| `what-are-intents.md` | …/getting-started/what-are-intents.md |
| `1click-about.md`, `1click-quickstart.md`, `1click-making-a-request.md`, `1click-confidential-swaps.md`, `1click-auth.md` | 1Click Swap API |
| `chain-abstraction.md` | docs.near.org/chain-abstraction/what-is.md |
| `chain-signatures.md`, `intents-overview.md` | docs.near.org |
| `near-ai.md`, `near-ai-quickstart.md` | docs.near.ai (private inference in TEEs; optional, not needed for the two tools) |

## Facts to keep straight
- MPC contract is `v1.signer` (not `chain-signatures.near`). Domain 0 = Secp256k1, 1 = Ed25519.
- Use a different derivation path per chain.
- Chain Signatures only signs outbound transactions.
- NEAR Intents has no testnet. Unauthenticated 1Click calls add a 0.25% fee.
- Several pages above are overview pages; deeper pages (e.g. Chain Signatures implementation, Swap Types, fee config, status endpoint) are linked inside them and not yet downloaded.

## Source repos (shallow clones, scratch only)
`tornadocash/tornado-relayer`, `tornadocash/tornado-pool-relayer`, `Railgun-Privacy/contract`,
`Railgun-Community/waku-broadcaster-client`, `Railgun-Community/shared-models`, `Privacy-Cash/privacy-cash`.

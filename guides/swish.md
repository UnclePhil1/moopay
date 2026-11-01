# Swish — architecture guide

Sources: docs.swish.cash (index, privacy-protocols, developers/plug). Swish is a **Solana payments front end**
that aggregates other privacy protocols. Its docs contain no commitment/note/relayer formats — those live in
the underlying protocols (see `tornado-nova.md` for Privacy Cash).

## Product shape
- Send/receive USDC and SOL without exposing a wallet address on-chain.
- Non-custodial: funds stay in the user's wallet, user signs every transaction.
- Address-free sending: X (Twitter) handles, or **claimable links** ("Send via Claim").
- Sign-in with a Solana wallet or X.

## Routing layer
| Protocol | Type | Fee (per docs) |
|---|---|---|
| Privacy Cash | ZK UTXO mixer, withdraw with ZK proof | ~$0.71 + 0.35% |
| MagicBlock | TEE-based (Intel TDX); recipient gets funds directly in token account | 0.1% |
| Umbra | ZK shielded pool with Arcium MPC; sender and recipient must both register | ~0.35% send + ~0.35% unshield |

Swish picks a route per transaction. SOL always uses Privacy Cash. The Plug (`@swishdotcash/plug`) routes
MagicBlock or Privacy Cash (not Umbra). Swish itself charges nothing; withdraw gas is sponsored.

## The Plug (developer widget)
`npm i @swishdotcash/plug` or script tag. `<Plug />` or `Plug.open(opts)`.
Options: `recipient, amount, token, reference, label, compact, onSuccess, onError, onClose`.
Payer needs the token plus a little SOL for gas.

## What to borrow for MooPay
- **Claim link** UX: sender creates a link carrying a secret; receiver redeems to any address. This is the
  closest product analogue to `mint_private_claim_deposit`.
- Protocol-router abstraction: one interface, several backends chosen by asset/fee/availability.
  MooPay's equivalent is 1Click (NEAR Intents) choosing the solver.
- Sponsored gas for the receiver.
- Per-route fee table surfaced to the user before confirming.

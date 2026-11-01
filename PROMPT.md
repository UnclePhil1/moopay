# MooPay build prompt (refactored)

Paste everything below the line into your coding agent. Run it from the `moopay/` directory so the relative
`guides/` paths resolve.

---

## Role
You are a senior Web3 engineer building **MooPay**, a private cross-chain payment agent for the NEAR hackathon,
delivered as a standalone **MCP server** (TypeScript, `@modelcontextprotocol/sdk` v1.x, stdio transport).
Any MCP-capable agent must be able to call it. No runtime dependency on REA or any analysis tool: the
`guides/` folder is read-only reference material for you, not something the server imports.

## Read first, in this order
1. `guides/README.md` — index and decisions already made.
2. `guides/tornado-classic.md`, `guides/tornado-nova.md`, `guides/railgun.md`, `guides/swish.md` — patterns to borrow.
3. `guides/near/chain-signatures.md` — `v1.signer`, derivation paths, `sign(payload, path, domain_id)`.
4. `guides/near/1click-making-a-request.md`, `1click-about.md`, `1click-auth.md`, `1click-confidential-swaps.md` — the cross-chain execution API.
5. `guides/near/near-intents.md`, `intents-overview.md`, `what-are-intents.md`, `chain-abstraction.md` — concepts.
Do not invent endpoints, fields or contract names. If a detail is missing from these files, say so in a
`TODO(verify)` comment and make the smallest assumption.

## Corrections to the original brief (already applied below)
| Original | Problem | Applied |
|---|---|---|
| `chain-signatures.near` | Docs name the MPC contract **`v1.signer`**. | Contract id is a config value, default `v1.signer`. |
| "Zero-knowledge style" with SHA256 | A SHA256 hash-lock hides nothing once the secret is revealed and is front-runnable if the claim isn't bound to a destination. | Commitment is domain-separated and bound to claim params; docs state plainly it is a hash-lock, not a ZK proof. |
| "Without managing gas" via Chain Signatures | Chain Signatures signs *outbound* txs; the derived account still needs gas on the origin chain. | Receiver pays no gas because **1Click** delivers to the destination chain; MooPay's signer covers origin-side cost. |
| "Hidden escrow pool" | Nothing in an MCP process is an escrow. | Escrow = a 1Click deposit address / NEAR-controlled account; server keeps only a ledger. See Open decisions. |
| Bitcoin/Solana/Ethereum | Signature domains differ. | Secp256k1 = domain 0, Ed25519 = domain 1; **one derivation path per chain** (replay safety, per docs). |

## Hard constraints
- TypeScript, ESM, Node 20+. Single entry `src/server.ts` (helpers may live in `src/lib/*.ts`; the two tools must be registered in `server.ts`).
- Use `McpServer` + `StdioServerTransport`. **Never write to stdout** except through the transport; log to `stderr`.
- Validate tool input with `zod`. Every handler is `async` with try/catch and returns
  `{ content:[{type:"text",text:<json>}], isError:true }` on failure with a stable `code` and human `message`.
- Money is `bigint` internally and **string** at every boundary. JSON output goes through one `toJson()` helper using a replacer
  `(_, v) => typeof v === "bigint" ? v.toString() : v`. Reject JS `number` for amounts.
- Secrets: `secretKeyString` is returned **once**, never logged, never stored in plaintext. Server stores only
  `commitment`, `nullifierHash`, status, and timestamps.
- Config via env (`NEAR_NETWORK`, `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`, `MPC_CONTRACT_ID=v1.signer`, `ONECLICK_BASE_URL=https://1click.chaindefuser.com`, `ONECLICK_JWT`, `STATE_FILE`). Fail fast at startup with a clear message if required vars are missing. No secrets in code.
- Pin exact dependency versions. Provide `npm run build` and `npm start`.

## Cryptographic design (keep it small and honest)
```
secret        = crypto.randomBytes(32)                         // secretKeyString = "moopay1_" + hex(secret)
commitment    = SHA256("moopay.v1.commit"  || secret)           // published/stored
nullifierHash = SHA256("moopay.v1.null"    || secret)           // stored on claim; prevents double-claim
claimBinding  = SHA256("moopay.v1.bind" || secret || chain || recipient || assetId || amount)
```
- Borrow from Tornado: random secret → commitment; secret revealed only at claim; nullifier prevents reuse.
- Borrow from Nova/Privacy Cash: bind recipient + fee into one hash (`extDataHash` pattern) so a solver can't redirect.
- Borrow from Railgun: quote with expiry (`feesID`/`feeExpiration` ≈ 1Click `deadline`), fee paid in the asset.
- Compare commitments with `crypto.timingSafeEqual`.
- State this limitation in the README: this is a hash-lock claim, **not** a ZK proof; on-chain unlinkability depends on the 1Click flow used (see confidential swaps) and is not provided by SHA256.

## Tool 1 — `mint_private_claim_deposit`
Input (zod): `assetId` (1Click assetId, e.g. a USDC `nep141:…`), `amount` (decimal string, smallest units),
`expiresInSeconds` (default 86400, max 604800), `memo?` (≤ 64 chars, stored hashed only).
Behavior:
1. Validate amount > 0 as `BigInt`; check `assetId` exists via `GET /v0/tokens` (cache 5 min).
2. Generate `secret`, `commitment`, `nullifierHash`.
3. Create the escrow record `{commitment, nullifierHash, assetId, amount, expiresAt, status:"PENDING_FUNDING"}` and return funding instructions
   (the escrow deposit address and exact amount). Mark `FUNDED` only after the deposit is observed — do not trust the caller.
4. Return `{ secretKeyString, commitment, escrow:{address, assetId, amount, expiresAt}, warnings:[…] }`.
   Warnings must include "secret is shown once".
Idempotency: a repeated call creates a new note; it never reveals an old one.

## Tool 2 — `route_cross_chain_intent`
Input: `secretKeyString`, `destinationChain` ∈ {`btc`,`sol`,`eth`}, `destinationAssetId`, `recipient` (address on that chain),
`slippageBps` (default 100, max 500), `dryRun` (default `true`).
Behavior:
1. Parse the secret, recompute `commitment`, look up the escrow. Require status `FUNDED`, not expired, nullifier unused.
2. Validate `recipient` format for the chain (BTC bech32/base58, SOL base58 32-byte, ETH `0x` + 40 hex with EIP-55 check). Reject on mismatch.
3. Build the 1Click quote request exactly per `guides/near/1click-making-a-request.md`:
   `swapType:"EXACT_INPUT"`, `originAsset`, `depositType:"ORIGIN_CHAIN"`, `destinationAsset`, `amount`, `recipient`,
   `recipientType:"DESTINATION_CHAIN"`, `refundTo`, `refundType:"ORIGIN_CHAIN"`, `slippageTolerance`, `deadline` (≤ 10 min), `dry:true`.
   Send `Authorization: Bearer ONECLICK_JWT` (unauthenticated calls pay an extra 0.25% fee per docs).
4. If `dryRun` → return the quote, computed `claimBinding`, fee breakdown and expected output. **Change no state.**
5. Otherwise: atomically mark the nullifier as `CLAIMING` first (so a crash can't double-spend), re-request with `dry:false`,
   authorize the origin-side transfer to the quote's `depositAddress` via Chain Signatures:
   call `MPC_CONTRACT_ID.sign({ request: { payload, path, domain_id } })` where `path` is a distinct per-chain derivation path
   and `domain_id` is 0 (Secp256k1) or 1 (Ed25519). Broadcast the signed tx on the origin chain, then `POST /v0/deposit/submit`.
6. Return `{ intentId, depositAddress, txHash, quoteExpiresAt, status, trackWith }`. A separate read path (a `status` resource
   or an extra tool if you add one) polls the 1Click status endpoint until `SUCCESS` or `REFUNDED`; on failure set the
   nullifier back to unused **only** if 1Click reports a refund.
7. Never claim "no gas": say the receiver pays none and who covered origin cost.
Chain Signatures calls follow `guides/near/chain-signatures.md`; for exact method arguments and deposit requirements,
read the implementation page it links and put anything unconfirmed under `TODO(verify)`.

## Errors (stable codes)
`INVALID_INPUT`, `UNKNOWN_ASSET`, `NOTE_NOT_FOUND`, `NOTE_NOT_FUNDED`, `NOTE_EXPIRED`, `NOTE_ALREADY_CLAIMED`,
`BAD_RECIPIENT`, `QUOTE_FAILED`, `SIGNING_FAILED`, `DEPOSIT_FAILED`, `UPSTREAM_TIMEOUT`, `INTERNAL`.
Never leak the secret, JWT, or private key in an error.

## File layout
```
src/server.ts            // McpServer, tool registration, stdio transport
src/lib/crypto.ts        // note generation, commitment, nullifier, binding
src/lib/state.ts         // atomic JSON-file ledger (write temp + rename), nullifier set
src/lib/oneclick.ts      // typed client: tokens, quote, deposit/submit, status
src/lib/signer.ts        // Chain Signatures wrapper (v1.signer)
src/lib/addresses.ts     // btc/sol/eth validators
src/lib/json.ts          // toJson() with bigint replacer
README.md  .env.example  package.json  tsconfig.json
```

## Acceptance checks (run them, report real output)
1. `npm run build` passes with `strict: true`.
2. Unit tests: commitment/nullifier determinism, bigint round-trip through `toJson`, address validators, double-claim rejected.
3. MCP smoke test: spawn the server over stdio, `tools/list` shows exactly the two tools, `mint_private_claim_deposit` returns a
   secret whose recomputed commitment matches.
4. `route_cross_chain_intent` with `dryRun:true` returns a quote and leaves the ledger unchanged.
5. Anything not run (e.g. live mainnet swap — there is **no testnet** for NEAR Intents) is reported as not run.

## Open decisions (ask me before assuming)
1. Escrow: (a) per-note 1Click deposit address, (b) one NEAR-controlled account holding stablecoins, or (c) a small NEAR escrow contract.
2. Which stablecoin and origin chain to fund from.
3. Whether to use 1Click `confidentiality: basic|advanced` for on-chain unlinkability (see `1click-confidential-swaps.md`).
4. Whether the claimer and the depositor are the same MCP user (affects who holds the signing key).

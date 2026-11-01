# Railgun — architecture guide

Sources: docs.railgun.org/developer-guide, `Railgun-Privacy/contract`, `Railgun-Community/waku-broadcaster-client`,
`Railgun-Community/shared-models`. Read from source, not executed.

## Model
Shielded UTXO pool on EVM. `shield` (public → private), private `transact` via JoinSplit circuits, `unshield`.
State = incremental Merkle tree in `Commitments.sol` + a nullifier mapping. Only JoinSplit circuits can change state.

## Note preimage (`Globals.sol`)
```solidity
CommitmentPreimage { bytes32 npk; TokenData token; uint120 value }
npk = Poseidon(Poseidon(spendingPublicKey, nullifyingKey), random)
TokenData { tokenType (ERC20|ERC721|ERC1155), tokenAddress, tokenSubID }
```
Tree depth 16; zero value `keccak256("Railgun") mod SNARK_SCALAR_FIELD`.

## Transaction
```solidity
Transaction { proof, merkleRoot, nullifiers[], commitments[], boundParams, unshieldPreimage }
BoundParams { treeNumber, minGasPrice, unshield (NONE|NORMAL|REDIRECT), chainID,
              adaptContract, adaptParams, commitmentCiphertext[] }
CommitmentCiphertext { bytes32[4] ciphertext, blindedSenderViewingKey, blindedReceiverViewingKey,
                       bytes annotationData, bytes memo }
ShieldCiphertext { bytes32[3] encryptedBundle, bytes32 shieldKey }
```
`adaptContract/adaptParams` = cross-contract calls ("relay adapt"); unshield can redirect to an adapt contract.

## Broadcasters (relayers) over Waku — no IP leak
Content topics (`waku-topics.ts`):
```
/railgun/v2/{chainType}-{chainId}-fees/json
/railgun/v2/{chainType}-{chainId}-transact/json
/railgun/v2/{chainType}-{chainId}-transact-response/json
/railgun/v2/metrics/json    /railgun/v2/encrypted-{topic}/json
```
Fee message = `{ data: hex(JSON), signature }` with
```ts
BroadcasterFeeMessageData { fees: {token: string}, feeExpiration, feesID, railgunAddress, identifier?,
  availableWallets, version, relayAdapt, requiredPOIListKeys[], reliability }
```
Clients drop fee messages older than ~45s and verify signature + version.

Transact message = `{ method: "transact", params: { pubkey, encryptedData } }`:
client makes a random keypair, derives a shared key with the broadcaster's viewing key, encrypts the request;
the response comes back encrypted on `transact-response`.
Plaintext request: `txidVersion, chainID, chainType, feesID, broadcasterViewingKey, minVersion, maxVersion,
to, data, useRelayAdapt, preTransactionPOIsPerTxidLeafPerList` + `transactType: COMMON (minGasPrice)` or
`TX7702 (maxFeePerGas, maxPriorityFeePerGas, authorization)`.
The user pays the broadcaster **inside the private tx** as a fee note to `railgunAddress` (amount from `fees[token]`).

## Proof of Innocence (compliance)
`requiredPOIListKeys` / `preTransactionPOIs…` make a user prove their funds are not on a blocklist
without revealing history. This is the compliance pattern to copy if MooPay ever holds user funds.

## What to borrow for MooPay
- Quote-then-submit relayer flow with `feesID` + expiry (maps to a 1Click quote + `deadline`).
- Fee paid in the transferred asset, not in gas.
- Encrypted request to the solver so intents aren't readable in transit.
- `BoundParams`-style binding of chain/recipient to the proof.

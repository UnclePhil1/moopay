import { KeyPair } from "near-api-js";

/* Makes the owner's recovery key in this browser. The secret half is shown once and never sent anywhere: the server and the signer
   only ever receive the public half, and only after the owner's passkey has named it. Loaded on demand, so the chat page stays light. */
(window as unknown as { moopayRecovery: unknown }).moopayRecovery = {
  make: () => {
    const k = KeyPair.fromRandom("ed25519");
    return { publicKey: k.getPublicKey().toString(), secretKey: k.toString() };
  },
};

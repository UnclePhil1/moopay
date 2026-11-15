import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { AgentStore, Approval, UserRec } from "../agent/store.js";
import type { ApprovalProof, SignerApi, SignerStatus } from "../signer/client.js";
import { MoopayError } from "../util/errors.js";

/**
 * Passkeys for accounts whose key is in the signer. The signer, not this server, checks the signature, so everything here only
 * relays: it asks the signer for a one-time nonce and the list of the user's passkeys, hands them to the page, and passes the page's
 * signed answer back. The page builds the challenge itself from the payment it shows (see src/web/src/signer-challenge.ts), so
 * a server that lies about the payment, the nonce or the user gets a signature the signer will not accept.
 */
export interface SignerPrompt {
  kind: "mandate" | "action";
  /** the user's id, which is part of what is signed */
  userId: string;
  /** a one-time nonce from the signer */
  nonce: string;
  rpId: string;
  allowCredentials: { id: string; type: "public-key"; transports?: string[] }[];
  /** for a payment: exactly what is being approved */
  flows?: { asset: string; to: string; amount: string }[];
  /** for anything else: what is being changed */
  action?: "addkey" | "strict:on" | "strict:off" | "unlock" | `recoverykey:${string}`;
}

export const isTee = (u: UserRec): boolean => !!u.tee;

export class Tee {
  constructor(private readonly store: AgentStore) {}

  api(): SignerApi {
    const a = this.store.signerApi();
    if (!a) throw new MoopayError("INTERNAL", "This account's key is held by the secure signer, which isn't configured on this server.");
    return a;
  }

  /** The page puts the one-time nonce next to the signature it got from the device. This splits them again. */
  proofOf(raw: unknown): ApprovalProof | undefined {
    const a = raw as (AuthenticationResponseJSON & { moopayNonce?: unknown }) | undefined;
    if (!a || typeof a.moopayNonce !== "string") return undefined;
    const { moopayNonce, ...assertion } = a;
    return { nonce: moopayNonce, assertion: assertion as AuthenticationResponseJSON };
  }

  /** Reads the signer's record of this account and keeps a copy of the two flags the rest of the server needs. */
  async refresh(u: UserRec): Promise<SignerStatus> {
    const st = await this.api().status(u.id);
    if (u.tee && (u.tee.passkey !== st.active || u.tee.strict !== st.strict)) { u.tee.passkey = st.active; u.tee.strict = st.strict; this.store.save(); }
    return st;
  }

  async prompt(u: UserRec, rpId: string, what: { kind: "mandate"; flows: NonNullable<Approval["flows"]> } | { kind: "action"; action: NonNullable<SignerPrompt["action"]> }): Promise<SignerPrompt> {
    const [st, nonce] = await Promise.all([this.refresh(u), this.api().nonce(u.id)]);
    return {
      kind: what.kind, userId: u.id, nonce, rpId,
      allowCredentials: st.passkeys.map((p) => ({ id: p.id, type: "public-key", ...(p.transports ? { transports: p.transports } : {}) })),
      ...(what.kind === "mandate" ? { flows: what.flows } : { action: what.action }),
    };
  }

  /** Before a payment runs: the owner's passkey signature for exactly what the card shows. Returns once the signer has accepted it. */
  async approve(u: UserRec, a: Approval, raw: unknown): Promise<void> {
    if (!a.flows?.length) return; // not a kind the signer can tie a passkey to yet: it will decide when the payment is signed
    if (!u.tee?.passkey) return;  // no passkey: only the small free limit can move, and the signer enforces that
    const proof = this.proofOf(raw);
    if (!proof) throw new MoopayError("INVALID_INPUT", "Confirm with your fingerprint, face or PIN first. Nothing was sent.");
    await this.api().mandate(u.id, a.flows, proof);
  }
}

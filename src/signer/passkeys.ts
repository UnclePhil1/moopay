import { createHash, randomBytes } from "node:crypto";
import { generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransport, PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Refused, type Flow, type Outflow } from "./policy.js";
import type { UserState } from "./state.js";

/*
 * Passkeys inside the signer.
 *
 * The signer, not the MooPay server, decides whether a passkey signature is good. A signature is only accepted for one thing:
 * its challenge is a hash of a one-time nonce this signer issued plus the exact action (the payment's asset, amount and
 * recipient, or "turn strict mode on"). The browser can build that same challenge from the card it shows, so the fingerprint
 * signs what the user saw, and a stolen or reused signature is worth nothing for any other payment.
 *
 * What this does not cover: if the page the user is looking at is itself altered by an attacker who controls the MooPay
 * server, it can show one payment and sign another. A passkey proves "the owner's device approved this", not "the owner read it".
 */
export type Action = "addkey" | "strict:on" | "strict:off" | "unlock";

const TTL = 5 * 60_000;
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64url"));
const sha = (s: string): string => createHash("sha256").update(s).digest("base64url");

/** The text a payment is reduced to before it is hashed. The browser must produce the identical text. */
export const paymentText = (flows: Pick<Outflow, "asset" | "amount" | "to" | "method">[]): string =>
  flows.map((f) => [f.method, f.asset, f.amount.toString(), f.to].join(" ")).sort().join("\n");

/** The challenge a passkey signs for a payment. Exported so the browser code can match it byte for byte. */
export const paymentChallenge = (userId: string, nonce: string, flows: Pick<Outflow, "asset" | "amount" | "to" | "method">[]): string => sha(`moopay.pay.v1|${userId}|${nonce}|${paymentText(flows)}`);
/** The text a mandate is reduced to: each payment as asset, amount, recipient. The browser must produce the identical text. */
export const flowsText = (flows: Pick<Flow, "asset" | "amount" | "to">[]): string => flows.map((f) => [f.asset, f.amount.toString(), f.to].join(" ")).sort().join("\n");
export const mandateChallenge = (userId: string, nonce: string, flows: Pick<Flow, "asset" | "amount" | "to">[]): string => sha(`moopay.mandate.v1|${userId}|${nonce}|${flowsText(flows)}`);
export const actionChallenge = (userId: string, nonce: string, action: Action): string => sha(`moopay.action.v1|${userId}|${nonce}|${action}`);

export class SignerPasskeys {
  private readonly nonces = new Map<string, { user: string; exp: number }>();
  private readonly regs = new Map<string, { user: string; exp: number }>();

  constructor(private readonly origin: string, private readonly delayMs = 24 * 3600_000, private readonly now: () => number = Date.now) {}

  private get rpID(): string { return new URL(this.origin).hostname; }
  /** True once the user has a passkey that is in force. */
  /**
   * A passkey is in force at once while the account has never moved money: nothing it could protect is at risk, and an attacker who
   * registers first gets nothing (the app shows no address before a passkey exists). Once money has moved, a first passkey waits.
   */
  active(s: UserState): boolean { return s.credentials.length > 0 && (!s.moved || this.now() >= s.activeAt); }
  pending(s: UserState): boolean { return s.credentials.length > 0 && !this.active(s); }
  list(s: UserState) { return s.credentials.map((c) => ({ id: c.id, ...(c.transports ? { transports: c.transports } : {}) })); }

  /** A fresh one-time nonce. The browser hashes it with what it is about to sign. Nonces live in memory only: a restart voids them, which is safe. */
  nonce(user: string): string {
    for (const [k, v] of this.nonces) if (v.exp < this.now()) this.nonces.delete(k);
    const n = randomBytes(18).toString("base64url");
    this.nonces.set(n, { user, exp: this.now() + TTL });
    return n;
  }
  private take(map: Map<string, { user: string; exp: number }>, key: string, user: string): boolean {
    const v = map.get(key); map.delete(key);
    return !!v && v.user === user && v.exp >= this.now();
  }

  /** Checks a passkey signature against the challenge the signer computes itself, and moves the counter. Spends the nonce either way. */
  private async check(s: UserState, user: string, nonce: string, challenge: string, response: AuthenticationResponseJSON | undefined): Promise<void> {
    const key = response && s.credentials.find((c) => c.id === response.id);
    const ok = this.take(this.nonces, nonce, user);
    if (!ok || !response || !key) throw new Refused("bad_assertion", "That fingerprint or face did not match. Nothing was sent. Please try again.");
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true,
        credential: { id: key.id, publicKey: unb64(key.publicKey), counter: key.counter, ...(key.transports ? { transports: key.transports as AuthenticatorTransport[] } : {}) },
      });
      if (!v.verified) throw new Error("not verified");
      key.counter = v.authenticationInfo.newCounter;
    } catch { throw new Refused("bad_assertion", "That fingerprint or face did not match. Nothing was sent. Please try again."); }
  }

  verifyPayment(s: UserState, user: string, nonce: string, flows: Outflow[], response: AuthenticationResponseJSON | undefined): Promise<void> {
    return this.check(s, user, nonce, paymentChallenge(user, nonce, flows), response);
  }
  verifyMandate(s: UserState, user: string, nonce: string, flows: Flow[], response: AuthenticationResponseJSON | undefined): Promise<void> {
    return this.check(s, user, nonce, mandateChallenge(user, nonce, flows), response);
  }
  verifyAction(s: UserState, user: string, nonce: string, action: Action, response: AuthenticationResponseJSON | undefined): Promise<void> {
    return this.check(s, user, nonce, actionChallenge(user, nonce, action), response);
  }

  /** Options for the browser to create a passkey. */
  async registerOptions(s: UserState, user: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const o = await generateRegistrationOptions({
      rpName: "MooPay", rpID: this.rpID, userName: "MooPay wallet", userDisplayName: "MooPay wallet", userID: createHash("sha256").update("moopay.user|" + user).digest(),
      attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: s.credentials.map((c) => ({ id: c.id, ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}) })),
    });
    for (const [k, v] of this.regs) if (v.exp < this.now()) this.regs.delete(k);
    this.regs.set(o.challenge, { user, exp: this.now() + TTL });
    return o;
  }

  /**
   * Adds a new passkey to `s`. With none yet, it counts at once if the account never moved money, otherwise after the delay; with one already, the caller must have passed
   * `verifyAction(.., "addkey")` first, so a stolen server cannot enrol its own device.
   */
  async register(s: UserState, user: string, response: RegistrationResponseJSON): Promise<void> {
    let v;
    try { v = await verifyRegistrationResponse({ response, expectedChallenge: (c) => this.take(this.regs, c, user), expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true }); }
    catch { throw new Refused("bad_assertion", "I couldn't save that passkey. Please try again."); }
    if (!v.verified || !v.registrationInfo) throw new Refused("bad_assertion", "I couldn't save that passkey. Please try again.");
    const c = v.registrationInfo.credential;
    const first = s.credentials.length === 0;
    s.credentials = [...s.credentials, { id: c.id, publicKey: b64(c.publicKey), counter: c.counter, ...(c.transports ? { transports: c.transports } : {}), at: this.now() }].slice(-5);
    if (first) s.activeAt = s.moved ? this.now() + this.delayMs : this.now();
  }
}

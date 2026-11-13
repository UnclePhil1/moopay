import { randomBytes } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransport, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { MoopayError } from "../util/errors.js";
import type { UserRec } from "../agent/store.js";

/*
 * Passkeys: a fingerprint, a face or a device PIN signs off on a payment. No password, no username, no sign-up.
 *
 *   - Registration makes a discoverable credential (residentKey required) and demands user verification, so the device always
 *     asks for a biometric or its PIN. On a PC without a sensor the browser falls back to the OS PIN, or to a QR code the
 *     user scans with their phone (the "hybrid" transport). That choice is the browser's, not ours.
 *   - Every signature answers a fresh challenge that is bound to one purpose ("approve this payment", "turn this off") and to
 *     one user, used once, and valid for five minutes. A signature for one thing cannot be replayed for another.
 *   - The server checks the origin and the relying-party id (the site's own domain), so a look-alike site cannot ask for a
 *     signature that works here.
 *   - The signature counter must go up each time. If it does not, the library refuses it: that is how a cloned key is caught.
 *
 * This is the self-hosted version. It sits behind the small `Passkeys` class so a managed provider can replace it later.
 */
export interface Passkey { id: string; publicKey: string; counter: number; transports?: string[]; at: number }
/** Which doors need a passkey. Both are on as soon as one passkey exists. */
export interface Bio { web: boolean; x: boolean }

const TTL = 5 * 60_000;
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64url"));
const refuse = (m: string): MoopayError => new MoopayError("INVALID_INPUT", m);

export const hasPasskey = (u: UserRec): boolean => !!u.passkeys?.length;
/** Does this door (the web app or X) need a passkey for this user? */
export const needsPasskey = (u: UserRec, door: "web" | "x"): boolean => hasPasskey(u) && (u.bio ?? { web: true, x: true })[door] !== false;

export class Passkeys {
  private pending = new Map<string, { user: string; purpose: string; exp: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  private put(challenge: string, user: UserRec, purpose: string): void {
    for (const [k, v] of this.pending) if (v.exp < this.now()) this.pending.delete(k);
    this.pending.set(challenge, { user: user.id, purpose, exp: this.now() + TTL });
  }
  /** True once, for the user and purpose the challenge was made for. */
  private take(challenge: string, user: UserRec, purpose: string): boolean {
    const c = this.pending.get(challenge);
    this.pending.delete(challenge);
    return !!c && c.user === user.id && c.purpose === purpose && c.exp >= this.now();
  }
  private where = (origin: string) => ({ rpID: new URL(origin).hostname, origin });

  async registerOptions(u: UserRec, origin: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const o = await generateRegistrationOptions({
      rpName: "MooPay", rpID: this.where(origin).rpID, userName: u.accountId.slice(0, 20), userDisplayName: "MooPay wallet", userID: unb64(u.id.slice(0, 43).padEnd(43, "A")),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: (u.passkeys ?? []).map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports as AuthenticatorTransport[] } : {}) })),
    });
    this.put(o.challenge, u, "register");
    return o;
  }

  async register(u: UserRec, origin: string, response: RegistrationResponseJSON): Promise<void> {
    const w = this.where(origin);
    let v;
    try { v = await verifyRegistrationResponse({ response, expectedChallenge: (c) => this.take(c, u, "register"), expectedOrigin: w.origin, expectedRPID: w.rpID, requireUserVerification: true }); }
    catch { throw refuse("I couldn't save that passkey. Please try again."); }
    if (!v.verified || !v.registrationInfo) throw refuse("I couldn't save that passkey. Please try again.");
    const c = v.registrationInfo.credential;
    u.passkeys = [...(u.passkeys ?? []), { id: c.id, publicKey: b64(c.publicKey), counter: c.counter, ...(c.transports ? { transports: c.transports } : {}), at: this.now() }].slice(-5);
    u.bio ??= { web: true, x: true };
  }

  /** The challenge the user's device must sign for one purpose, e.g. "approve:abc123". */
  async options(u: UserRec, origin: string, purpose: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!hasPasskey(u)) throw refuse("Add a passkey first.");
    const o = await generateAuthenticationOptions({ rpID: this.where(origin).rpID, userVerification: "required", allowCredentials: u.passkeys!.map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports as AuthenticatorTransport[] } : {}) })) });
    this.put(o.challenge, u, purpose);
    return o;
  }

  /** Checks a signature for one purpose and moves the counter forward. Throws a plain message when it is not valid. */
  async verify(u: UserRec, origin: string, response: AuthenticationResponseJSON | undefined, purpose: string): Promise<void> {
    const key = response && u.passkeys?.find((p) => p.id === response.id);
    if (!response || !key) throw refuse("That fingerprint or face did not match this account. Please try again.");
    const w = this.where(origin);
    try {
      const v = await verifyAuthenticationResponse({ response, expectedChallenge: (c) => this.take(c, u, purpose), expectedOrigin: w.origin, expectedRPID: w.rpID, requireUserVerification: true, credential: { id: key.id, publicKey: unb64(key.publicKey), counter: key.counter, ...(key.transports ? { transports: key.transports as AuthenticatorTransport[] } : {}) } });
      if (!v.verified) throw new Error("not verified");
      key.counter = v.authenticationInfo.newCounter;
    } catch { throw refuse("That fingerprint or face did not match. Nothing was changed. Please try again."); }
  }
}

/** A random one-off id for links that are shown in public, such as the approve link posted on X. */
export const linkId = (): string => randomBytes(12).toString("base64url");

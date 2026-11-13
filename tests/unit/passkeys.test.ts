import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { test } from "node:test";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { hasPasskey, needsPasskey, Passkeys } from "../../src/security/passkeys.js";
import { riskOf } from "../../src/security/risk.js";
import type { UserRec } from "../../src/agent/store.js";

const ORIGIN = "https://moopay.cash", RP = "moopay.cash";
const b64 = (b: Uint8Array | Buffer | string): string => Buffer.from(b as never).toString("base64url");
const sha = (b: Uint8Array | Buffer | string): Buffer => createHash("sha256").update(b).digest();
const user = (): UserRec => ({ id: b64(randomBytes(32)), accountId: "a".repeat(64), rules: {}, known: [], payments: [] } as unknown as UserRec);

/** A pretend phone: makes a real P-256 key and signs the way a device does, so the checks run on genuine signatures. */
function phone(origin = ORIGIN) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16), id = b64(credId), rpHash = sha(RP);
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
  const counter = (n: number) => { const c = Buffer.alloc(4); c.writeUInt32BE(n); return c; };
  return {
    id,
    create(challenge: string) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), counter(0), Buffer.alloc(16), len, credId, Buffer.from(isoCBOR.encode(cose))]); // present, verified, has credential
      const att = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })), attestationObject: b64(att), transports: ["internal"] } } as never;
    },
    get(challenge: string, n: number, flags = 0x05, from = origin) {
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), counter(n)]);
      const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: from, crossOrigin: false }));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(sign("sha256", Buffer.concat([authData, sha(cd)]), privateKey)) } } as never;
    },
  };
}
async function enrolled() {
  const pk = new Passkeys(), u = user(), p = phone();
  await pk.register(u, ORIGIN, p.create((await pk.registerOptions(u, ORIGIN)).challenge));
  return { pk, u, p };
}

test("passkey: registering needs a verified fingerprint or PIN, and turns protection on", async () => {
  const { u } = await enrolled();
  assert.equal(hasPasskey(u), true);
  assert.deepEqual(u.bio, { web: true, x: true });
  const pk = new Passkeys(), v = user(), p = phone();
  const o = await pk.registerOptions(v, ORIGIN);
  assert.equal(o.authenticatorSelection?.residentKey, "required");
  assert.equal(o.authenticatorSelection?.userVerification, "required");
  const noPin = p.create(o.challenge); // flags: present only, not verified
  const att = Buffer.from((noPin as { response: { attestationObject: string } }).response.attestationObject, "base64url");
  const m = isoCBOR.decodeFirst<Map<string, Buffer>>(att); const ad = m.get("authData")!; ad[32] = 0x41;
  (noPin as { response: { attestationObject: string } }).response.attestationObject = b64(isoCBOR.encode(m));
  await assert.rejects(pk.register(v, ORIGIN, noPin), /couldn't save/, "no biometric or PIN, no passkey");
});

test("passkey: a signature approves one payment once, and moves the counter forward", async () => {
  const { pk, u, p } = await enrolled();
  const o = await pk.options(u, ORIGIN, "approve:abc");
  await pk.verify(u, ORIGIN, p.get(o.challenge, 1), "approve:abc");
  assert.equal(u.passkeys![0]!.counter, 1);
  await assert.rejects(pk.verify(u, ORIGIN, p.get(o.challenge, 2), "approve:abc"), /did not match/, "a challenge works only once");
});

test("passkey: a signature for one payment cannot approve another", async () => {
  const { pk, u, p } = await enrolled();
  const o = await pk.options(u, ORIGIN, "approve:one");
  await assert.rejects(pk.verify(u, ORIGIN, p.get(o.challenge, 1), "approve:two"), /did not match/);
});

test("passkey: another user's passkey, or another site's page, is refused", async () => {
  const { pk, u, p } = await enrolled();
  const o = await pk.options(u, ORIGIN, "toggle");
  await assert.rejects(pk.verify(u, ORIGIN, p.get(o.challenge, 1, 0x05, "https://moopay-cash.evil.example"), "toggle"), /did not match/, "a look-alike site cannot get a valid signature");
  const other = user(), o2 = await pk.options(u, ORIGIN, "toggle");
  await assert.rejects(pk.verify(other, ORIGIN, p.get(o2.challenge, 1), "toggle"), /did not match/);
});

test("passkey: a signature without a fingerprint or PIN, or a counter that does not go up, is refused", async () => {
  const { pk, u, p } = await enrolled();
  let o = await pk.options(u, ORIGIN, "toggle");
  await assert.rejects(pk.verify(u, ORIGIN, p.get(o.challenge, 1, 0x01), "toggle"), /did not match/, "user not verified");
  o = await pk.options(u, ORIGIN, "toggle");
  await pk.verify(u, ORIGIN, p.get(o.challenge, 5), "toggle");
  o = await pk.options(u, ORIGIN, "toggle");
  await assert.rejects(pk.verify(u, ORIGIN, p.get(o.challenge, 3), "toggle"), /did not match/, "a copied key replays an old counter");
  assert.equal(u.passkeys![0]!.counter, 5);
});

test("passkey: protection follows the toggles", async () => {
  const { u } = await enrolled();
  assert.equal(needsPasskey(u, "web"), true); assert.equal(needsPasskey(u, "x"), true);
  u.bio = { web: false, x: true };
  assert.equal(needsPasskey(u, "web"), false); assert.equal(needsPasskey(u, "x"), true);
  assert.equal(needsPasskey(user(), "x"), false, "no passkey, nothing to require");
});

test("risk: a drain or a burst forces step-up, a first-time recipient alone does not", () => {
  const u = user(), now = 1_800_000_000_000;
  assert.equal(riskOf(u, 5, 100, true, now).stepUp, false, "small first payment");
  assert.equal(riskOf(u, 90, 100, false, now).stepUp, true, "90% of the wallet");
  assert.equal(riskOf(u, 8, 10, false, now).stepUp, false, "dust is ignored");
  assert.equal(riskOf(u, 10, 100, false, now).stepUp, false);
  u.payments = [1, 2, 3].map((i) => ({ id: String(i), kind: "send", createdAt: now - i * 1000 })) as never;
  const burst = riskOf(u, 5, 100, false, now);
  assert.equal(burst.stepUp, true); assert.match(burst.why[0]!, /last minute/);
  u.payments = [1, 2, 3].map((i) => ({ id: String(i), kind: "send", createdAt: now - 120_000 - i })) as never;
  assert.equal(riskOf(u, 5, 100, false, now).stepUp, false, "old payments do not count");
});

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

export const ORIGIN = "https://moopay.cash";
const RP = "moopay.cash";
export const b64 = (b: Uint8Array | Buffer | string): string => Buffer.from(b as never).toString("base64url");
const sha = (b: Uint8Array | Buffer | string): Buffer => createHash("sha256").update(b).digest();

/** A pretend phone: makes a real P-256 key and signs the way a device does, so the checks run on genuine signatures. */
export function phone(origin = ORIGIN) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16), id = b64(credId), rpHash = sha(RP);
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
  const counter = (n: number) => { const c = Buffer.alloc(4); c.writeUInt32BE(n); return c; };
  let n = 0;
  return {
    id,
    create(challenge: string) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), counter(0), Buffer.alloc(16), len, credId, Buffer.from(isoCBOR.encode(cose))]);
      const att = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })), attestationObject: b64(att), transports: ["internal"] } } as never;
    },
    /** Signs a challenge. The counter goes up by itself, like a real device. */
    get(challenge: string, count = ++n, flags = 0x05, from = origin) {
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), counter(count)]);
      const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: from, crossOrigin: false }));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(sign("sha256", Buffer.concat([authData, sha(cd)]), privateKey)) } } as never;
    },
  };
}

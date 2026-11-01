import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { MoopayError } from "./errors.js";

export type DestChain = "btc" | "sol" | "eth";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const body = Buffer.from(hex, "hex");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

/* ---- Bitcoin mainnet: bech32 / bech32m (BIP173/350) and base58check (P2PKH, P2SH) ---- */
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function validBtcBech32(addr: string): boolean {
  if (addr.length < 14 || addr.length > 90) return false;
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false;
  const a = addr.toLowerCase();
  const pos = a.lastIndexOf("1");
  if (pos < 1 || pos + 7 > a.length) return false;
  const hrp = a.slice(0, pos);
  if (hrp !== "bc") return false;
  const data: number[] = [];
  for (const ch of a.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return false;
    data.push(v);
  }
  const hrpExp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const chk = polymod([...hrpExp, ...data]);
  const version = data[0]!;
  if (version > 16) return false;
  if (chk !== (version === 0 ? BECH32_CONST : BECH32M_CONST)) return false;
  // regroup 5-bit -> 8-bit to get the witness program length
  const prog = data.slice(1, -6);
  let acc = 0;
  let bits = 0;
  let len = 0;
  for (const v of prog) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      len++;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || acc !== 0) return false; // invalid padding
  if (len < 2 || len > 40) return false;
  if (version === 0 && len !== 20 && len !== 32) return false;
  return true;
}

function validBtcBase58(addr: string): boolean {
  const raw = base58Decode(addr);
  if (!raw || raw.length !== 25) return false;
  const payload = raw.subarray(0, 21);
  const check = raw.subarray(21);
  const expect = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(check).equals(expect)) return false;
  return payload[0] === 0x00 || payload[0] === 0x05;
}

export const isValidBtc = (a: string): boolean => validBtcBech32(a) || validBtcBase58(a);

/* ---- Solana: base58, exactly 32 bytes ---- */
export function isValidSol(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false;
  const raw = base58Decode(addr);
  return raw !== null && raw.length === 32;
}

/* ---- Ethereum: 0x + 40 hex; mixed case must satisfy EIP-55 ---- */
export function eip55(addrLowerNo0x: string): string {
  const hash = Buffer.from(keccak_256(Buffer.from(addrLowerNo0x, "ascii"))).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = addrLowerNo0x[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

export function isValidEth(addr: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const body = addr.slice(2);
  // All-lower or all-upper carries no checksum; mixed case must match EIP-55.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return eip55(body.toLowerCase()) === addr;
}

export function assertRecipient(chain: DestChain, recipient: string): void {
  const ok = chain === "btc" ? isValidBtc(recipient) : chain === "sol" ? isValidSol(recipient) : isValidEth(recipient);
  if (!ok) throw new MoopayError("BAD_RECIPIENT", `recipient is not a valid ${chain.toUpperCase()} address`);
}

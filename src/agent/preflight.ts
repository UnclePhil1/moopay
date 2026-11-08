import type { NearOps } from "./chains/near.js";
import type { UserRec } from "./store.js";

/* The "what you see is what you sign" check: built from the payment's own data, never from what the model says. */

export interface Preflight {
  /** The request restated in one fixed format, so a misunderstanding shows before money moves. */
  intent: string;
  /** What was actually looked at and found fine. */
  checks: string[];
  /** Worth knowing, but not a reason to stop a small payment. */
  notes: string[];
  /** Worth a second look: any of these asks the user even for a small payment. */
  warnings: string[];
  /** A named NEAR account that does not exist: money sent there could be lost. */
  missing?: true;
  /** The full recipient address, never shortened. */
  to: string;
  /** What the receiver gets, when the route has a quote. */
  receive?: string;
  /** What leaves the wallet, and what of that is fees. */
  pay: string;
  fees: string;
  }

const norm = (chain: string, a: string) => (chain === "near" || chain === "eth" ? a.toLowerCase() : a);

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** An address that is not one the user has paid, but nearly is: a typo, or a lookalike made to be copied by mistake. */
export function lookalike(u: UserRec, chain: string, recipient: string): string | undefined {
  const me = norm(chain, recipient);
  for (const k of u.known) {
    if (!k.startsWith(chain + ":")) continue;
    const other = k.slice(chain.length + 1);
    if (other === me || other.length < 8 || me.length < 8) continue;
    if (distance(me, other) <= 2 || (me.slice(0, 5) === other.slice(0, 5) && me.slice(-5) === other.slice(-5))) return other;
  }
  return undefined;
}

export const isImplicit = (id: string): boolean => /^[0-9a-f]{64}$/.test(id);

export interface PreflightIn { chain: string; recipient: string; what: string; sym: string; receive?: string | undefined; pay: string; fees: string; private?: boolean }

/** Restates the payment and checks the recipient. Lookups that fail are skipped, never guessed. */
export async function preflight(near: NearOps, u: UserRec, i: PreflightIn): Promise<Preflight> {
  const out: Preflight = { intent: `SEND · ${i.what} · ${i.sym} · to ${i.recipient} · ${i.chain.toUpperCase()} network`, checks: ["The address is valid for this network"], notes: [], warnings: [], to: i.recipient, pay: i.pay, fees: i.fees, ...(i.receive ? { receive: i.receive } : {}) };
  if (i.private) {
    out.intent += " · PRIVATE ROUTE (beta)";
    if (i.receive) out.notes.push("The amount is worked out inside the private balance, so the receiver gets about the amount shown.");
    out.notes.push("Private route: the payment goes through a private balance, so the public chain does not link your wallet to the receiver. The receiver and amount are still public, and the private-route service can see the payment.");
  }
  const seen = u.known.includes(`${i.chain}:${norm(i.chain, i.recipient)}`);
  if (seen) out.checks.push("You have paid this address before");
  else out.notes.push("First payment to this address");
  const close = lookalike(u, i.chain, i.recipient);
  if (close) out.warnings.push(`It looks almost the same as ${close}, which you have paid before. Check every character`);
  if (i.chain === "near" && !isImplicit(i.recipient)) {
    const exists = await near.exists(i.recipient).catch(() => undefined);
    if (exists) out.checks.push("This account exists on NEAR");
    else if (exists === false) out.missing = true;
  }
  return out;
}

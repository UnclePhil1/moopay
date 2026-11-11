import { createHmac, randomBytes } from "node:crypto";
import type { AgentStore, UserRec } from "../agent/index.js";

/*
 * The X agent: reads mentions of the MooPay account on X and answers them in public. Each mention from a linked X account is
 * handled as a chat message from that user, so it follows the same rules, limits and approvals as the web chat.
 * Written from X's API v2 docs; it needs the five X_ settings in .env.example and has not run against the live API yet.
 */

/* ---- signing (OAuth 1.0a, HMAC-SHA1) ---- */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret: string): string {
  const base = [method.toUpperCase(), enc(url), enc(Object.entries(params).map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  return createHmac("sha1", `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest("base64");
}

export interface XKeys { key: string; secret: string; token: string; tokenSecret: string }
export class XClient {
  constructor(private readonly k: XKeys, private readonly doFetch: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  private header(method: string, url: string, query: Record<string, string>): string {
    const oauth: Record<string, string> = { oauth_consumer_key: this.k.key, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(Math.floor(this.now() / 1000)), oauth_token: this.k.token, oauth_version: "1.0" };
    const sig = oauthSignature(method, url, { ...query, ...oauth }, this.k.secret, this.k.tokenSecret);
    return "OAuth " + Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
  }
  private async call<T>(method: "GET" | "POST", url: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const q = new URLSearchParams(query).toString();
    const res = await this.doFetch(q ? `${url}?${q}` : url, { method, headers: { authorization: this.header(method, url, query), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => ""); let why = "";
      try { const j = JSON.parse(body) as { detail?: string; title?: string; reason?: string }; why = [j.title, j.detail, j.reason].filter(Boolean).join(" - "); } catch { why = body.slice(0, 200); }
      throw new Error(`X answered ${res.status}${res.status === 402 ? " (out of X API credits)" : ""}${why ? `: ${why}` : ""}`);
    }
    return (await res.json()) as T;
  }
  /** Mentions newer than `since`, oldest first. Without `since`, only says where the newest one is. */
  async mentions(userId: string, since?: string): Promise<{ newest?: string; tweets: Mention[] }> {
    const r = await this.call<{ data?: { id: string; text: string; author_id: string; entities?: { mentions?: { id?: string }[] } }[]; includes?: { users?: { id: string; username: string }[] }; meta?: { newest_id?: string } }>("GET", `https://api.x.com/2/users/${userId}/mentions`, { max_results: "20", expansions: "author_id", "tweet.fields": "author_id,entities", "user.fields": "username", ...(since ? { since_id: since } : {}) });
    const names = new Map((r.includes?.users ?? []).map((u) => [u.id, u.username]));
    const tweets = since ? (r.data ?? []).map((t) => ({ ...t, username: names.get(t.author_id) ?? "" })).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)) : [];
    return { ...(r.meta?.newest_id ? { newest: r.meta.newest_id } : {}), tweets };
  }
  /** The account the access token belongs to. */
  async me(): Promise<{ id: string; username: string }> { return (await this.call<{ data: { id: string; username: string } }>("GET", "https://api.x.com/2/users/me")).data; }
  /** X puts the replied-to person at the front itself. `exclude` keeps everyone else tagged in that post from being pulled into the reply. */
  async reply(text: string, to: string, exclude: string[] = []): Promise<void> { await this.call("POST", "https://api.x.com/2/tweets", {}, { text, reply: { in_reply_to_tweet_id: to, ...(exclude.length ? { exclude_reply_user_ids: exclude.slice(0, 50) } : {}) } }); }
}

/* ---- handling one mention ---- */
export interface Mention { id: string; text: string; author_id: string; username?: string; entities?: { mentions?: { id?: string }[] } }
export interface XDeps {
  store: AgentStore;
  botHandle: string;
  /** percent of each payment kept as a service fee; 0 for none */
  feeBps: number;
  now(): number;
  /** the assistant's answer to this user, plus any Confirm links it produced */
  ask(u: UserRec, text: string): Promise<{ text: string; urls: string[] }>;
  /** marks the payments made in this turn with the fee rate they owe; the worker takes the fee once they land */
  stamp(u: UserRec, had: Set<string>, bps: number): void;
  reply(text: string, to: string, exclude?: string[]): Promise<void>;
}

/** X refuses posts that contain a crypto address while an account is new, so an address is shown as its first 4 and last 3 characters, like 2dj3...8d3. */
export function hideAddresses(text: string): string { return text.replace(/\b(?:0x)?[A-Za-z0-9]{26,}\b/g, (a) => `${a.slice(0, 4)}...${a.slice(-3)}`); }

/** A post is 280 characters, and every link counts as 23. */
export function fit(text: string, urls: string[]): string {
  const room = 280 - urls.length * 24;
  const body = text.length > room ? text.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, "") + "…" : text;
  return [body, ...urls].join("\n");
}

/*
 * Most mentions are not requests: questions about the product, praise, jokes. Those get no reply at all.
 * Two cheap checks run before the AI is ever asked, and the AI is told to stay silent when a message is not a request.
 */
const MONEY_WORD = /\b(send|pay|transfer|split|stake|unstake|withdraw|claim|swap|bridge|schedule|balance|deposit|fund|confirm|cancel|yes|no|yep|link)\b|every (day|week|month)/i;
const AMOUNT = /\$\s?\d|\b\d[\d.,]*\s?(usd|usdc|usdt|near|sol|eth|btc)\b/i;
/** A request to a stranger-proof standard: an action word and a number. */
const ASKS_FOR_MONEY = (s: string): boolean => /\b(send|pay|transfer|split|stake|swap|bridge|claim|withdraw)\b/i.test(s) && (AMOUNT.test(s) || /\d/.test(s));
/** What the assistant says when a message is not a request; nothing is posted. */
export const SILENT = /^\W*ignore\W*$/i;

export async function handleMention(d: XDeps, t: Mention): Promise<void> {
  const clean = t.text.replace(new RegExp(`@${d.botHandle}\\b`, "gi"), "").replace(/\s+/g, " ").trim();
  const say = (s: string, urls: string[] = []) => d.reply(fit(hideAddresses(s), urls), t.id, (t.entities?.mentions ?? []).map((m) => m.id ?? "").filter((i) => i && i !== t.author_id)).then(() => console.log(`[x] posted reply to ${t.id}`)).catch((e: unknown) => console.log(`[x] could not reply to ${t.id}: ${e instanceof Error ? e.message : e}`));

  console.log(`[x] mention ${t.id} from @${t.username ?? "?"}: ${clean.slice(0, 100)}`);
  const link = /^link\s+(moo-[A-Za-z0-9]{6})\b/i.exec(clean);
  if (link) {
    const u = d.store.completeLink(link[1]!, t.author_id, t.username ?? "", d.now());
    console.log(`[x] link ${u ? "done for @" + (t.username ?? "") : "refused (bad or expired code)"}`);
    return void (await say(u ? "Linked. From now on, ask me here to send, stake, claim or check things, and I'll ask you to confirm before moving money." : "That link code didn't work. Make a new one in MooPay and try again."));
  }
  const u = d.store.byX(t.author_id);
  if (u ? !MONEY_WORD.test(clean) && !AMOUNT.test(clean) : !ASKS_FOR_MONEY(clean)) return void console.log("[x] not a request, ignored"); // no reply, no AI call
  if (!u) {
    // one polite hint per person per day, so a stranger can't make the account answer over and over
    const day = new Date(d.now()).toISOString().slice(0, 10), k = `xhint:${t.author_id}`;
    if (d.store.kv[k] === day) return void console.log("[x] not linked, already hinted today");
    console.log("[x] not linked, sending the link hint"); d.store.kv[k] = day; d.store.save();
    return void (await say("To use MooPay on X, open MooPay, type \"link my X account\", then post the code it gives you here."));
  }
  u.msgTimes = u.msgTimes.filter((x) => d.now() - x < 60_000);
  if (u.msgTimes.length >= 6) return void (await say("Slow down a little and try again in a minute."));
  u.msgTimes.push(d.now());

  // a handle that someone linked stands for their wallet
  const text = clean.replace(/@(\w{1,15})/g, (m, h: string) => d.store.byHandle(h)?.accountId ?? m);
  await run(d, u, text, say);
}

/** Asks the assistant, then posts its answer and takes the service fee for any payment this message started. */
async function run(d: XDeps, u: UserRec, text: string, say: (s: string, urls?: string[]) => Promise<unknown>): Promise<void> {
  const had = new Set(u.payments.map((p) => p.id));
  let out: { text: string; urls: string[] };
  console.log(`[x] thinking for ${u.x?.handle ?? u.id}…`);
  try { out = await d.ask(u, text); } catch (e) { console.log(`[x] the assistant failed: ${e instanceof Error ? e.message : e}`); 
    // keep the request in the conversation, so a "yes" to the question below knows what to try again
    const said = "Something went wrong on my side and nothing was sent. Want me to try again? Reply yes and I will.";
    u.chat.push({ id: randomBytes(8).toString("hex"), at: d.now(), role: "user", content: text }, { id: randomBytes(8).toString("hex"), at: d.now(), role: "assistant", content: said }); d.store.save();
    await say(said); return; }

  if (SILENT.test(out.text)) return void console.log("[x] assistant judged it not a request, no reply");
  if (d.feeBps > 0) d.stamp(u, had, d.feeBps);
  console.log(`[x] replying: ${out.text.slice(0, 160)}`);
  await say(out.text, out.urls);
}

/* ---- the loop ---- */
export function xFromEnv(env: NodeJS.ProcessEnv = process.env): { keys: XKeys; userId: string; handle: string } | undefined {
  const { X_API_KEY: key, X_API_SECRET: secret, X_ACCESS_TOKEN: token, X_ACCESS_SECRET: tokenSecret, X_BOT_USER_ID: userId, X_BOT_HANDLE: handle } = env;
  return key && secret && token && tokenSecret && userId && handle ? { keys: { key, secret, token, tokenSecret }, userId, handle: handle.replace(/^@/, "") } : undefined;
}

/** Checks for new mentions every `everySeconds` and answers each in turn. The first run only notes where things stand, so old mentions are never replayed. */
export function startX(d: Omit<XDeps, "reply" | "botHandle">, cfg: NonNullable<ReturnType<typeof xFromEnv>>, everySeconds = 30, client = new XClient(cfg.keys)): NodeJS.Timeout {
  const deps: XDeps = { ...d, botHandle: cfg.handle, reply: (text, to, exclude) => client.reply(text, to, exclude) };
  let busy = false, lastErr = "", verified = false;
  console.log(`[x] X agent on as @${cfg.handle}, checking every ${everySeconds}s`);
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      if (!verified) {
        // the access token must belong to the bot account, or every reply would be posted as someone else, and read back as a new request
        const me = await client.me();
        if (me.id !== cfg.userId) { console.log(`[x] STOPPED: the access token in .env belongs to @${me.username}, not @${cfg.handle}. Make the access token while signed in as @${cfg.handle} (run: npm run x:authorize).`); busy = false; clearInterval(timer); return; }
        verified = true;
      }
      const since = d.store.kv["xSince"];
      const r = await client.mentions(cfg.userId, since);
      for (const t of r.tweets) {
        if (t.author_id === cfg.userId) continue;
        await handleMention(deps, t).catch((e: unknown) => console.log(`[x] mention ${t.id} failed: ${e instanceof Error ? e.message : e}`));
        d.store.kv["xSince"] = t.id; d.store.save();
      }
      if (!since && r.newest) { d.store.kv["xSince"] = r.newest; d.store.save(); }
    } catch (e) { const m = e instanceof Error ? e.message : String(e); if (m !== lastErr) console.log(`[x] ${m}`); lastErr = m; busy = false; return; }
    lastErr = "";
    busy = false;
  };
  const timer = setInterval(() => void tick(), everySeconds * 1000).unref();
  void tick();
  return timer;
}

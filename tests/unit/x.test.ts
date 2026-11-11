import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentStore, type UserRec } from "../../src/agent/index.js";
import { fit, handleMention, hideAddresses, oauthSignature, XClient, type XDeps } from "../../src/server/x.js";

test("signing matches the worked example in X's own documentation", () => {
  const sig = oauthSignature("POST", "https://api.twitter.com/1.1/statuses/update.json", {
    status: "Hello Ladies + Gentlemen, a signed OAuth request!", include_entities: "true", oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
    oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature_method: "HMAC-SHA1", oauth_timestamp: "1318622958",
    oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version: "1.0",
  }, "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE");
  assert.equal(sig, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
});

test("a reply always fits in one post, links counted at their short length", () => {
  const long = "word ".repeat(200);
  const out = fit(long, ["https://moopay.cash/p/abc"]);
  assert.ok(out.split("\n")[0]!.length + 23 + 1 <= 280);
  assert.ok(out.endsWith("https://moopay.cash/p/abc"));
  assert.equal(fit("short", []), "short");
});

async function setup(over: Partial<XDeps> = {}) {
  const store = await AgentStore.open(join(mkdtempSync(join(tmpdir(), "moopay-x-")), "a.json"));
  const u = store.open("a".repeat(43));
  const replies: { text: string; to: string }[] = [], asked: string[] = [], charged: number[] = [];
  const d: XDeps = {
    store, botHandle: "moopay", feeBps: 200, now: () => 1_800_000_000_000,
    ask: async (_u, text) => { asked.push(text); return { text: "OK, done.", urls: [] }; },
    stamp: (u, had, bps) => { for (const p of u.payments) if (!had.has(p.id)) { charged.push(bps); } },
    reply: async (text, to) => { replies.push({ text, to }); },
    ...over,
  };
  return { store, u, d, replies, asked, charged };
}

test("X: a one-time code links an X account; a stranger gets one hint a day; a linked user is handled as a chat message", async () => {
  const s = await setup();
  // a stranger
  await handleMention(s.d, { id: "1", text: "@moopay send $5 to bob.near", author_id: "x1", username: "stranger" });
  await handleMention(s.d, { id: "2", text: "@moopay hello", author_id: "x1", username: "stranger" });
  assert.equal(s.replies.length, 1, "one polite hint, not one per mention");
  assert.match(s.replies[0]!.text, /link my X account/);
  assert.equal(s.asked.length, 0, "nothing reached the assistant");
  // linking
  await handleMention(s.d, { id: "3", text: "@moopay link moo-WRONG1", author_id: "x2", username: "alice" });
  assert.match(s.replies.at(-1)!.text, /didn't work/);
  const code = (s.store as unknown as { linkCode(u: UserRec, n: number): string }).linkCode(s.u, s.d.now());
  await handleMention(s.d, { id: "4", text: `@moopay link ${code.toLowerCase()}`, author_id: "x2", username: "Alice" });
  assert.match(s.replies.at(-1)!.text, /Linked/);
  assert.equal(s.u.x?.handle, "alice");
  await handleMention(s.d, { id: "5", text: `@moopay link ${code}`, author_id: "x3", username: "mallory" });
  assert.match(s.replies.at(-1)!.text, /didn't work/, "a code works once");
  // a linked user
  await handleMention(s.d, { id: "6", text: "@moopay send $5 to bob.near", author_id: "x2", username: "alice" });
  assert.deepEqual(s.asked, ["send $5 to bob.near"], "the bot's own handle is stripped");
  assert.equal(s.replies.at(-1)!.to, "6");
  assert.match(s.replies.at(-1)!.text, /^OK, done\./);
});

test("X: a linked handle in a message becomes that person's wallet, and the 1% fee is taken once per paid payment", async () => {
  const s = await setup();
  s.u.x = { id: "x2", handle: "alice" };
  const friend = s.store.open("b".repeat(43)); friend.x = { id: "x9", handle: "bobby" };
  s.d.ask = async (u, text) => {
    s.asked.push(text);
    u.payments.unshift({ id: "p1", kind: "send", amountUsd: 10, chain: "near", recipient: "r", status: "DELIVERED", createdAt: 1, settled: true });
    u.payments.unshift({ id: "p2", kind: "send", amountUsd: 50, chain: "near", recipient: "r", status: "AWAITING_YOUR_SIGNATURE", createdAt: 1 });
    return { text: "Sent.", urls: ["https://moopay.cash/p/z"] };
  };
  await handleMention(s.d, { id: "7", text: "@moopay send $10 to @bobby", author_id: "x2", username: "alice" });
  assert.equal(s.asked[0], `send $10 to ${friend.accountId}`);
  assert.deepEqual(s.charged, [200, 200], "the payments of this turn are marked with the 2% X rate");
  assert.ok(s.replies.at(-1)!.text.endsWith("https://moopay.cash/p/z"));
  // fee off: nothing marked
  const off = await setup({ feeBps: 0 }); off.u.x = { id: "x2", handle: "alice" };
  off.d.ask = async (u) => { u.payments.unshift({ id: "p", kind: "send", amountUsd: 10, chain: "near", recipient: "r", status: "DELIVERED", createdAt: 1, settled: true }); return { text: "Sent.", urls: [] }; };
  await handleMention(off.d, { id: "8", text: "@moopay send $10 to bob.near", author_id: "x2" });
  assert.deepEqual(off.charged, []);
});

test("X: the client signs requests and reads mentions oldest first", async () => {
  const seen: { url: string; auth: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => { seen.push({ url, auth: String((init.headers as Record<string, string>)["authorization"]) }); return { ok: true, json: async () => ({ data: [{ id: "30", text: "b", author_id: "u1" }, { id: "20", text: "a", author_id: "u1" }], includes: { users: [{ id: "u1", username: "alice" }] }, meta: { newest_id: "30" } }) } as Response; }) as unknown as typeof fetch;
  const c = new XClient({ key: "k", secret: "s", token: "t", tokenSecret: "ts" }, fake, () => 1_800_000_000_000);
  const first = await c.mentions("bot");
  assert.deepEqual(first.tweets, [], "the first look only notes where things stand");
  assert.equal(first.newest, "30");
  const r = await c.mentions("bot", "10");
  assert.deepEqual(r.tweets.map((t) => t.id), ["20", "30"]);
  assert.equal(r.tweets[0]!.username, "alice");
  assert.match(seen[1]!.url, /since_id=10/);
  assert.match(seen[1]!.auth, /^OAuth .*oauth_signature="/);
});

test("X: chat about the product is ignored; only requests to move money are answered", async () => {
  const s = await setup();
  const say = (text: string, id: string, author = "x1") => handleMention(s.d, { id, text: "@moopay " + text, author_id: author, username: "someone" });
  // strangers: nothing for praise or questions, one hint only for a real request
  for (const [i, t] of ["love this product!", "how does MooPay work?", "how do I send money with this?", "gm @moopay"].entries()) await say(t, String(i));
  assert.equal(s.replies.length, 0, "no reply to chat, and no AI call");
  await say("send 5 usdc to bob.near", "10");
  assert.equal(s.replies.length, 1);
  // a linked user: chat without any money word never reaches the AI; a question that does is judged by the assistant, who stays silent
  s.u.x = { id: "x2", handle: "alice" };
  await say("great app, what chains do you support?", "11", "x2");
  assert.equal(s.asked.length, 0);
  s.d.ask = async (_u, text) => { s.asked.push(text); return { text: "IGNORE", urls: [] }; };
  const before = s.replies.length;
  await say("can I send to solana?", "12", "x2");
  assert.equal(s.asked.length, 1, "the assistant is asked, because it mentions sending");
  assert.equal(s.replies.length, before, "but its IGNORE is not posted");
  assert.deepEqual(s.charged, []);
});

test("X: when the assistant itself fails, the user is told and asked, and a yes has the request to go on", async () => {
  const s = await setup({ ask: async () => { throw new Error("down"); } });
  s.u.x = { id: "x2", handle: "alice" };
  await handleMention(s.d, { id: "10", text: "@moopay send $1 to bob.near", author_id: "x2", username: "alice" });
  assert.match(s.replies.at(-1)!.text, /Want me to try again\? Reply yes/);
  assert.equal(s.u.chat.at(-2)?.content, "send $1 to bob.near");
});

test("X: a reply never carries a full crypto address", () => {
  assert.equal(hideAddresses("Send $0.50 to CkexRjpqtT2y3prduUr7Ah8jbwtWazF8phsitDGnyzya on Solana, fee $0.005."), "Send $0.50 to Ckex...zya on Solana, fee $0.005.");
  assert.equal(hideAddresses("to 0x" + "ab".repeat(20)), "to 0xab...bab");
  assert.equal(hideAddresses("hello bob.near, $5"), "hello bob.near, $5");
});

test("X: a reply does not pull in other accounts tagged in the same post", async () => {
  const sent: { to: string; exclude?: string[] }[] = [];
  const s = await setup({ reply: async (_t, to, exclude) => { sent.push({ to, ...(exclude ? { exclude } : {}) }); } });
  s.u.x = { id: "x2", handle: "alice" };
  await handleMention(s.d, { id: "9", text: "@moopay @near_intents send $1 to bob.near", author_id: "x2", username: "alice", entities: { mentions: [{ id: "bot" }, { id: "x2" }, { id: "intents" }] } });
  assert.deepEqual(sent[0]!.exclude, ["bot", "intents"], "the author stays, everyone else is left out");
});

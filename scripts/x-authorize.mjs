// Makes the access token for the X account that will run the agent (sign in as that account when X asks).
// Usage: npm run x:authorize   (needs X_API_KEY and X_API_SECRET in .env)
import { createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const key = process.env.X_API_KEY, secret = process.env.X_API_SECRET;
if (!key || !secret) { console.log("Set X_API_KEY and X_API_SECRET in .env first."); process.exit(1); }
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function call(url, extra, tokenSecret = "") {
  const oauth = { oauth_consumer_key: key, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: "1.0", ...extra };
  const base = ["POST", enc(url), enc(Object.entries(oauth).map(([k, v]) => [enc(k), enc(v)]).sort().map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  oauth.oauth_signature = createHmac("sha1", `${enc(secret)}&${enc(tokenSecret)}`).update(base).digest("base64");
  const res = await fetch(url, { method: "POST", headers: { authorization: "OAuth " + Object.entries(oauth).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ") } });
  const text = await res.text();
  if (!res.ok) { console.log(`X answered ${res.status}: ${text}`); process.exit(1); }
  return new URLSearchParams(text);
}
const req = await call("https://api.x.com/oauth/request_token", { oauth_callback: "oob" });
console.log(`\n1. Open this link, signed in as the bot account, and click Authorize:\n   https://api.x.com/oauth/authorize?oauth_token=${req.get("oauth_token")}\n`);
const pin = (await createInterface({ input: process.stdin, output: process.stdout }).question("2. Type the PIN X shows you: ")).trim();
const acc = await call("https://api.x.com/oauth/access_token", { oauth_token: req.get("oauth_token"), oauth_verifier: pin }, req.get("oauth_token_secret"));
console.log(`\nPut these in .env, then restart the server (this is @${acc.get("screen_name")}, id ${acc.get("user_id")}):\n\nX_ACCESS_TOKEN=${acc.get("oauth_token")}\nX_ACCESS_SECRET=${acc.get("oauth_token_secret")}\nX_BOT_USER_ID=${acc.get("user_id")}\nX_BOT_HANDLE=${acc.get("screen_name")}\n`);
process.exit(0);

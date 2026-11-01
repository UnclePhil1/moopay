import { $, api, connect, initWallets, key, say, selector, short } from "./common.js";

interface View { state: string; amount: string; symbol: string; receiver: string; chain?: string; sender?: string; expiresAt?: string; claimTx?: string }
interface Challenge { message: string; recipient: string; nonce: string; chain?: string }

let view: View;

function done(tx: string | undefined, other = false) {
  $("form").classList.add("hidden");
  $("title").textContent = "Claimed";
  $("done").classList.remove("hidden");
  const a = $<HTMLAnchorElement>("tx");
  if (other) { $("title").textContent = "Claimed. On its way"; $("sub").textContent = `${view.chain!.toUpperCase()} USDC arrives in your wallet in a few minutes.`; }
  if (tx) { a.href = `https://nearblocks.io/txns/${encodeURIComponent(tx)}`; a.textContent = `View transaction · ${short(tx)}`; }
  else a.classList.add("hidden");
}

/* Solana and EVM receivers sign with the wallet already in their browser (Phantom, Solflare, MetaMask, Rabby...). */
const hexOf = (t: string) => "0x" + Array.from(new TextEncoder().encode(t), (b) => b.toString(16).padStart(2, "0")).join("");
async function signOther(chain: string, ch: Challenge): Promise<{ accountId: string; signature: string }> {
  const w = window as unknown as Record<string, any>;
  if (chain === "sol") {
    const p = w["phantom"]?.solana ?? w["solana"] ?? w["solflare"];
    if (!p) throw new Error("No Solana wallet found in this browser. Open this link in a browser with Phantom or Solflare.");
    const conn = await p.connect();
    const address = String((conn?.publicKey ?? p.publicKey).toString());
    if (address !== view.receiver) throw new Error(`This is for ${short(view.receiver)}. Your wallet is ${short(address)}. Switch accounts in your wallet and try again.`);
    const out = await p.signMessage(new TextEncoder().encode(ch.message), "utf8");
    const sig: Uint8Array = out.signature ?? out;
    return { accountId: address, signature: btoa(String.fromCharCode(...sig)) };
  }
  const e = w["ethereum"];
  if (!e) throw new Error("No Ethereum wallet found in this browser. Open this link in a browser with MetaMask or Rabby.");
  const accounts: string[] = await e.request({ method: "eth_requestAccounts" });
  const address = accounts[0] ?? "";
  if (address.toLowerCase() !== view.receiver.toLowerCase()) throw new Error(`This is for ${short(view.receiver)}. Your wallet is ${short(address)}. Switch accounts in your wallet and try again.`);
  const signature: string = await e.request({ method: "personal_sign", params: [hexOf(ch.message), address] });
  return { accountId: address, signature };
}

async function claim() {
  const btn = $<HTMLButtonElement>("claim");
  btn.disabled = true;
  try {
    const other = view.chain && view.chain !== "near";
    if (other) {
      say("msg", "Sign to prove it's you. This costs nothing.");
      const ch = await api<Challenge>(`/capi/${key}/challenge`);
      const proof = await signOther(view.chain!, ch);
      say("msg", "Claiming…");
      const r = await api<{ claimTx?: string }>(`/capi/${key}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof) });
      done(r.claimTx, true);
      return;
    }
    say("msg", "Connect your wallet…");
    const account = await connect();
    if (account !== view.receiver) {
      await (await selector.wallet()).signOut();
      throw new Error(`This is for ${view.receiver}. You connected ${account}. Press Claim and choose the right wallet.`);
    }
    say("msg", "Sign to prove it's you. This costs nothing.");
    const ch = await api<Challenge>(`/capi/${key}/challenge`);
    const wallet = await selector.wallet();
    if (!("signMessage" in wallet) || typeof wallet.signMessage !== "function") throw new Error("This wallet can't sign messages. Please use Meteor or Nightly.");
    const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: Buffer.from(ch.nonce, "base64") });
    if (!signed) throw new Error("This wallet didn't return a signature. Please use Meteor or Nightly.");
    say("msg", "Claiming…");
    const r = await api<{ claimTx?: string }>(`/capi/${key}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature }),
    });
    done(r.claimTx);
  } catch (e) {
    say("msg", e instanceof Error ? e.message : "Something went wrong.", "err");
    btn.disabled = false;
  }
}

async function main() {
  try {
    view = await api<View>(`/capi/${key}`);
  } catch (e) {
    $("title").textContent = "Link not valid";
    say("msg", e instanceof Error ? e.message : "This link is not valid.", "err");
    return;
  }
  await initWallets();
  const title = (t: string, sub = "") => { $("title").textContent = t; $("sub").textContent = sub; };
  const rows: [string, string][] = [["For", short(view.receiver)]];
  if (view.sender) rows.push(["From", short(view.sender)]);
  if (view.expiresAt) rows.push(["Claim before", new Date(view.expiresAt).toLocaleString()]);
  for (const [a, b] of rows) {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("span"); l.textContent = a;
    const v = document.createElement("b"); v.textContent = b;
    r.append(l, v);
    $("summary").append(r);
  }
  switch (view.state) {
    case "FUNDED":
      title(`${view.amount} for you`, view.chain && view.chain !== "near" ? `Sign with your ${view.chain.toUpperCase()} wallet to claim it. You get USDC on ${view.chain.toUpperCase()}.` : "Sign with your wallet to claim it");
      $("form").classList.remove("hidden");
      $("claim").addEventListener("click", () => void claim());
      break;
    case "CLAIMED": return done(view.claimTx, !!view.chain && view.chain !== "near");
    case "REFUNDED": title("Expired", "This was not claimed in time and went back to the sender."); break;
    case "CLAIMING": title("Claiming…", "Check again in a moment."); break;
    default: title("Not ready yet", "The sender hasn't finished sending. Try again soon.");
  }
}

void main();

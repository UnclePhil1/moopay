import { actions } from "near-api-js";
import { $, api, connect, initWallets, key, say, selector, short, wireCopy } from "./wallet.js";

const TGAS = 10n ** 12n;
const REGISTRATION = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR

interface View { amount: string; symbol: string; receiver: string; state: string }
interface Status { state: string; claimLink?: string; expiresAt?: string }
interface Plan { noteAccountId: string; gasNear: string; token?: { contract: string; amount: string; needsRegistration: boolean } }

let view: View;

function showShare(s: Status) {
  $("form").classList.add("hidden");
  $("title").textContent = "Ready to share";
  $("share").classList.remove("hidden");
  $("link").textContent = s.claimLink ?? "";
  $<HTMLInputElement>("linkval").value = s.claimLink ?? "";
  $("sharenote").textContent = `Send this private link to ${view.receiver}. Only that wallet can claim it. If it isn't claimed within 24 hours, the money comes back to you.`;
}

async function waitFunded() {
  say("msg", "Waiting for the network to confirm…");
  for (;;) {
    try {
      const s = await api<Status>(`/fapi/${key}/status`);
      if (s.state !== "AWAITING_FUNDING") return showShare(s);
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function send() {
  const btn = $<HTMLButtonElement>("send");
  btn.disabled = true;
  try {
    say("msg", "Connect your wallet…");
    const account = await connect();
    say("msg", "Preparing…");
    const p = await api<Plan>(`/fapi/${key}/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sender: account }) });
    say("msg", "Approve in your wallet…");
    const wallet = await selector.wallet();
    const tokenActions = !p.token ? [] : [
      ...(p.token.needsRegistration
        ? [actions.functionCall("storage_deposit", { account_id: p.noteAccountId, registration_only: true }, 30n * TGAS, REGISTRATION)]
        : []),
      actions.functionCall("ft_transfer", { receiver_id: p.noteAccountId, amount: p.token.amount }, 30n * TGAS, 1n),
    ];
    const transactions = [{ signerId: account, receiverId: p.noteAccountId, actions: [actions.transfer(BigInt(p.gasNear))] as never }];
    if (p.token) transactions.push({ signerId: account, receiverId: p.token.contract, actions: tokenActions as never });
    await wallet.signAndSendTransactions({ transactions });
    await waitFunded();
  } catch (e) {
    say("msg", e instanceof Error ? e.message : "Something went wrong.", "err");
    btn.disabled = false;
  }
}

async function main() {
  try {
    view = await api<View>(`/fapi/${key}`);
  } catch (e) {
    $("title").textContent = "Link expired";
    say("msg", e instanceof Error ? e.message : "This link is not valid.", "err");
    return;
  }
  await initWallets();
  $("title").textContent = `Send ${view.amount}`;
  $("sub").textContent = "privately, to one wallet";
  const rows: [string, string][] = [["Receiver", short(view.receiver)], ["They can claim", "within 24 hours"], ["If unclaimed", "comes back to you"]];
  for (const [a, b] of rows) {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("span"); l.textContent = a;
    const v = document.createElement("b"); v.textContent = b;
    r.append(l, v);
    $("summary").append(r);
  }
  wireCopy("copy", () => $<HTMLInputElement>("linkval").value);
  if (view.state !== "AWAITING_FUNDING") {
    const s = await api<Status>(`/fapi/${key}/status`);
    if (s.claimLink) return showShare(s);
  }
  $("form").classList.remove("hidden");
  $("send").addEventListener("click", () => void send());
}

void main();

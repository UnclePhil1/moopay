import { actions as najActions } from "near-api-js";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";

interface Asset { assetId: string; symbol: string; decimals: number; contract: string; native: boolean }
interface Intent {
  destinationChain: string; destinationSymbol: string; destinationDecimals: number;
  recipient: string; payAmount: string; assets: Asset[];
}
interface Quote {
  depositAddress: string; depositMemo?: string;
  transfer: { contract: string; receiverId: string; amount: string; needsRegistration: boolean; native: boolean; wrapDeposit?: string };
}

const parts = location.pathname.split("/");
const isPublic = parts[1] === "p"; // /p/<id>: public link made by the agent, no shared secret in it
const id = isPublic ? parts[2] : parts[3];
const base = isPublic ? `/papi/${id}` : `/api/${parts[2]}/intent/${id}`;
const $ = <T extends HTMLElement>(i: string) => document.getElementById(i) as T;

const CHAINS: Record<string, string> = { btc: "Bitcoin", sol: "Solana", eth: "Ethereum" };
const TGAS = 10n ** 12n;
const REGISTRATION_DEPOSIT = "1250000000000000000000"; // 0.00125 NEAR (NEP-145 minimum)

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { message?: string } & T;
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body;
}

function fmt(units: string | undefined, decimals: number): string {
  if (!units) return "…";
  const s = units.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
}
const short = (a: string) => (a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

function say(el: string, text: string, kind: "" | "err" | "ok" = "") {
  const e = $(el);
  e.textContent = text;
  e.className = `msg ${kind}`;
}

let selector: WalletSelector;
let intent: Intent;

function accountId(): string | undefined {
  return selector.store.getState().accounts.find((a) => a.active)?.accountId ?? selector.store.getState().accounts[0]?.accountId;
}

function connect(): Promise<string> {
  const existing = accountId();
  if (existing) return Promise.resolve(existing);
  const modal = setupModal(selector, { description: "Choose the wallet you will pay from." });
  return new Promise((resolve, reject) => {
    const sub = selector.store.observable.subscribe((s) => {
      const a = s.accounts[0]?.accountId;
      if (a) { sub.unsubscribe(); resolve(a); }
    });
    modal.on("onHide", () => { if (!accountId()) { sub.unsubscribe(); reject(new Error("Wallet connection was cancelled.")); } });
    modal.show();
  });
}

async function refreshEstimate() {
  const asset = $<HTMLSelectElement>("asset").value;
  $("est").textContent = "…";
  $("pay").textContent = "…";
  try {
    const e = await api<{ amountIn: string; payDecimals: number; paySymbol: string; expectedOutput: { amountOut?: string } }>(`${base}/estimate?asset=${encodeURIComponent(asset)}`);
    $("pay").textContent = `${fmt(e.amountIn, e.payDecimals)} ${e.paySymbol}`;
    $("est").textContent = `${fmt(e.expectedOutput.amountOut, intent.destinationDecimals)} ${intent.destinationSymbol}`;
  } catch {
    $("est").textContent = "unavailable";
    $("pay").textContent = "unavailable";
  }
}

async function track(depositAddress: string) {
  $("form").classList.add("hidden");
  $("deposit").classList.remove("hidden");
  $("addr").textContent = depositAddress;
  $("title").textContent = "Sending…";
  for (;;) {
    try {
      const s = await api<{ state: string; txHash?: string; explorerUrl?: string }>(`${base}/status`);
      if (s.state === "SUCCESS") {
        $("title").textContent = "Delivered";
        $("deposit").classList.add("hidden");
        const done = $("done");
        done.classList.remove("hidden");
        const link = $<HTMLAnchorElement>("tx");
        if (s.explorerUrl && s.txHash) {
          link.href = s.explorerUrl;
          link.textContent = `View transaction · ${short(s.txHash)}`;
        } else link.classList.add("hidden");
        return;
      }
      if (s.state === "REFUNDED" || s.state === "FAILED" || s.state === "INCOMPLETE_DEPOSIT") {
        $("title").textContent = s.state === "REFUNDED" ? "Refunded" : "Something went wrong";
        say("dmsg", s.state === "REFUNDED" ? "The swap did not go through and your money was sent back to your wallet." : `Status: ${s.state}. Ask your AI to check this payment.`, "err");
        return;
      }
      say("dmsg", s.state === "PENDING_DEPOSIT" ? "Waiting for your payment to arrive…" : "Payment received. Delivering…");
    } catch {
      say("dmsg", "Checking status…");
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

async function send() {
  const btn = $<HTMLButtonElement>("send");
  btn.disabled = true;
  try {
    say("msg", "Connect your wallet…");
    const account = await connect();
    say("msg", "Preparing your payment…");
    const originAssetId = $<HTMLSelectElement>("asset").value;
    const q = await api<Quote>(`${base}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originAssetId, refundTo: account }),
    });
    $("deposit").classList.remove("hidden");
    $("addr").textContent = q.depositAddress;
    sessionStorage.setItem(`moopay:${id}`, q.depositAddress); // for wallets that redirect and come back
    say("msg", "Approve the payment in your wallet…");

    // wallet-selector v10 takes near-api-js actions and converts them for each wallet.
    const call = (methodName: string, args: object, deposit: string) => najActions.functionCall(methodName, args, 30n * TGAS, BigInt(deposit));
    const actions = [
      // Plain NEAR: wrap it first, in the same signature (the contract is wrap.near).
      ...(q.transfer.native ? [call("near_deposit", {}, q.transfer.wrapDeposit ?? q.transfer.amount)] : []),
      ...(q.transfer.needsRegistration
        ? [call("storage_deposit", { account_id: q.transfer.receiverId, registration_only: true }, REGISTRATION_DEPOSIT)]
        : []),
      call("ft_transfer", { receiver_id: q.transfer.receiverId, amount: q.transfer.amount }, "1"),
    ];
    const wallet = await selector.wallet();
    await wallet.signAndSendTransaction({ signerId: account, receiverId: q.transfer.contract, actions: actions as never });
    await track(q.depositAddress);
  } catch (e) {
    btn.disabled = false;
    say("msg", e instanceof Error ? e.message : "Something went wrong.", "err");
  }
}

async function main() {
  try {
    intent = await api<Intent>(base);
  } catch (e) {
    $("title").textContent = "Link expired";
    say("top-msg", e instanceof Error ? e.message : "This link is not valid.", "err");
    return;
  }
  const setTitle = () => { $("title").textContent = `Send $${intent.payAmount}`; };
  setTitle();
  $("sub").textContent = `to ${CHAINS[intent.destinationChain] ?? intent.destinationChain}`;
  $("summary").innerHTML = "";
  const rows: [string, string][] = [["They receive", intent.destinationSymbol], ["Recipient", short(intent.recipient)]];
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.className = "row";
    const a = document.createElement("span"); a.textContent = k;
    const b = document.createElement("b"); b.textContent = v;
    r.append(a, b);
    $("summary").append(r);
  }
  const sel = $<HTMLSelectElement>("asset");
  for (const a of intent.assets) sel.add(new Option(a.native ? "NEAR (from your wallet)" : `${a.symbol} on NEAR`, a.assetId));
  setTitle();
  sel.addEventListener("change", () => { setTitle(); void refreshEstimate(); });
  $("form").classList.remove("hidden");
  $<HTMLButtonElement>("copy").addEventListener("click", () => {
    void navigator.clipboard?.writeText($("addr").textContent ?? "");
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  });
  $<HTMLButtonElement>("send").addEventListener("click", () => void send());

  selector = await setupWalletSelector({
    network: "mainnet",
    modules: [setupMeteorWallet(), setupNightly(), setupMyNearWallet()],
  });
  void refreshEstimate();

  // A redirect wallet (MyNearWallet) returns here after signing.
  const pending = sessionStorage.getItem(`moopay:${id}`);
  if (pending && /transactionHashes/.test(location.search)) void track(pending);
}

void main();

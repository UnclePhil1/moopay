import { actions as najActions } from "near-api-js";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createAppKit, type AppKit } from "@reown/appkit";
import { mainnet, base as baseNet, arbitrum, optimism, polygon, bsc, avalanche, solana } from "@reown/appkit/networks";

interface Asset { assetId: string; symbol: string; decimals: number; contract: string; native: boolean; chain: string; chainId?: number }
interface Intent {
  destinationChain: string; destinationSymbol: string; destinationDecimals: number;
  recipient: string; payAmount: string; fund?: boolean; call?: Call; assets: Asset[]; wcProjectId?: string; fromChain?: string; fromSymbol?: string; stake?: { payout: string };
}
/** One contract call signed in the user's own NEAR wallet: unstaking or withdrawing. */
interface Call { account: string; contract: string; method: string; args: Record<string, unknown>; title: string; lines: [string, string][] }
interface Quote {
  depositAddress: string; depositMemo?: string; chain: string; direct?: boolean;
  transfer: { kind: "near" | "evm" | "sol"; amount: string; native: boolean; contract: string; receiverId: string; needsRegistration: boolean; wrapDeposit?: string; to: string; chainId?: number };
}
type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
type Phantom = { connect(): Promise<{ publicKey: { toString(): string } }>; request(a: { method: string; params: unknown }): Promise<unknown> };
const w = window as unknown as { ethereum?: Eip1193; phantom?: { solana?: Phantom }; solana?: Phantom };

const parts = location.pathname.split("/");
const isPublic = parts[1] === "p"; // /p/<id>: public link made by the agent, no shared secret in it
const id = isPublic ? parts[2] : parts[3];
const base = isPublic ? `/papi/${id}` : `/api/${parts[2]}/intent/${id}`;
const $ = <T extends HTMLElement>(i: string) => document.getElementById(i) as T;

/* Inside the chat's pay window the page is a frame, and a browser will not open a wallet app from a frame. Wallet links open from the top page instead. */
if (window.parent !== window) {
  const open = window.open.bind(window);
  window.open = ((u?: string | URL, t?: string, f?: string) => { try { return window.top!.open(u, t === "_self" ? "_blank" : t, f); } catch { return open(u, t, f); } }) as typeof window.open;
}

/** A picker in the app's own style that drives a hidden <select>, so the rest of the page keeps working as before. */
function fancy(sel: HTMLSelectElement) {
  const wrap = document.createElement("div"), btn = document.createElement("button"), list = document.createElement("div");
  wrap.className = "dd"; btn.type = "button"; btn.className = "dd-btn"; list.className = "dd-list"; list.setAttribute("role", "listbox");
  btn.setAttribute("aria-haspopup", "listbox");
  sel.style.display = "none";
  sel.after(wrap); wrap.append(btn, list);
  const badge = (t: string) => { const b = document.createElement("span"); b.className = "dd-badge"; b.textContent = t.replace(/[^A-Za-z0-9]/g, "").slice(0, 3); return b; };
  const chev = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "chev"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", "M6 9l6 6 6-6"); s.append(p); return s; };
  const tick = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "tick"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", "M5 12l5 5 9-10"); s.append(p); return s; };
  const close = () => { wrap.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
  const sync = () => {
    const cur = sel.selectedOptions[0];
    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = cur?.text ?? "";
    btn.replaceChildren(...(cur ? [badge(cur.text)] : []), lab, chev());
    list.replaceChildren(...[...sel.options].map((o) => {
      const it = document.createElement("button"); it.type = "button"; it.className = "dd-opt"; it.setAttribute("role", "option"); it.setAttribute("aria-selected", String(o.value === sel.value));
      const t = document.createElement("span"); t.textContent = o.text;
      it.append(badge(o.text), t, tick());
      it.addEventListener("click", () => { const changed = sel.value !== o.value; sel.value = o.value; sync(); close(); if (changed) sel.dispatchEvent(new Event("change")); });
      return it;
    }));
  };
  btn.addEventListener("click", () => { const open = !wrap.classList.contains("open"); document.querySelectorAll(".dd.open").forEach((d) => d.classList.remove("open")); wrap.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open)); if (open) list.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest" }); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target as Node)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  sync();
  return { sync };
}

const CHAINS: Record<string, string> = { btc: "Bitcoin", sol: "Solana", eth: "Ethereum", near: "NEAR", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", bsc: "BNB Chain", avax: "Avalanche" };
/** Reown registry ids: MetaMask, Trust, Phantom, Coinbase, Rainbow, Solflare, OKX, Binance. */
const WALLET_IDS = [
  "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96", "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0", "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393",
  "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa", "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369", "1ca0bdd4747578705b1939af023d120677c64fe6ca76add81fda36e350605e79",
  "971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709", "8a0ee50d1f22f6651afcae7eb4253e52a3310b90af5daef78a8c4929a9bb99d4",
];
const WC_NETS: Record<string, { net: unknown; caip: string }> = {
  eth: { net: mainnet, caip: "eip155:1" }, base: { net: baseNet, caip: "eip155:8453" }, arb: { net: arbitrum, caip: "eip155:42161" }, op: { net: optimism, caip: "eip155:10" },
  pol: { net: polygon, caip: "eip155:137" }, bsc: { net: bsc, caip: "eip155:56" }, avax: { net: avalanche, caip: "eip155:43114" }, sol: { net: solana, caip: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
};
const chainName = (c: string) => CHAINS[c] ?? c.toUpperCase();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad address"); n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)]! + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = "1" + s; }
  return s;
}
/** An unsigned legacy transaction with one System Program transfer, ready for the wallet to sign and send. */
function solTransfer(from: string, to: string, lamports: bigint, blockhash: string): Uint8Array {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  const msg = [1, 0, 1, 3, ...b58decode(from), ...b58decode(to), ...new Uint8Array(32), ...b58decode(blockhash), 1, 2, 2, 0, 1, 12, ...data];
  return Uint8Array.from([1, ...new Uint8Array(64), ...msg]);
}
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

/** Asks which wallet to sign with. Nothing opens until the person picks one. */
function choose<T>(title: string, options: { label: string; go: () => Promise<T> }[]): Promise<T> {
  const box = $("pickbox"), list = $("picklist");
  $("picktitle").textContent = title;
  list.replaceChildren();
  return new Promise<T>((resolve, reject) => {
    const done = (fn: () => void) => { box.classList.add("hidden"); fn(); };
    const add = (label: string, ghost: boolean, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = ghost ? "btn ghost" : "btn"; b.textContent = label; b.onclick = onClick;
      list.append(b);
    };
    for (const o of options) add(o.label, false, () => done(() => o.go().then(resolve, reject)));
    add("Cancel", true, () => done(() => reject(new Error("Wallet connection was cancelled."))));
    box.classList.remove("hidden");
  });
}

/** Wallets that announce themselves in this browser (EIP-6963), so every installed EVM wallet can be offered by name. */
interface EvmWallet { info: { name: string }; provider: Eip1193 }
const evmWallets: EvmWallet[] = [];
window.addEventListener("eip6963:announceProvider", (e) => { const d = (e as CustomEvent<EvmWallet>).detail; if (!evmWallets.some((x) => x.provider === d.provider)) evmWallets.push(d); });
window.dispatchEvent(new Event("eip6963:requestProvider"));

let pickedNear: string | undefined;
async function connect(): Promise<string> {
  const existing = accountId();
  if (existing && pickedNear === existing) return existing;
  if (existing) {
    const keep = await choose("Sign with", [{ label: `Continue with ${existing}`, go: async () => true }, { label: "Use a different wallet", go: async () => false }]);
    if (keep) return (pickedNear = existing);
    await (await selector.wallet()).signOut();
  }
  return pickedNear = await pickNear();
}
function pickNear(): Promise<string> {
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

async function track(depositAddress: string, manual = false) {
  $("form").classList.add("hidden");
  $("deposit").classList.remove("hidden");
  $("addr").textContent = depositAddress;
  for (const el of [$("dlabel"), $("addr").parentElement!]) el.classList.toggle("hidden", !manual); // a signed payment needs no address on screen
  if (!manual) $("exactrow").classList.add("hidden");
  $("title").textContent = manual ? "Waiting for your payment" : "Sending…";
  for (;;) {
    try {
      const s = await api<{ state: string; txHash?: string; explorerUrl?: string; direct?: boolean }>(`${base}/status`);
      if (s.state === "SUCCESS") {
        $("title").textContent = intent.stake ? "Staking" : "Delivered";
        if (intent.stake) { $("doneline").textContent = "Your money arrived."; $("donenote").textContent = "MooPay is staking it now and sending the rNEAR to your wallet. You'll see it in your chat."; }
        if (window.parent !== window) window.parent.postMessage({ moopay: "delivered", wait: Boolean(intent.stake) }, location.origin);
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
      const where = CHAINS[intent.destinationChain] ?? intent.destinationChain;
      say("dmsg", s.direct ? `Sent. Confirming on ${where}…` : s.state === "PENDING_DEPOSIT" ? "Your payment is on its way…" : `Moving your money to ${where}…`);
    } catch {
      say("dmsg", "Checking status…");
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

const chosen = () => intent.assets.find((a) => a.assetId === $<HTMLSelectElement>("asset").value)!;
const getQuote = (originAssetId: string, refundTo: string) =>
  api<Quote>(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ originAssetId, refundTo }) });

/** The always-works way: show the exact amount and address so any wallet can pay it. */
function showManual(q: Quote, a: Asset) {
  $("form").classList.add("hidden");
  $("deposit").classList.remove("hidden");
  $("dlabel").textContent = `Send this from your ${chainName(a.chain)} wallet`;
  $("exactlabel").textContent = intent.fund ? "Send about" : "Send exactly";
  $("exact").textContent = `${fmt(q.transfer.amount, a.decimals)} ${a.symbol}${q.depositMemo ? ` · memo ${q.depositMemo}` : ""}`;
  $("exactrow").classList.remove("hidden");
}

/** Any wallet on a phone or desktop, picked in a WalletConnect modal that opens the wallet app to approve. */
type Conn = { account: string; request: (method: string, params: unknown) => Promise<unknown> };
let kit: AppKit | undefined;
async function wcConnect(chain: string): Promise<Conn> {
  if (!intent.wcProjectId) throw new Error("No wallet found in this browser, and wallet connections are not set up on this server yet. Use the deposit address.");
  const net = WC_NETS[chain]!;
  kit ??= createAppKit({
    projectId: intent.wcProjectId, networks: [mainnet, baseNet, arbitrum, optimism, polygon, bsc, avalanche, solana], themeMode: "dark",
    // The wallets people actually use, instead of Reown's full catalogue. Wallets installed in this browser always show first.
    includeWalletIds: WALLET_IDS, allWallets: "HIDE", enableWalletGuide: false,
    // Where the wallet app sends the user back to after approving.
    metadata: { name: "MooPay", description: "Private payments", url: location.origin, icons: [`${location.origin}/p/assets/favicon.png`], redirect: { universal: location.href.split("#")[0]! } } as never,
    features: { analytics: false, email: false, socials: false, onramp: false, swaps: false },
  });
  const k = kit;
  await k.switchNetwork(net.net as never);
  const ns = chain === "sol" ? "solana" : "eip155";
  if (!k.getAddress(ns)) {
    await new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => { offAcc(); offState(); fn(); };
      const offAcc = k.subscribeAccount((acc) => { if (acc.isConnected && acc.address) done(resolve); }, ns);
      const offState = k.subscribeState((st) => { if (!st.open && !k.getAddress(ns)) setTimeout(() => { if (!k.getAddress(ns)) done(() => reject(new Error("Wallet connection was cancelled."))); }, 600); });
      void k.open();
    });
  }
  const address = k.getAddress(ns);
  const provider = k.getProvider(ns) as { request(a: { method: string; params: unknown }, chain?: string): Promise<unknown> } | undefined;
  if (!address || !provider) throw new Error("Your wallet did not connect. Try again.");
  return { account: address, request: (method, params) => provider.request({ method, params }, net.caip) };
}

/** USDC / USDT on Solana: make sure the receiving token account exists (the payer funds it if not), then transfer. */
function solTokenTransfer(from: string, to: string, mint: string, amount: bigint, decimals: number, blockhash: string, destHasAccount = false): Uint8Array {
  const owner = new PublicKey(from), dest = new PublicKey(to), m = new PublicKey(mint);
  const src = getAssociatedTokenAddressSync(m, owner), dst = getAssociatedTokenAddressSync(m, dest, true);
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
  if (!destHasAccount) tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, dst, dest, m));
  tx.add(createTransferCheckedInstruction(src, m, dst, owner, amount, decimals));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/* Solana wallets announce themselves through the Wallet Standard (Solflare, Phantom, Backpack...). That is how the wallet inside a wallet app's browser is found. */
interface WsAccount { address: string; chains?: readonly string[] }
interface WsWallet { name: string; accounts: readonly WsAccount[]; features: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
const wsWallets: WsWallet[] = [];
{
  const api = { register: (...ws: WsWallet[]) => { for (const x of ws) if (!wsWallets.includes(x)) wsWallets.push(x); return () => undefined; } };
  window.addEventListener("wallet-standard:register-wallet", (e) => (e as CustomEvent<(a: typeof api) => void>).detail(api));
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
}
const canSend = (x: WsWallet) => Boolean(x.features["standard:connect"] && x.features["solana:signAndSendTransaction"]);
/** Injected wallets can appear a moment after the page loads, so look for a short while before giving up. */
async function findSolWallet(): Promise<WsWallet | undefined> {
  for (let i = 0; i < 12; i++) {
    const hit = wsWallets.find(canSend);
    if (hit) return hit;
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws: WsWallet[]) => { for (const x of ws) if (!wsWallets.includes(x)) wsWallets.push(x); return () => undefined; } } }));
    await new Promise((r) => setTimeout(r, 150));
  }
  return undefined;
}

type SolSigner = { account: string; send(tx: Uint8Array, bh: string): Promise<string | undefined> };
async function solSigner(): Promise<SolSigner> {
  await findSolWallet();
  const ph = w.phantom?.solana ?? w.solana;
  const options = wsWallets.filter(canSend).map((ws) => ({ label: ws.name, go: () => wsSigner(ws) }));
  if (ph && !options.length) options.push({ label: "Phantom", go: async () => phantomSigner(ph) });
  if (intent.wcProjectId || !options.length) options.push({ label: options.length ? "Another wallet (phone or app)" : "Connect a wallet", go: wcSolSigner });
  return choose("Choose the Solana wallet to sign with", options);
}
async function wsSigner(ws: WsWallet): Promise<SolSigner> {
  const { accounts } = (await ws.features["standard:connect"].connect()) as { accounts: readonly WsAccount[] };
  const acc = accounts[0] ?? ws.accounts[0];
  if (!acc) throw new Error(`${ws.name} did not share an account. Unlock it and try again.`);
  return { account: acc.address, send: async (tx) => { const r = (await ws.features["solana:signAndSendTransaction"].signAndSendTransaction({ account: acc, chain: "solana:mainnet", transaction: tx })) as { signature?: Uint8Array }[]; return r?.[0]?.signature ? b58encode(r[0].signature) : undefined; } };
}
async function phantomSigner(ph: Phantom): Promise<SolSigner> {
  return { account: (await ph.connect()).publicKey.toString(), send: async (tx) => { const r = (await ph.request({ method: "signAndSendTransaction", params: { message: b58encode(tx) } })) as { signature?: string } | undefined; return r?.signature; } };
}
async function wcSolSigner(): Promise<SolSigner> {
  const conn = await wcConnect("sol");
  return {
    account: conn.account,
    send: async (tx) => {
      // WalletConnect wallets sign and hand back; we put the signature in and send it through the server.
      const res = (await conn.request("solana_signTransaction", { transaction: btoa(String.fromCharCode(...tx)), pubkey: conn.account })) as { signature?: string; transaction?: string };
      let signed = res.transaction;
      if (!signed && res.signature) { const t = Uint8Array.from(tx); t.set(b58decode(res.signature), 1); signed = btoa(String.fromCharCode(...t)); }
      if (!signed) throw new Error("no signature");
      return (await api<{ signature: string }>(`${base}/sol-send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: signed }) })).signature;
    },
  };
}

/** A straight transfer (same chain, same coin): tell the server which transaction the wallet sent so it can confirm it on-chain. */
const reportPaid = (tx: string) => api(`${base}/paid`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx }) });

async function sendOther(a: Asset) {
  if (a.chain === "sol") {
    const signer = await solSigner();
    say("msg", "Preparing your payment…");
    const q = await getQuote(a.assetId, signer.account);
    $("addr").textContent = q.depositAddress;
    const lamports = BigInt(q.transfer.amount);
    const have = await api<{ sol: string; token: string; destHasAccount: boolean }>(`${base}/sol-check?owner=${signer.account}${a.native ? "" : `&mint=${a.contract}&to=${q.transfer.to}`}`).catch(() => null);
    if (have) { // say what is missing here instead of letting the wallet show a failed simulation
      const fees = a.native ? 10_000n : have.destHasAccount ? 20_000n : 2_200_000n; // network fee, plus rent for a new token account
      const unit = 10 ** a.decimals, short = (n: bigint) => (Number(n) / unit).toLocaleString(undefined, { maximumFractionDigits: 6 });
      if (!a.native && BigInt(have.token) < lamports) throw new Error(`This wallet holds ${short(BigInt(have.token))} ${a.symbol} and this payment needs ${short(lamports)}. Add ${a.symbol} to it, or pick another asset.`);
      if (BigInt(have.sol) < (a.native ? lamports : 0n) + fees) throw new Error(`This wallet needs about ${(Number((a.native ? lamports : 0n) + fees) / 1e9).toFixed(4)} SOL for this payment and the network fee, and holds ${(Number(have.sol) / 1e9).toFixed(4)}. Add a little SOL and try again.`);
    }
    let sig: string | undefined;
    try {
      say("msg", "Approve the payment in your wallet…");
      const bh = await api<{ blockhash: string }>(`${base}/blockhash`);
      sig = await signer.send(a.native ? solTransfer(signer.account, q.transfer.to, lamports, bh.blockhash) : solTokenTransfer(signer.account, q.transfer.to, a.contract, lamports, a.decimals, bh.blockhash, have?.destHasAccount), bh.blockhash);
    } catch {
      showManual(q, a);
      $("dlabel").textContent = `Your wallet did not send it. Send this from your ${chainName(a.chain)} wallet yourself`;
      throw new Error("manual");
    }
    if (q.direct && sig) await reportPaid(sig);
    return q;
  }
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const injected = (eth: Eip1193) => async (): Promise<Conn> => {
    const account = ((await eth.request({ method: "eth_requestAccounts" })) as string[])[0]!;
    if (a.chainId) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + a.chainId.toString(16) }] });
    return { account, request: (method, params) => eth.request({ method, params: params as unknown[] }) };
  };
  const options = evmWallets.map((x) => ({ label: x.info.name, go: injected(x.provider) }));
  if (!options.length && w.ethereum) options.push({ label: "Browser wallet", go: injected(w.ethereum) });
  if (intent.wcProjectId || !options.length) options.push({ label: options.length ? "Another wallet (phone or app)" : "Connect a wallet", go: () => wcConnect(a.chain) });
  const conn = await choose<Conn>(`Choose the wallet to sign with on ${chainName(a.chain)}`, options);
  say("msg", "Preparing your payment…");
  const q = await getQuote(a.assetId, conn.account);
  $("addr").textContent = q.depositAddress;
  const hex = (n: bigint) => "0x" + n.toString(16);
  const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const amount = BigInt(q.transfer.amount);
  const tx = a.native ? { from: conn.account, to: q.transfer.to, value: hex(amount) } : { from: conn.account, to: a.contract, data: "0xa9059cbb" + pad(q.transfer.to) + pad(hex(amount)) };
  say("msg", "Approve the payment in your wallet…");
  let hash: unknown;
  try { hash = await conn.request("eth_sendTransaction", [tx]); }
  catch { showManual(q, a); $("dlabel").textContent = `Your wallet did not send it. Send this from your ${chainName(a.chain)} wallet yourself`; throw new Error("manual"); }
  if (q.direct && typeof hash === "string") await reportPaid(hash);
  return q;
}

/** Staking asks where the rNEAR goes before anything is signed. Paying with a NEAR wallet can offer that same wallet. */
async function settlePayout(a: Asset): Promise<boolean> {
  if (!intent.stake) return true;
  const input = $<HTMLInputElement>("payout");
  if (!input.value.trim() && a.chain === "near") {
    const account = await connect();
    $("usetext").textContent = `Receive your rNEAR in ${account}?`;
    $("usebox").classList.remove("hidden");
    const yes = await new Promise<boolean>((res) => { $("useyes").onclick = () => res(true); $("useno").onclick = () => res(false); });
    $("usebox").classList.add("hidden");
    if (yes) input.value = account;
  }
  const address = input.value.trim();
  if (!address) { say("msg", "Enter the NEAR wallet that should receive your rNEAR.", "err"); input.focus(); return false; }
  await api(`${base}/payout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
  return true;
}

async function manualQuote() {
  const a = chosen();
  const refund = $<HTMLInputElement>("refund").value.trim();
  if (!refund) return say("msg", "Enter your address on that chain first.", "err");
  try {
    if (!(await settlePayout(a))) return;
    const q = await getQuote(a.assetId, refund);
    $("addr").textContent = q.depositAddress;
    showManual(q, a);
    void track(q.depositAddress, true);
  } catch (e) { say("msg", e instanceof Error ? e.message : "Something went wrong.", "err"); }
}

async function send() {
  const btn = $<HTMLButtonElement>("send");
  btn.disabled = true;
  try {
    const a = chosen();
    if (!(await settlePayout(a))) { btn.disabled = false; return; }
    if (a.chain !== "near") {
      say("msg", "Connect your wallet…");
      const q = await sendOther(a);
      sessionStorage.setItem(`moopay:${id}`, q.depositAddress);
      await track(q.depositAddress);
      return;
    }
    say("msg", "Connect your wallet…");
    const account = await connect();
    say("msg", "Preparing your payment…");
    const originAssetId = a.assetId;
    const q = await getQuote(originAssetId, account);
    $("addr").textContent = q.depositAddress; // kept for the manual fallback; shown only if the wallet fails
    sessionStorage.setItem(`moopay:${id}`, q.depositAddress); // for wallets that redirect and come back
    say("msg", "Approve the payment in your wallet…");

    // wallet-selector v10 takes near-api-js actions and converts them for each wallet.
    const call = (methodName: string, args: object, deposit: string) => najActions.functionCall(methodName, args, 30n * TGAS, BigInt(deposit));
    const actions = q.direct && q.transfer.native ? [najActions.transfer(BigInt(q.transfer.amount))] : [ // a straight NEAR payment is one plain transfer
      // Plain NEAR: wrap it first, in the same signature (the contract is wrap.near).
      ...(q.transfer.native ? [call("near_deposit", {}, q.transfer.wrapDeposit ?? q.transfer.amount)] : []),
      ...(q.transfer.needsRegistration
        ? [call("storage_deposit", { account_id: q.transfer.receiverId, registration_only: true }, REGISTRATION_DEPOSIT)]
        : []),
      call("ft_transfer", { receiver_id: q.transfer.receiverId, amount: q.transfer.amount }, "1"),
    ];
    const wallet = await selector.wallet();
    const done = (await wallet.signAndSendTransaction({ signerId: account, receiverId: q.direct && q.transfer.native ? q.transfer.receiverId : q.transfer.contract, actions: actions as never })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | void;
    const hash = done?.transaction?.hash ?? done?.transaction_outcome?.id;
    if (q.direct && hash) await reportPaid(hash);
    await track(q.depositAddress);
  } catch (e) {
    btn.disabled = false;
    if (e instanceof Error && e.message === "manual") { void track($("addr").textContent ?? "", true); return; }
    say("msg", e instanceof Error ? e.message : "Something went wrong.", "err");
  }
}

const makeSelector = () => setupWalletSelector({ network: "mainnet", modules: [setupMeteorWallet(), setupNightly(), setupMyNearWallet()] });

/** Unstake or withdraw: the wallet that holds the rNEAR signs one call. MooPay never touches it. */
async function callMode(c: Call) {
  $("title").textContent = c.title;
  $("sub").textContent = "Signed in your own NEAR wallet";
  $("summary").replaceChildren(...c.lines.map(([k, v]) => {
    const r = document.createElement("div"); r.className = "row";
    const a = document.createElement("span"), b = document.createElement("b");
    a.textContent = k; b.textContent = v.length > 30 ? short(v) : v;
    r.append(a, b);
    return r;
  }));
  const finish = () => {
    $("callform").classList.add("hidden");
    $("title").textContent = "Sent";
    $("doneline").textContent = "Done. It's on the blockchain now.";
    $("donenote").textContent = "I'll tell you in your chat as soon as it goes through.";
    $("tx").classList.add("hidden");
    $("done").classList.remove("hidden");
    if (window.parent !== window) window.parent.postMessage({ moopay: "delivered", wait: true }, location.origin);
  };
  if (/transactionHashes/.test(location.search)) return finish(); // a redirect wallet brought us back after signing
  const btn = $<HTMLButtonElement>("callgo");
  btn.textContent = c.title.split(" ")[0]!;
  $("callform").classList.remove("hidden");
  selector = await makeSelector();
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      say("callmsg", "Choose your wallet…");
      const account = await connect();
      if (account !== c.account) {
        await (await selector.wallet()).signOut();
        pickedNear = undefined;
        throw new Error(`That wallet is ${account}. Sign with ${c.account}, the wallet that holds your rNEAR.`);
      }
      say("callmsg", "Approve it in your wallet…");
      const wallet = await selector.wallet();
      await wallet.signAndSendTransaction({ signerId: account, receiverId: c.contract, actions: [najActions.functionCall(c.method, c.args, 200n * TGAS, 0n)] as never });
      finish();
    } catch (e) {
      btn.disabled = false;
      say("callmsg", e instanceof Error ? e.message : "Something went wrong.", "err");
    }
  });
}

async function main() {
  try {
    intent = await api<Intent>(base);
  } catch (e) {
    $("title").textContent = "Link expired";
    say("top-msg", e instanceof Error ? e.message : "This link is not valid.", "err");
    return;
  }
  if (intent.call) return void (await callMode(intent.call));
  const setTitle = () => { $("title").textContent = `${intent.stake ? "Stake" : "Send"} $${intent.payAmount}`; };
  setTitle();
  $("sub").textContent = intent.stake ? "into rNEAR on Rhea Finance" : `to ${CHAINS[intent.destinationChain] ?? intent.destinationChain}`;
  $("summary").innerHTML = "";
  const rows: [string, string][] = intent.stake ? [["You receive", "rNEAR, earning yield"]] : [["They receive", intent.destinationSymbol], ["Recipient", short(intent.recipient)]];
  if (intent.stake) { $("payoutbox").classList.remove("hidden"); $<HTMLInputElement>("payout").value = intent.stake.payout; $("estlabel").textContent = "You stake (plus a small network reserve)"; }
  for (const [k, v] of rows) {
    const r = document.createElement("div");
    r.className = "row";
    const a = document.createElement("span"); a.textContent = k;
    const b = document.createElement("b"); b.textContent = v;
    r.append(a, b);
    $("summary").append(r);
  }
  const sel = $<HTMLSelectElement>("asset"), ch = $<HTMLSelectElement>("chain");
  const chains = [...new Set(intent.assets.map((a) => a.chain))];
  for (const c of chains) ch.add(new Option(chainName(c), c));
  const ddChain = fancy(ch), ddAsset = fancy(sel);
  const fillAssets = () => {
    sel.innerHTML = "";
    for (const a of intent.assets.filter((x) => x.chain === ch.value)) sel.add(new Option(a.native ? `${a.symbol} (the chain's own coin)` : a.symbol, a.assetId));
    const want = intent.fromSymbol?.toUpperCase();
    const hit = want ? intent.assets.find((x) => x.chain === ch.value && x.symbol.toUpperCase() === want) : undefined;
    if (hit) sel.value = hit.assetId;
    const near = ch.value === "near";
    $("manual").classList.toggle("hidden", near);
    $("refundbox").classList.add("hidden");
    $("send").textContent = intent.stake ? "Stake" : "Make transfer";
    ddAsset.sync();
  };
  if (intent.fromChain && chains.includes(intent.fromChain)) { ch.value = intent.fromChain; ddChain.sync(); }
  fillAssets();
  setTitle();
  ch.addEventListener("change", () => { fillAssets(); void refreshEstimate(); });
  sel.addEventListener("change", () => { setTitle(); void refreshEstimate(); });
  $("manual").addEventListener("click", () => $("refundbox").classList.toggle("hidden"));
  $("getaddr").addEventListener("click", () => void manualQuote());
  $("form").classList.remove("hidden");
  $<HTMLButtonElement>("copy").addEventListener("click", () => {
    void navigator.clipboard?.writeText($("addr").textContent ?? "");
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  });
  $<HTMLButtonElement>("send").addEventListener("click", () => void send());

  selector = await makeSelector();
  void refreshEstimate();

  // A redirect wallet (MyNearWallet) returns here after signing.
  const pending = sessionStorage.getItem(`moopay:${id}`);
  if (pending && /transactionHashes/.test(location.search)) {
    const back = new URLSearchParams(location.search).get("transactionHashes")?.split(",")[0];
    if (back) await reportPaid(back).catch(() => undefined); // only a straight transfer accepts this; a swap ignores it
    void track(pending);
  }
}

void main();

import { actions as najActions } from "near-api-js";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";
import { createAppKit, type AppKit } from "@reown/appkit";
import { mainnet, base as baseNet, arbitrum, optimism, polygon, bsc, avalanche, solana } from "@reown/appkit/networks";

interface Asset { assetId: string; symbol: string; decimals: number; contract: string; native: boolean; chain: string; chainId?: number }
interface Intent {
  destinationChain: string; destinationSymbol: string; destinationDecimals: number;
  recipient: string; payAmount: string; assets: Asset[]; wcProjectId?: string; fromChain?: string; fromSymbol?: string;
}
interface Quote {
  depositAddress: string; depositMemo?: string; chain: string;
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

async function track(depositAddress: string, manual = false) {
  $("form").classList.add("hidden");
  $("deposit").classList.remove("hidden");
  $("addr").textContent = depositAddress;
  $("title").textContent = manual ? "Waiting for your payment" : "Sending…";
  for (;;) {
    try {
      const s = await api<{ state: string; txHash?: string; explorerUrl?: string }>(`${base}/status`);
      if (s.state === "SUCCESS") {
        $("title").textContent = "Delivered";
        if (window.parent !== window) window.parent.postMessage({ moopay: "delivered" }, location.origin);
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

const chosen = () => intent.assets.find((a) => a.assetId === $<HTMLSelectElement>("asset").value)!;
const getQuote = (originAssetId: string, refundTo: string) =>
  api<Quote>(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ originAssetId, refundTo }) });

/** The always-works way: show the exact amount and address so any wallet can pay it. */
function showManual(q: Quote, a: Asset) {
  $("form").classList.add("hidden");
  $("deposit").classList.remove("hidden");
  $("dlabel").textContent = `Send this from your ${chainName(a.chain)} wallet`;
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
    metadata: { name: "MooPay", description: "Private payments", url: location.origin, icons: [`${location.origin}/p/assets/favicon.png`], redirect: { universal: location.href.split("#")[0]! } },
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

async function sendOther(a: Asset) {
  if (a.chain === "sol") {
    const ph = w.phantom?.solana ?? w.solana;
    const conn: Conn = ph
      ? { account: (await ph.connect()).publicKey.toString(), request: (method, params) => ph.request({ method, params }) }
      : await wcConnect("sol");
    say("msg", "Preparing your payment…");
    const q = await getQuote(a.assetId, conn.account);
    $("addr").textContent = q.depositAddress;
    if (!a.native) { showManual(q, a); $("dlabel").textContent = "Send this from your Solana wallet (USDC and USDT cannot be signed from this page yet)"; throw new Error("manual"); }
    try {
      say("msg", "Approve the payment in your wallet…");
      const bh = await api<{ blockhash: string }>(`${base}/blockhash`);
      const tx = solTransfer(conn.account, q.transfer.to, BigInt(q.transfer.amount), bh.blockhash);
      if (ph) await conn.request("signAndSendTransaction", { message: b58encode(tx) });
      else {
        // WalletConnect wallets sign and hand back; we put the signature in and send it through the server.
        const res = (await conn.request("solana_signTransaction", { transaction: btoa(String.fromCharCode(...tx)), pubkey: conn.account })) as { signature?: string; transaction?: string };
        let signed = res.transaction;
        if (!signed && res.signature) { const t = Uint8Array.from(tx); t.set(b58decode(res.signature), 1); signed = btoa(String.fromCharCode(...t)); }
        if (!signed) throw new Error("no signature");
        await api(`${base}/sol-send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: signed }) });
      }
    } catch {
      showManual(q, a);
      $("dlabel").textContent = `Your wallet did not send it. Send this from your ${chainName(a.chain)} wallet yourself`;
      throw new Error("manual");
    }
    return q;
  }
  const eth = w.ethereum;
  let conn: Conn;
  if (eth) {
    const account = ((await eth.request({ method: "eth_requestAccounts" })) as string[])[0]!;
    if (a.chainId) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + a.chainId.toString(16) }] });
    conn = { account, request: (method, params) => eth.request({ method, params: params as unknown[] }) };
  } else conn = await wcConnect(a.chain);
  say("msg", "Preparing your payment…");
  const q = await getQuote(a.assetId, conn.account);
  $("addr").textContent = q.depositAddress;
  const hex = (n: bigint) => "0x" + n.toString(16);
  const pad = (h: string) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const amount = BigInt(q.transfer.amount);
  const tx = a.native ? { from: conn.account, to: q.transfer.to, value: hex(amount) } : { from: conn.account, to: a.contract, data: "0xa9059cbb" + pad(q.transfer.to) + pad(hex(amount)) };
  say("msg", "Approve the payment in your wallet…");
  try { await conn.request("eth_sendTransaction", [tx]); }
  catch { showManual(q, a); $("dlabel").textContent = `Your wallet did not send it. Send this from your ${chainName(a.chain)} wallet yourself`; throw new Error("manual"); }
  return q;
}

async function manualQuote() {
  const a = chosen();
  const refund = $<HTMLInputElement>("refund").value.trim();
  if (!refund) return say("msg", "Enter your address on that chain first.", "err");
  try {
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
    if (e instanceof Error && e.message === "manual") { void track($("addr").textContent ?? "", true); return; }
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
  const sel = $<HTMLSelectElement>("asset"), ch = $<HTMLSelectElement>("chain");
  const chains = [...new Set(intent.assets.map((a) => a.chain))];
  for (const c of chains) ch.add(new Option(chainName(c), c));
  const fillAssets = () => {
    sel.innerHTML = "";
    for (const a of intent.assets.filter((x) => x.chain === ch.value)) sel.add(new Option(a.native ? `${a.symbol} (the chain's own coin)` : a.symbol, a.assetId));
    const want = intent.fromSymbol?.toUpperCase();
    const hit = want ? intent.assets.find((x) => x.chain === ch.value && x.symbol.toUpperCase() === want) : undefined;
    if (hit) sel.value = hit.assetId;
    const near = ch.value === "near";
    $("manual").classList.toggle("hidden", near);
    $("refundbox").classList.add("hidden");
    $("send").textContent = "Make transfer";
  };
  if (intent.fromChain && chains.includes(intent.fromChain)) ch.value = intent.fromChain;
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

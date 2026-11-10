import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupNightly } from "@near-wallet-selector/nightly";
import { showError } from "./friendly.js";

export const $ = <T extends HTMLElement>(i: string) => document.getElementById(i) as T;
export const key = location.pathname.split("/")[2] ?? "";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { message?: string } & T;
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body;
}

export const short = (a: string) => (a.length > 18 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

export function say(el: string, text: string, kind: "" | "err" | "ok" = "") {
  const e = $(el);
  e.textContent = text;
  e.className = `msg ${kind}`;
}

export let selector: WalletSelector;
export async function initWallets() {
  selector = await setupWalletSelector({ network: "mainnet", modules: [setupMeteorWallet(), setupNightly(), setupMyNearWallet()] });
  return selector;
}

export const sayError = (el: string, e: unknown, fallback?: string) => showError($(el), e, { ...(fallback ? { fallback } : {}), onSwitchWallet: () => void switchWallet() });
/** Signs out of the connected wallet and reloads, so the wallet list opens again. */
export async function switchWallet(): Promise<void> { try { await (await selector.wallet()).signOut(); } catch { /* reload anyway */ } location.reload(); }

export const accountId = (): string | undefined =>
  selector.store.getState().accounts.find((a) => a.active)?.accountId ?? selector.store.getState().accounts[0]?.accountId;

export function connect(): Promise<string> {
  const existing = accountId();
  if (existing) return Promise.resolve(existing);
  const modal = setupModal(selector, { description: "Choose your wallet." });
  return new Promise((resolve, reject) => {
    const sub = selector.store.observable.subscribe((s) => {
      const a = s.accounts[0]?.accountId;
      if (a) { sub.unsubscribe(); resolve(a); }
    });
    modal.on("onHide", () => { if (!accountId()) { sub.unsubscribe(); reject(new Error("Wallet connection was cancelled.")); } });
    modal.show();
  });
}

export function wireCopy(btn: string, source: () => string) {
  $<HTMLButtonElement>(btn).addEventListener("click", () => {
    void navigator.clipboard?.writeText(source());
    $(btn).textContent = "Copied";
    setTimeout(() => ($(btn).textContent = "Copy"), 1500);
  });
}

/* Turns what a wallet or the network throws into words a person can act on. The raw text stays one tap away under "Technical details". */

export interface FriendlyError {
  /** empty when the message was already plain and is shown as it is */
  title: string;
  text: string;
  /** a button to offer next to the message */
  action?: "switch-wallet";
  /** what was really thrown, for a support request; empty when the message was already plain */
  raw: string;
}

const RULES: { match: RegExp; title: string; text: string; action?: "switch-wallet" }[] = [
  { match: /more than \d+ access keys|view_access_key_list/i, title: "Wallet key limit reached", text: "This wallet has too many apps connected to it for this payment window to read. Pick another wallet, or remove old connected apps from this one.", action: "switch-wallet" },
  { match: /user rejected|rejected the request|rejected by the user|transaction declined|denied (the )?(transaction|request|signature)|user cancell?ed|closed the (popup|window)/i, title: "Transaction cancelled", text: "You cancelled it in your wallet. Nothing was taken, and you can try again whenever you like." },
  { match: /insufficient|not enough (balance|funds)|lack ?balance|exceeds balance|NotEnoughBalance/i, title: "Not enough balance", text: "That wallet doesn't hold enough of this coin to cover the payment and the network fee. Add a little more, or pick another coin." },
  { match: /slippage|price (moved|changed)|min(imum)? ?(amount )?out/i, title: "Price moved quickly", text: "The price changed too fast for this payment to finish safely. Nothing was taken. Try again in a moment." },
  { match: /-32000|server error|network ?error|failed to fetch|load failed|timed? ?out|timeout|econn|socket|\b50[0-4]\b|unreachable/i, title: "Connection interrupted", text: "I can't reach the network right now. Check your connection and try again in a moment. Nothing was taken." },
];
/** Shapes that only a developer should see: error codes, stack lines, contract failures, JSON. */
const TECHNICAL = /\[-?\d+\]|server error|\brpc\b|exception|stack|\b(Type|Reference|Syntax|Range)Error\b|undefined|\bat [\w.<>]+ ?\(|0x[0-9a-f]{16,}|FunctionCallError|ExecutionError|HostError|"[\w]+"\s*:|\bwasm\b|panicked|\bnull\b/i;

const rawOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; try { return JSON.stringify(e); } catch { return ""; } }
  return "";
};

/** `fallback` is shown when nothing usable came back at all. */
export function friendlyError(e: unknown, fallback = "Something went wrong. Please try again."): FriendlyError {
  const raw = rawOf(e).trim();
  if (!raw) return { title: "", text: fallback, raw: "" };
  const rule = RULES.find((r) => r.match.test(raw));
  if (rule) return { title: rule.title, text: rule.text, ...(rule.action ? { action: rule.action } : {}), raw };
  // Our own server already speaks plainly: show it as it is.
  if (!TECHNICAL.test(raw)) return { title: "", text: raw, raw: "" };
  return { title: "Something went wrong", text: "An unexpected error stopped this payment. Nothing was taken. Please try again shortly.", raw };
}

/** Shows an error in a message box: a short title, what to do, an optional button, and the raw text tucked under "Technical details". */
export function showError(box: HTMLElement, e: unknown, o: { fallback?: string; onSwitchWallet?: () => void } = {}): void {
  const f = friendlyError(e, o.fallback);
  box.className = "msg err";
  box.replaceChildren();
  const add = (tag: string, text: string, style = ""): HTMLElement => { const n = document.createElement(tag); n.textContent = text; if (style) n.setAttribute("style", style); box.append(n); return n; };
  if (f.title) add("div", f.title, "font-weight:600;margin-bottom:2px");
  add("div", f.text);
  if (f.action === "switch-wallet" && o.onSwitchWallet) {
    const b = add("button", "Switch wallet", "margin-top:8px;padding:7px 12px;border-radius:9px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer") as HTMLButtonElement;
    b.type = "button"; b.onclick = o.onSwitchWallet;
  }
  if (f.raw) {
    const d = document.createElement("details"); d.setAttribute("style", "margin-top:8px;opacity:.65;font-size:12px");
    const s = document.createElement("summary"); s.textContent = "Technical details"; s.setAttribute("style", "cursor:pointer");
    const p = document.createElement("pre"); p.textContent = f.raw; p.setAttribute("style", "white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font:inherit;user-select:all");
    d.append(s, p); box.append(d);
  }
}

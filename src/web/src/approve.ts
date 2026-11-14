import { startAuthentication } from "@simplewebauthn/browser";

/*
 * The one-tap signing sheet that the X reply links to. It shows what will be paid, then asks the device for a fingerprint, face
 * or PIN straight away, so the user taps the link and confirms. Nothing here can move money without that signature.
 */
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const id = location.pathname.split("/").pop() ?? "";
const say = (t: string, kind: "" | "ok" | "bad" = ""): void => { const o = $("out"); o.textContent = t; o.className = kind; };
const api = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const r = await fetch(`/ok-api/${id}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j["message"] ?? "That didn't work. Please try again."));
  return j;
};

let busy = false;
async function approve(): Promise<void> {
  if (busy) return; busy = true; $("go").hidden = true;
  try {
    say("Waiting for your fingerprint, face or PIN…");
    const options = (await api("/options", {})) as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"];
    // Some phones fail with "unknown error while talking to the credential manager" when asked for one named key. Asking again with no
    // name lets the phone offer whichever MooPay passkey it holds, which works because the passkey is a discoverable one.
    const assertion = await startAuthentication({ optionsJSON: options }).catch(async (e: unknown) => {
      if (!(e instanceof Error) || e.name === "NotAllowedError" || e.name === "AbortError") throw e;
      const { allowCredentials: _drop, ...open } = options as unknown as Record<string, unknown>;
      return startAuthentication({ optionsJSON: open as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
    });
    say("Sending…");
    const r = await api("/approve", { assertion });
    $("card").hidden = true;
    say(r["status"] === "sent" || r["status"] === "group_done" || r["status"] === "created" ? "Done. You can close this page." : String(r["reason"] ?? "It was not sent."), r["status"] === "sent" || r["status"] === "group_done" || r["status"] === "created" ? "ok" : "bad");
  } catch (e) {
    $("go").hidden = false;
    const inApp = /Twitter|FBAN|FBAV|Instagram|; wv\)|FB_IAB/i.test(navigator.userAgent);
    const name = e instanceof Error ? e.name : "";
    say(name === "NotAllowedError" ? "Your device didn't confirm it. The prompt was closed, timed out, or this device has no fingerprint, face or PIN set up. Nothing was sent. Tap the button to try again."
      : inApp ? "This page is open inside another app (like X), and phones often block passkeys there. Open this same link in your phone's own browser (Chrome or Safari) and confirm there. Nothing was sent."
      : "Your phone's passkey manager couldn't finish. Check that you're signed in to your Google or Apple account on this phone, that this MooPay passkey is saved there, then tap the button again. If it keeps failing, approve it in the MooPay app. Nothing was sent.", "bad");
    $("open").hidden = false;
  } finally { busy = false; }
}

$("go").addEventListener("click", () => void approve());
$("open").addEventListener("click", () => {
  // Android can hand the page to Chrome; elsewhere copy the link so it can be pasted into the browser.
  if (/Android/i.test(navigator.userAgent)) { location.href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`; return; }
  void navigator.clipboard?.writeText(location.href).then(() => say("Link copied. Paste it into Safari or Chrome.", ""), () => say("Copy the address of this page and open it in Safari or Chrome.", "bad"));
});
api("").then((s) => {
  $("sum").textContent = String(s["summary"]); $("why").textContent = String(s["reason"] ?? "");
  const rows = $("rows");
  for (const [k, v] of (s["details"] as [string, string][])) {
    const row = document.createElement("div"); row.className = "row";
    const a = document.createElement("span"), b = document.createElement("b"); a.textContent = k; b.textContent = v; row.append(a, b); rows.append(row);
  }
  $("card").hidden = false;
  void approve(); // one tap: the sheet opens straight away
}).catch((e: unknown) => say(e instanceof Error ? e.message : "This approval is not available.", "bad"));

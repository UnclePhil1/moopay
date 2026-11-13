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
    const assertion = await startAuthentication({ optionsJSON: options });
    say("Sending…");
    const r = await api("/approve", { assertion });
    $("card").hidden = true;
    say(r["status"] === "sent" || r["status"] === "group_done" || r["status"] === "created" ? "Done. You can close this page." : String(r["reason"] ?? "It was not sent."), r["status"] === "sent" || r["status"] === "group_done" || r["status"] === "created" ? "ok" : "bad");
  } catch (e) {
    $("go").hidden = false;
    say(e instanceof Error && e.name !== "NotAllowedError" ? e.message : "Your device didn't confirm it. The prompt was closed, timed out, or this device has no fingerprint, face or PIN set up. Nothing was sent. Tap the button to try again.", "bad");
  } finally { busy = false; }
}

$("go").addEventListener("click", () => void approve());
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

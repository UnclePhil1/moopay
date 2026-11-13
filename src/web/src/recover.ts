import { openBackup, type Backup } from "../../agent/recovery.js";

/* The offline recovery page: opens a MooPay backup file in this browser. Nothing is sent anywhere. */
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const say = (t: string, bad = false): void => { const o = $("out"); o.textContent = t; o.className = bad ? "bad" : "ok"; };

$("open").addEventListener("click", () => {
  const file = $<HTMLInputElement>("file").files?.[0], code = $<HTMLInputElement>("code").value.trim();
  if (!file || !code) return say("Choose your backup file and paste your recovery code.", true);
  say("Opening… this takes a moment.");
  // let the message paint before the key derivation blocks the page
  setTimeout(() => {
    file.text().then((t) => {
      const k = openBackup(JSON.parse(t) as Backup, code);
      $("acct").textContent = k.accountId; $("key").textContent = k.secretKey;
      $("result").hidden = false; say("Opened. Import the key into a NEAR wallet, then move your money.");
    }).catch((e: unknown) => say(e instanceof Error && !(e instanceof SyntaxError) ? e.message : "That file is not a MooPay backup.", true));
  }, 30);
});

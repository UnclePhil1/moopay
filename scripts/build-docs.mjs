// Builds the docs site: docs/**/*.md + docs/nav.json -> web/dist/docs (HTML pages, .md copies, llms.txt).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = "docs", OUT = "web/dist/docs";
const ORIGIN = (process.env.DOCS_ORIGIN ?? "https://moopay.cash").replace(/\/$/, "");
const nav = JSON.parse(readFileSync(join(SRC, "nav.json"), "utf8"));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---- markdown: the small part of it the docs use ---- */
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${u.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function render(md, toc) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { flush(); i++; continue; }
    const fence = /^```(\S*)\s*(.*)$/.exec(l);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      const title = fence[2] || fence[1];
      out.push(`<div class="code">${title ? `<div class="ct">${esc(title)}</div>` : ""}<button class="cp" type="button">Copy</button><pre><code>${esc(body.join("\n"))}</code></pre></div>`);
      continue;
    }
    const box = /^:::(note|warning|info|cards|steps)\s*$/.exec(l);
    if (box) {
      flush();
      const body = [];
      for (i++; i < lines.length && lines[i].trim() !== ":::"; i++) body.push(lines[i]);
      i++;
      if (box[1] === "cards") {
        out.push(`<div class="cards">${body.filter((x) => x.trim()).map((x) => {
          const m = /^- \[([^\]]+)\]\(([^)]+)\)\s*(.*)$/.exec(x.trim());
          return m ? `<a class="card" href="${m[2]}"><b>${inline(m[1])}</b><span>${inline(m[3])}</span></a>` : "";
        }).join("")}</div>`);
      } else if (box[1] === "steps") {
        out.push(`<div class="steps">${render(body.join("\n"), null)}</div>`);
      } else out.push(`<div class="call ${box[1]}">${render(body.join("\n"), null)}</div>`);
      continue;
    }
    const h = /^(#{2,3}) (.+)$/.exec(l);
    if (h) {
      flush();
      const id = slug(h[2]);
      if (h[1] === "##" && toc) toc.push([id, h[2]]);
      out.push(`<h${h[1].length} id="${id}">${inline(h[2])}</h${h[1].length}>`);
      i++; continue;
    }
    if (l.trim().startsWith("|")) {
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const head = rows[0], body = rows.slice(2);
      out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = /^(-|\d+\.) (.*)$/.exec(l);
    if (li) {
      flush();
      const tag = li[1] === "-" ? "ul" : "ol", items = [];
      for (; i < lines.length; i++) {
        const m = /^(-|\d+\.) (.*)$/.exec(lines[i]);
        if (m) items.push(m[2]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
      }
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }
    para.push(l.trim());
    i++;
  }
  flush();
  return out.join("\n");
}

/* ---- pages ---- */
const pages = [];
for (const tab of nav.tabs) for (const g of tab.groups) for (const p of g.pages) {
  const path = `${tab.slug}/${g.slug}/${p}`;
  const raw = readFileSync(join(SRC, `${path}.md`), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${path}: missing front matter`);
  const meta = Object.fromEntries(m[1].split("\n").map((x) => { const k = x.indexOf(":"); return [x.slice(0, k).trim(), x.slice(k + 1).trim().replace(/^"|"$/g, "")]; }));
  if (!meta.title || !meta.description) throw new Error(`${path}: needs a title and a description`);
  pages.push({ path, tab, group: g, meta, body: m[2].trim(), raw });
}
const url = (p) => `/docs/${p.path}`;
const firstOf = (tab) => url(pages.find((p) => p.tab === tab));

const template = (p, i) => {
  const toc = [];
  const html = render(p.body, toc);
  const side = p.tab.groups.map((g) => `<div class="grp"><h4>${esc(g.name)}</h4>${g.pages.map((s) => {
    const q = pages.find((x) => x.path === `${p.tab.slug}/${g.slug}/${s}`);
    return `<a href="${url(q)}"${q === p ? ' class="on" aria-current="page"' : ""}>${esc(q.meta.title)}</a>`;
  }).join("")}</div>`).join("");
  const tabs = nav.tabs.map((t) => `<a href="${firstOf(t)}"${t === p.tab ? ' class="on"' : ""}>${esc(t.name)}</a>`).join("");
  const prev = pages[i - 1], next = pages[i + 1];
  const pn = (q, label) => q && q.tab === p.tab ? `<a class="pn" href="${url(q)}"><span>${label}</span><b>${esc(q.meta.title)}</b></a>` : "<span></span>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(p.meta.title)} - MooPay Docs</title>
<meta name="description" content="${esc(p.meta.description)}">
<link rel="alternate" type="text/markdown" href="${url(p)}.md">
<link rel="icon" href="/app/assets/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..800&display=swap" rel="stylesheet">
<style>
  :root { --bg:#0a0a0a; --card:#141414; --line:rgba(244,239,230,.1); --text:#f4efe6; --muted:#aaa49a; --soft:#d9d3c7; }
  * { box-sizing:border-box; }
  html { scroll-padding-top:88px; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.7 "Inter",system-ui,sans-serif; }
  a { color:var(--text); }
  .top { position:sticky; top:0; z-index:20; background:rgba(10,10,10,.92); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); }
  .bar { max-width:1240px; margin:0 auto; padding:0 24px; height:64px; display:flex; align-items:center; gap:28px; }
  .bar img { height:22px; display:block; }
  .tabs { display:flex; gap:8px; flex:1; overflow-x:auto; scrollbar-width:none; } .tabs::-webkit-scrollbar { display:none; }
  .tabs a { text-decoration:none; color:var(--muted); font-weight:600; font-size:15px; padding:8px 16px; border-radius:999px; white-space:nowrap; }
  .tabs a:hover { color:var(--text); } .tabs a.on { color:var(--text); background:rgba(244,239,230,.08); }
  .open { background:var(--text); color:#000; text-decoration:none; font-weight:700; font-size:14px; padding:10px 22px; border-radius:999px; white-space:nowrap; margin-left:12px; }
  .menu { display:none; margin-left:auto; background:none; border:1px solid var(--line); color:var(--text); font:600 14px "Inter",sans-serif; padding:8px 14px; border-radius:10px; cursor:pointer; }
  .shell { max-width:1240px; margin:0 auto; padding:0 24px; display:grid; grid-template-columns:250px minmax(0,1fr) 200px; gap:48px; }
  .side { position:sticky; top:64px; align-self:start; max-height:calc(100vh - 64px); overflow-y:auto; padding:28px 20px 40px 0; border-right:1px solid var(--line); scrollbar-width:thin; scrollbar-color:transparent transparent; } .side:hover { scrollbar-color:rgba(244,239,230,.25) transparent; }
  .grp { margin-bottom:26px; } .grp h4 { margin:0 0 8px 12px; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .grp a { display:block; text-decoration:none; color:var(--soft); font-size:15px; line-height:1.4; padding:7px 12px; margin:1px 0; border-radius:8px; }
  .grp a:hover { background:rgba(244,239,230,.05); } .grp a.on { background:rgba(244,239,230,.1); font-weight:700; color:var(--text); }
  .doc { padding:40px 0 90px; min-width:0; }
  h1 { font-size:40px; line-height:1.12; margin:0 0 10px; font-weight:800; letter-spacing:-.02em; }
  .desc { font-size:19px; color:var(--soft); margin:0 0 30px; }
  h2 { font-size:25px; margin:46px 0 12px; font-weight:800; letter-spacing:-.01em; }
  h3 { font-size:18px; margin:30px 0 8px; font-weight:700; }
  p { margin:0 0 14px; color:var(--soft); } ul, ol { color:var(--soft); padding-left:22px; margin:0 0 16px; } li { margin:6px 0; }
  code { font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:rgba(244,239,230,.09); padding:2px 6px; border-radius:6px; color:var(--text); }
  .code { position:relative; background:#0f0f0f; border:1px solid var(--line); border-radius:14px; margin:0 0 18px; overflow:hidden; }
  .code pre { margin:0; padding:16px 18px; overflow-x:auto; } .code pre code { background:none; padding:0; font-size:13px; line-height:1.65; color:#e8e2d6; }
  .ct { padding:9px 18px; font-size:12.5px; color:var(--muted); border-bottom:1px solid var(--line); }
  .cp { position:absolute; top:8px; right:10px; background:none; border:1px solid var(--line); color:var(--muted); font:600 12px "Inter",sans-serif; padding:5px 12px; border-radius:8px; cursor:pointer; }
  .cp:hover { color:var(--text); }
  .tw { overflow-x:auto; margin:0 0 20px; border:1px solid var(--line); border-radius:14px; }
  table { border-collapse:collapse; width:100%; font-size:15px; } th, td { text-align:left; padding:11px 15px; vertical-align:top; border-bottom:1px solid var(--line); color:var(--soft); }
  th { color:var(--text); font-weight:700; background:rgba(244,239,230,.04); } tr:last-child td { border-bottom:0; } td:first-child { color:var(--text); font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; margin:0 0 22px; }
  .card { display:block; text-decoration:none; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px 18px; transition:border-color .2s, background .2s; }
  .card:hover { border-color:rgba(244,239,230,.3); background:#191919; } .card b { display:block; margin-bottom:4px; } .card span { color:var(--muted); font-size:14.5px; line-height:1.5; display:block; }
  .call { border:1px solid var(--line); background:var(--card); border-radius:12px; padding:14px 18px 2px; margin:0 0 20px; }
  .steps ol { list-style:none; counter-reset:s; padding:0; } .steps li { counter-increment:s; position:relative; padding:0 0 18px 48px; margin:0; }
  .steps li::before { content:counter(s); position:absolute; left:0; top:0; width:32px; height:32px; border-radius:50%; background:var(--text); color:#000; font-weight:800; display:grid; place-items:center; font-size:14px; }
  .toc { position:sticky; top:64px; align-self:start; padding:42px 0; font-size:14px; } .toc h4 { margin:0 0 8px; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .toc a { display:block; color:var(--muted); text-decoration:none; padding:4px 0; } .toc a:hover { color:var(--text); }
  .pns { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:54px; }
  .pn { text-decoration:none; border:1px solid var(--line); border-radius:14px; padding:16px 20px; background:var(--card); } .pn:hover { border-color:rgba(244,239,230,.3); }
  .pn span { display:block; font-size:13px; color:var(--muted); } .pn b { display:block; } .pns a:last-child { text-align:right; }
  .raw { margin-top:30px; font-size:13.5px; color:var(--muted); } .raw a { color:var(--muted); }
  @media (max-width:1060px) { .shell { grid-template-columns:230px minmax(0,1fr); } .toc { display:none; } }
  @media (max-width:760px) {
    .menu { display:block; } .bar { gap:12px; } .open { display:none; }
    .shell { display:block; padding:0 16px; } .bar { padding:0 16px; }
    .side { display:none; position:static; max-height:none; padding:18px 0 8px; border-right:0; border-bottom:1px solid var(--line); } .side.show { display:block; }
    h1 { font-size:32px; } .doc { padding-top:28px; } .pns { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
<header class="top"><div class="bar">
  <a href="/"><img src="/app/assets/moopay-logo.png" alt="MooPay"></a>
  <nav class="tabs">${tabs}</nav>
  <a class="open" href="/agent">Open MooPay</a>
  <button class="menu" id="menu" type="button">Menu</button>
</div></header>
<div class="shell">
  <aside class="side" id="side">${side}</aside>
  <main class="doc">
    <h1>${esc(p.meta.title)}</h1>
    <p class="desc">${esc(p.meta.description)}</p>
    ${html}
    <div class="pns">${pn(prev, "Previous")}${pn(next, "Next")}</div>
    <p class="raw">Need help? <a href="mailto:support@moopay.cash">support@moopay.cash</a></p>
  </main>
  <nav class="toc">${toc.length > 1 ? `<h4>On this page</h4>${toc.map(([id, t]) => `<a href="#${id}">${esc(t)}</a>`).join("")}` : ""}</nav>
</div>
<script>
  document.getElementById("menu").onclick = function () { document.getElementById("side").classList.toggle("show"); };
  document.querySelectorAll(".cp").forEach(function (b) {
    b.onclick = function () {
      var t = b.parentNode.querySelector("code").textContent;
      try { navigator.clipboard.writeText(t); } catch (e) {}
      b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1400);
    };
  });
</script>
</body>
</html>
`;
};

mkdirSync(OUT, { recursive: true });
const note = `> ## Documentation Index\n> Fetch the complete documentation index at: ${ORIGIN}/llms.txt\n\n`;
pages.forEach((p, i) => {
  const file = join(OUT, p.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.html`, template(p, i));
  writeFileSync(`${file}.md`, `${note}# ${p.meta.title}\n\n${p.meta.description}\n\n${p.body}\n`);
});
const llms = ["# MooPay Docs", "", ...nav.tabs.flatMap((t) => [`## ${t.name}`, ...pages.filter((p) => p.tab === t).map((p) => `- [${p.meta.title}](${ORIGIN}${url(p)}.md): ${p.meta.description}`), ""])];
writeFileSync(join(OUT, "llms.txt"), llms.join("\n"));
writeFileSync(join(OUT, "index.json"), JSON.stringify({ first: firstOf(nav.tabs[0]), paths: pages.map((p) => p.path) }));
console.log(`docs: ${pages.length} pages`);

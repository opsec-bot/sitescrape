// One self-contained page: no CDN, no build step. It holds no data itself; it reads the catalog
// from GET / and calls endpoints like any other client, sending the token you type in.
export const PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sitescrape playground</title>
<style>
  :root {
    --bg: #f6f5f2; --panel: #fffefb; --text: #1d1d1b; --muted: #6b6a66; --line: #dddbd5;
    --accent: #2f6fd6; --accent-text: #fdfdfc; --bad: #c2412d; --good: #2d8a4e; --code: #efede8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a; --panel: #1f1f23; --text: #ecebe8; --muted: #9b9a96; --line: #34343a;
      --accent: #6b9cf0; --accent-text: #121214; --bad: #ef7a64; --good: #6cc28c; --code: #26262b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0 auto 0 0; }
  main { display: grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 54px); }
  nav { border-right: 1px solid var(--line); padding: 10px; overflow: auto; }
  nav button { display: block; width: 100%; text-align: left; padding: 8px 10px; margin: 2px 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--text); cursor: pointer; font: inherit; }
  nav button:hover { background: var(--code); }
  nav button.on { background: var(--accent); color: var(--accent-text); }
  nav .site { color: var(--muted); font-size: 12px; margin: 12px 10px 2px; }
  section { padding: 20px; max-width: 980px; overflow: auto; }
  h2 { margin: 0 0 4px; font-size: 18px; }
  .muted { color: var(--muted); }
  .notes { white-space: pre-wrap; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .field { display: grid; grid-template-columns: 180px 1fr; gap: 10px; align-items: start; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .field label b { display: block; } .field label span { font-size: 12px; color: var(--muted); }
  input, select, textarea { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); font: inherit; }
  input[type=checkbox] { width: auto; }
  textarea { font-family: ui-monospace, monospace; min-height: 60px; }
  .send { margin: 14px 0; padding: 9px 18px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
  .send:disabled { opacity: .6; cursor: wait; }
  pre { background: var(--code); border-radius: 8px; padding: 12px; overflow: auto; max-height: 480px; margin: 6px 0 16px; font-size: 12.5px; }
  .tabs button { border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 5px 12px; border-radius: 6px; cursor: pointer; font: inherit; margin-right: 4px; }
  .tabs button.on { border-color: var(--accent); color: var(--accent); }
  .copy { float: right; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  .status.ok { color: var(--good); } .status.bad { color: var(--bad); }
  .tag { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; margin-left: 6px; color: var(--muted); }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid var(--line); } .field { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>sitescrape playground</h1>
  <a href="/openapi.json" style="color: var(--accent)">OpenAPI spec</a>
  <input id="token" type="password" placeholder="SITESCRAPE_TOKEN (if set)" style="max-width: 240px">
</header>
<main>
  <nav id="nav"><p class="muted">Loading...</p></nav>
  <section id="view"><p class="muted">Pick an endpoint.</p></section>
</main>
<script>
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tokenEl = $("#token");
try { tokenEl.value = sessionStorage.getItem("sitescrape-token") || ""; } catch {}
tokenEl.addEventListener("change", () => { try { sessionStorage.setItem("sitescrape-token", tokenEl.value); } catch {} load(); });
const headers = () => ({ "content-type": "application/json", ...(tokenEl.value ? { authorization: "Bearer " + tokenEl.value } : {}) });

let endpoints = [];
let snippetTab = "curl";

async function load() {
  const res = await fetch("/", { headers: headers() });
  if (!res.ok) { $("#nav").innerHTML = '<p class="status bad">' + (res.status === 401 ? "Enter the token above." : "Could not load the catalog.") + "</p>"; return; }
  endpoints = (await res.json()).endpoints;
  let site = "";
  $("#nav").innerHTML = endpoints.map((e) => {
    const [s, name] = e.id.split("/");
    const head = s !== site ? '<div class="site">' + esc(s) + "</div>" : "";
    site = s;
    return head + '<button data-id="' + esc(e.id) + '">' + esc(name) + "</button>";
  }).join("") || '<p class="muted">No endpoints in the catalog.</p>';
  for (const b of document.querySelectorAll("nav button")) b.onclick = () => show(b.dataset.id);
  const want = decodeURIComponent(location.hash.slice(1));
  if (endpoints.some((e) => e.id === want)) show(want);
}

function fieldHtml(name, s, required, value) {
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  const v = value === undefined ? "" : value;
  const ph = s.default !== undefined ? ' placeholder="' + esc(JSON.stringify(s.default)) + '"' : "";
  let control;
  if (s.enum) control = '<select name="' + esc(name) + '"><option value=""></option>' + s.enum.map((o) => '<option' + (o === v ? " selected" : "") + ">" + esc(o) + "</option>").join("") + "</select>";
  else if (type === "boolean") control = '<input type="checkbox" name="' + esc(name) + '"' + (v === true ? " checked" : "") + ">";
  else if (type === "integer" || type === "number") control = '<input type="number" step="' + (type === "integer" ? 1 : "any") + '" name="' + esc(name) + '" value="' + esc(v) + '"' + ph + ">";
  else if (type === "array" || type === "object" || !type) control = '<textarea name="' + esc(name) + '" data-json="1" placeholder="JSON">' + esc(v === "" ? "" : JSON.stringify(v, null, 2)) + "</textarea>";
  else control = '<input name="' + esc(name) + '" value="' + esc(v) + '"' + ph + ">";
  const meta = [type || "json", required ? "required" : "", s.default !== undefined ? "default " + JSON.stringify(s.default) : ""].filter(Boolean).join(" · ");
  return '<div class="field"><label><b>' + esc(name) + "</b><span>" + esc(meta) + (s.description ? "<br>" + esc(s.description) : "") + "</span></label>" + control + "</div>";
}

function show(id) {
  const e = endpoints.find((x) => x.id === id);
  location.hash = encodeURIComponent(id);
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.id === id);
  const props = e.input.properties || {};
  const required = new Set(e.input.required || []);
  const example = e.example || {};
  $("#view").innerHTML =
    "<h2>" + esc(e.id) + '<span class="tag">' + esc(e.kind) + "</span></h2>" +
    '<p class="muted">' + esc(e.description) + "</p>" +
    (e.notes ? '<div class="notes">' + esc(e.notes) + "</div>" : "") +
    '<form id="form">' + (Object.keys(props).length ? Object.entries(props).map(([n, s]) => fieldHtml(n, s, required.has(n), example[n])).join("") : '<p class="muted">No input.</p>') +
    '<button class="send" type="submit">' + (e.kind === "action" ? "Send (changes the live site)" : "Send request") + "</button></form>" +
    '<div id="result"></div>' +
    '<h3>Call it</h3><div class="tabs" id="tabs"></div><pre id="snippet"></pre>';
  const form = $("#form");
  form.oninput = () => updateSnippets(e, readForm(form));
  form.onsubmit = (ev) => { ev.preventDefault(); send(e, form); };
  updateSnippets(e, readForm(form));
}

function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") { if (el.checked) out[el.name] = true; continue; }
    if (el.value === "") continue;
    if (el.dataset.json) { try { out[el.name] = JSON.parse(el.value); } catch { out[el.name] = el.value; } }
    else if (el.type === "number") out[el.name] = Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

let snippetTimer;
function updateSnippets(e, input) {
  clearTimeout(snippetTimer);
  snippetTimer = setTimeout(async () => {
    const res = await fetch("/_snippets/" + e.id, { method: "POST", headers: headers(), body: JSON.stringify(input) });
    if (!res.ok) return;
    const snips = await res.json();
    $("#tabs").innerHTML = Object.keys(snips).map((k) => '<button class="' + (k === snippetTab ? "on" : "") + '" data-k="' + k + '">' + k + "</button>").join("");
    for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => { snippetTab = b.dataset.k; updateSnippets(e, input); };
    $("#snippet").innerHTML = '<button class="copy" id="copy">Copy</button>' + esc(snips[snippetTab]);
    $("#copy").onclick = () => navigator.clipboard.writeText(snips[snippetTab]);
  }, 150);
}

async function send(e, form) {
  if (e.kind === "action" && !confirm("This changes something on the live site. Send?")) return;
  const btn = $(".send", form);
  btn.disabled = true;
  const t0 = performance.now();
  let status, text;
  try {
    const res = await fetch("/" + e.id, { method: "POST", headers: headers(), body: JSON.stringify(readForm(form)) });
    status = res.status;
    text = JSON.stringify(await res.json(), null, 2);
  } catch (err) { status = 0; text = String(err); }
  btn.disabled = false;
  const ms = Math.round(performance.now() - t0);
  $("#result").innerHTML = '<h3>Response <span class="status ' + (status === 200 ? "ok" : "bad") + '">' + status + "</span> " +
    '<span class="muted">' + ms + " ms</span></h3><pre>" + esc(text) + "</pre>";
}

load();
</script>
</body>
</html>
`;

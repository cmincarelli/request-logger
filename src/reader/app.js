// Logger reader UI. Polls the active session for new events, renders a timeline,
// an endpoint explorer, and a per-call inspector with curl export.

const $ = (id) => document.getElementById(id);
const state = { sessionId: null, lastSeq: 0, events: [], selected: null };

// ─── session picker ───────────────────────────────────────────────────
async function loadSessions() {
  const r = await fetch("/api/sessions").then((r) => r.json());
  const sel = $("session");
  sel.innerHTML = "";
  for (const s of r.data.sessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.id;
    sel.appendChild(opt);
  }
  if (r.data.sessions.length) {
    state.sessionId = r.data.sessions[0].id;
    sel.value = state.sessionId;
    reset();
  }
}
$("session").addEventListener("change", (e) => {
  state.sessionId = e.target.value;
  reset();
});

// ─── polling ──────────────────────────────────────────────────────────
function reset() {
  state.lastSeq = 0;
  state.events = [];
  state.selected = null;
  $("event-list").innerHTML = "";
  $("endpoint-list").innerHTML = "";
  $("inspector-body").innerHTML = '<p class="hint">select an event</p>';
  poll();
}

let pollTimer = null;
async function poll() {
  if (!state.sessionId) return;
  try {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(state.sessionId)}/events?since=${state.lastSeq}`
    ).then((r) => r.json());
    if (r.ok && r.data.events.length) {
      state.events.push(...r.data.events);
      state.lastSeq = r.data.lastSeq;
      renderTimeline();
      renderEndpoints();
    }
  } catch (e) {
    /* ignore transient */
  }
  if ($("live").checked) {
    pollTimer = setTimeout(poll, 1000);
  }
}
$("live").addEventListener("change", () => {
  if (pollTimer) clearTimeout(pollTimer);
  if ($("live").checked) poll();
});

// ─── timeline ─────────────────────────────────────────────────────────
function renderTimeline() {
  const list = $("event-list");
  const filter = $("filter").value.toLowerCase();
  const frag = document.createDocumentFragment();
  for (const evt of state.events) {
    const row = document.createElement("div");
    row.className = `event ev-${evt.kind}`;
    row.dataset.seq = evt.seq;
    row.textContent = "";
    const t = document.createElement("span");
    t.className = "ev-t";
    t.textContent = new Date(evt.t).toLocaleTimeString();
    const kind = document.createElement("span");
    kind.className = "ev-kind";
    kind.textContent = evt.kind.toUpperCase();
    const text = document.createElement("span");
    text.className = "ev-text";
    text.textContent = summary(evt);
    row.append(t, kind, text);
    if (filter && !row.textContent.toLowerCase().includes(filter)) continue;
    row.onclick = () => selectEvent(evt, row);
    if (state.selected === evt.seq) row.classList.add("selected");
    frag.appendChild(row);
  }
  list.innerHTML = "";
  list.appendChild(frag);
  $("event-count").textContent = `(${state.events.length})`;
}

function summary(evt) {
  if (evt.kind === "http") {
    const h = evt.data;
    return `${h.method} ${shortUrl(h.url)} → ${h.status}${h.failed ? " FAIL" : ""}`;
  }
  if (evt.kind === "ws") {
    const w = evt.data;
    return `${w.direction} ${shortUrl(w.url)} ${preview(w.payload)}`;
  }
  if (evt.kind === "ui") {
    const u = evt.data;
    const tgt = u.target ? `[${u.target.tag}] ${u.target.text || ""}` : "";
    return `${u.type} ${tgt}${u.value != null ? ` = ${preview(u.value)}` : ""}`;
  }
  return "";
}
function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname + x.search;
  } catch {
    return u;
  }
}
function preview(s) {
  if (!s) return "";
  const t = String(s).slice(0, 60);
  return t.length < String(s).length ? t + "…" : t;
}

$("filter").addEventListener("input", renderTimeline);

// ─── endpoints ────────────────────────────────────────────────────────
let endpointsCache = [];
async function renderEndpoints() {
  if (!state.events.length) return;
  // compute client-side from current events for snappy updates
  const groups = new Map();
  for (const evt of state.events) {
    if (evt.kind !== "http") continue;
    const h = evt.data;
    let p;
    try {
      p = new URL(h.url);
    } catch {
      continue;
    }
    const tpl = templatePath(p.pathname);
    const key = `${h.method} ${p.origin}${tpl}`;
    let g = groups.get(key);
    if (!g) {
      g = { method: h.method, origin: p.origin, tpl, count: 0, statuses: {}, ws: false };
      groups.set(key, g);
    }
    g.count++;
    g.statuses[h.status] = (g.statuses[h.status] || 0) + 1;
  }
  endpointsCache = [...groups.values()].sort((a, b) => b.count - a.count);
  const list = $("endpoint-list");
  list.innerHTML = "";
  for (const g of endpointsCache) {
    const row = document.createElement("div");
    row.className = "endpoint";
    const m = document.createElement("div");
    m.className = `ep-method m-${g.method}`;
    m.textContent = g.method;
    const path = document.createElement("div");
    path.className = "ep-path";
    path.textContent = g.origin + g.tpl;
    const meta = document.createElement("div");
    meta.className = "ep-meta";
    meta.textContent = `${g.count}×  ${Object.keys(g.statuses)
      .map((s) => `${s}(${g.statuses[s]})`)
      .join(" ")}`;
    row.append(m, path, meta);
    row.onclick = () => filterToEndpoint(g);
    list.appendChild(row);
  }
  $("endpoint-count").textContent = `(${endpointsCache.length})`;
}
function filterToEndpoint(g) {
  $("filter").value = `${g.method} ${g.tpl}`;
  renderTimeline();
}

function templatePath(pathname) {
  return pathname
    .split("/")
    .map((seg) => {
      if (seg === "") return "";
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hex";
      return seg;
    })
    .join("/");
}

// ─── inspector ─────────────────────────────────────────────────────────
function selectEvent(evt, row) {
  state.selected = evt.seq;
  document.querySelectorAll(".event.selected").forEach((e) => e.classList.remove("selected"));
  row.classList.add("selected");
  const body = $("inspector-body");
  body.innerHTML = "";
  if (evt.kind === "http") renderHttpInspector(evt, body);
  else if (evt.kind === "ws") renderWsInspector(evt, body);
  else renderUiInspector(evt, body);
}

function renderHttpInspector(evt, body) {
  const h = evt.data;
  body.appendChild(section("Request", `${h.method} ${h.url}`));
  body.appendChild(kvSection("Request headers", h.requestHeaders));
  if (h.requestBody != null)
    body.appendChild(prettySection("Request body", h.requestBody, h.requestBodyTruncated));
  body.appendChild(kvSection("Response headers", h.responseHeaders));
  if (h.responseBody != null)
    body.appendChild(
      prettySection("Response body", h.responseBody, h.responseBodyTruncated, h.responseBodyBase64)
    );
  body.appendChild(section("Meta", `status ${h.status} ${h.statusText}  ${h.resourceType}  ${h.durationMs || 0}ms`));
  const btn = document.createElement("button");
  btn.className = "copy";
  btn.textContent = "copy curl";
  btn.onclick = () => navigator.clipboard.writeText(toCurl(h));
  body.appendChild(btn);
  const pre = document.createElement("pre");
  pre.className = "curl";
  pre.textContent = toCurl(h);
  body.appendChild(pre);
}

function renderWsInspector(evt, body) {
  const w = evt.data;
  body.appendChild(section("WebSocket", `${w.direction} ${w.url} (opcode ${w.opcode})`));
  body.appendChild(
    prettySection("Payload", w.payload, w.payloadTruncated, w.base64)
  );
}

function renderUiInspector(evt, body) {
  const u = evt.data;
  body.appendChild(section("UI event", u.type));
  if (u.target) body.appendChild(kvSection("Target", u.target));
  if (u.value != null) body.appendChild(section("Value", u.value));
  if (u.meta) body.appendChild(kvSection("Meta", u.meta));
}

function section(title, text) {
  const d = document.createElement("div");
  d.className = "ins-section";
  d.innerHTML = `<h3>${title}</h3><div class="kv">${esc(text)}</div>`;
  return d;
}
function kvSection(title, obj) {
  const d = document.createElement("div");
  d.className = "ins-section";
  const h = document.createElement("h3");
  h.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = Object.entries(obj)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  d.append(h, pre);
  return d;
}
function prettySection(title, body, truncated, base64) {
  const d = document.createElement("div");
  d.className = "ins-section";
  const h = document.createElement("h3");
  h.textContent = title + (truncated ? " (truncated)" : "") + (base64 ? " (base64/binary)" : "");
  const pre = document.createElement("pre");
  pre.textContent = tryPretty(body);
  d.append(h, pre);
  return d;
}
function tryPretty(s) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function toCurl(h) {
  const parts = [`curl -X ${h.method}`];
  for (const [k, v] of Object.entries(h.requestHeaders))
    parts.push(`-H ${quote(`${k}: ${v}`)}`);
  if (h.requestBody != null) parts.push(`--data ${quote(h.requestBody)}`);
  parts.push(quote(h.url));
  return parts.join(" \\\n  ");
}
function quote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ─── catalogue / auth buttons ─────────────────────────────────────────
$("catalogue-btn").onclick = async () => {
  const r = await fetch(`/api/sessions/${state.sessionId}/catalogue`).then((r) => r.json());
  console.log("catalogue", r.data.catalogue);
  alert(`${r.data.catalogue.length} endpoints — logged to browser console`);
};
$("auth-btn").onclick = async () => {
  const r = await fetch(`/api/sessions/${state.sessionId}/auth`).then((r) => r.json());
  console.log("auth snapshot", r.data.auth);
  alert("Auth snapshot logged to browser console");
};

// ─── boot ─────────────────────────────────────────────────────────────
loadSessions();
poll();

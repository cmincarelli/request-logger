// Logger reader UI. Page-grouped view: each page navigation is a collapsible
// header; the API calls + UI actions that happened on that page are listed
// beneath it in order. Inspector shows the selected request/response + curl.

const $ = (id) => document.getElementById(id);

// Resource types that are static assets — hidden from page groups by default
// (toggle with the "assets" checkbox). API calls (Fetch/XHR/Other), WebSocket
// frames, and UI actions are always shown.
const ASSET_TYPES = new Set([
  "Script", "Stylesheet", "Image", "Font", "Manifest", "Media",
  "Prefetch", "Favicon", "CSPViolationReport", "Ping",
]);

const state = {
  sessionId: null,
  lastSeq: 0,
  events: [],
  selected: null,          // seq of the selected event
  renderedSeqs: new Set(), // seqs already in the DOM
  filter: "",             // free-text substring filter (flat mode)
  nearBottom: true,
  groups: [],             // page groups in DOM order
  currentGroup: null,
  allCollapsed: false,
  showAssets: false,
};

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
  state.renderedSeqs = new Set();
  state.nearBottom = true;
  state.groups = [];
  state.currentGroup = null;
  state.allCollapsed = false;
  $("collapse-all-btn").textContent = "collapse all";
  $("page-list").innerHTML = "";
  $("inspector-body").innerHTML = '<p class="hint">select a request to inspect</p>';
  $("page-count").textContent = "";
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
      const wasEmpty = state.events.length === 0;
      state.events.push(...r.data.events);
      state.lastSeq = r.data.lastSeq;
      for (const evt of r.data.events) appendEvent(evt);
      if (wasEmpty && state.selected == null) {
        const firstHttp = state.events.find((e) => e.kind === "http");
        if (firstHttp) selectBySeq(firstHttp.seq);
      }
      if (state.nearBottom) $("page-list").scrollTop = $("page-list").scrollHeight;
    }
    $("page-count").textContent = `(${state.groups.length} pages, ${state.events.length} events)`;
  } catch (e) {
    /* ignore transient */
  }
  if ($("live").checked) pollTimer = setTimeout(poll, 1000);
}
$("live").addEventListener("change", () => {
  if (pollTimer) clearTimeout(pollTimer);
  if ($("live").checked) poll();
});

$("page-list").addEventListener("scroll", () => {
  const el = $("page-list");
  state.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
});

// ─── page grouping ───────────────────────────────────────────────────
// A navigation boundary opens a new page group:
//   • http Document request  → the page itself (provides status)
//   • ui install/popstate/hashchange → SPA / fallback navigation marker
// Consecutive boundaries for the same visit merge (e.g. an install UI event
// followed by that page's Document request) instead of opening two groups.
const BOUNDARY_UI = new Set(["install", "popstate", "hashchange"]);

function pageBoundary(evt) {
  if (evt.kind === "ui" && BOUNDARY_UI.has(evt.data.type))
    return { url: evt.data.meta?.url || "", status: null, kind: "ui" };
  if (evt.kind === "http" && evt.data.resourceType === "Document")
    return { url: evt.data.url, status: evt.data.status, kind: "document" };
  return null;
}

function visible(evt) {
  // hide static assets unless the toggle is on
  if (!state.showAssets && evt.kind === "http" && ASSET_TYPES.has(evt.data.resourceType))
    return false;
  return true;
}

function filteredMode() {
  return Boolean(state.filter);
}

function appendEvent(evt) {
  if (state.renderedSeqs.has(evt.seq)) return;
  state.renderedSeqs.add(evt.seq);

  if (filteredMode()) {
    if (matchesFilter(evt) && visible(evt)) $("page-list").appendChild(buildRow(evt));
    return;
  }

  const boundary = pageBoundary(evt);
  if (boundary) {
    // merge: a Document fills in the status of a pending UI-marker group for the same url
    if (
      boundary.kind === "document" &&
      state.currentGroup &&
      state.currentGroup.createdBy === "ui" &&
      state.currentGroup.url === boundary.url
    ) {
      state.currentGroup.status = boundary.status;
      state.currentGroup.createdBy = "document";
      if (state.currentGroup.statusEl) state.currentGroup.statusEl.textContent = boundary.status;
      return;
    }
    openGroup(boundary.url, boundary.status, boundary.kind);
    return; // the boundary event is the header, not a child row
  }
  if (!visible(evt)) return;
  ensureGroup();
  appendChildRow(evt);
}

function ensureGroup() {
  if (!state.currentGroup) openGroup("(session start)", null, "start");
}

function openGroup(url, status, createdBy) {
  const groupEl = document.createElement("div");
  groupEl.className = "page-group";
  const headerEl = document.createElement("div");
  headerEl.className = "page-group-header";
  const caret = document.createElement("span");
  caret.className = "pg-caret";
  caret.textContent = state.allCollapsed ? "▸" : "▾";
  const badge = document.createElement("span");
  badge.className = "pg-badge";
  badge.textContent = "PAGE";
  const urlEl = document.createElement("span");
  urlEl.className = "pg-url";
  urlEl.textContent = shortUrl(url || "");
  urlEl.title = url || "";
  const statusEl = document.createElement("span");
  statusEl.className = "pg-status";
  statusEl.textContent = status != null ? status : "";
  const countEl = document.createElement("span");
  countEl.className = "pg-count";
  countEl.textContent = "0";
  headerEl.append(caret, badge, urlEl, statusEl, countEl);
  const body = document.createElement("div");
  body.className = "page-group-body";
  if (state.allCollapsed) body.style.display = "none";
  headerEl.onclick = () => {
    const collapsed = body.style.display === "none";
    body.style.display = collapsed ? "" : "none";
    caret.textContent = collapsed ? "▾" : "▸";
  };
  groupEl.append(headerEl, body);
  $("page-list").appendChild(groupEl);
  const g = { url, status, createdBy, count: 0, groupEl, headerEl, body, caret, countEl, statusEl };
  state.groups.push(g);
  state.currentGroup = g;
}

function appendChildRow(evt) {
  const row = buildRow(evt);
  state.currentGroup.body.appendChild(row);
  state.currentGroup.count++;
  state.currentGroup.countEl.textContent = `${state.currentGroup.count}`;
  if (state.allCollapsed) state.currentGroup.body.style.display = "none";
}

function buildRow(evt) {
  const row = document.createElement("div");
  row.className = `event ev-${evt.kind}`;
  row.dataset.seq = evt.seq;
  const t = document.createElement("span");
  t.className = "ev-t";
  t.textContent = new Date(evt.t).toLocaleTimeString();
  const kind = document.createElement("span");
  kind.className = "ev-kind";
  kind.textContent = label(evt);
  const text = document.createElement("span");
  text.className = "ev-text";
  text.textContent = summary(evt);
  row.append(t, kind, text);
  row.onclick = () => selectEvent(evt, row);
  if (state.selected === evt.seq) row.classList.add("selected");
  return row;
}

function label(evt) {
  if (evt.kind === "http") return evt.data.method;
  if (evt.kind === "ws") return "WS";
  return "UI";
}

function matchesFilter(evt) {
  const f = state.filter;
  if (!f) return true;
  return summary(evt).toLowerCase().includes(f);
}

// full rebuild (filter change / assets toggle / reset)
function rebuild() {
  const list = $("page-list");
  list.innerHTML = "";
  state.groups = [];
  state.currentGroup = null;
  if (filteredMode()) {
    const frag = document.createDocumentFragment();
    for (const evt of state.events) {
      if (!matchesFilter(evt) || !visible(evt)) continue;
      frag.appendChild(buildRow(evt));
    }
    list.appendChild(frag);
  } else {
    for (const evt of state.events) {
      const boundary = pageBoundary(evt);
      if (boundary) {
        if (
          boundary.kind === "document" &&
          state.currentGroup &&
          state.currentGroup.createdBy === "ui" &&
          state.currentGroup.url === boundary.url
        ) {
          state.currentGroup.status = boundary.status;
          state.currentGroup.createdBy = "document";
          state.currentGroup.statusEl.textContent = boundary.status;
          continue;
        }
        openGroup(boundary.url, boundary.status, boundary.kind);
      } else if (visible(evt)) {
        ensureGroup();
        appendChildRow(evt);
      }
    }
  }
  $("page-count").textContent = `(${state.groups.length} pages, ${state.events.length} events)`;
}

$("filter").addEventListener("input", (e) => {
  state.filter = e.target.value.toLowerCase();
  rebuild();
});

$("show-assets").addEventListener("change", (e) => {
  state.showAssets = e.target.checked;
  rebuild();
});

$("collapse-all-btn").addEventListener("click", () => {
  state.allCollapsed = !state.allCollapsed;
  $("collapse-all-btn").textContent = state.allCollapsed ? "expand all" : "collapse all";
  for (const g of state.groups) {
    g.body.style.display = state.allCollapsed ? "none" : "";
    g.caret.textContent = state.allCollapsed ? "▸" : "▾";
  }
});

// ─── summaries ────────────────────────────────────────────────────────
function summary(evt) {
  if (evt.kind === "http") {
    const h = evt.data;
    return `${shortUrl(h.url)} → ${h.status}${h.failed ? " FAIL" : ""}`;
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

// ─── inspector ─────────────────────────────────────────────────────────
function selectBySeq(seq) {
  const evt = state.events.find((e) => e.seq === seq);
  if (!evt) return;
  state.selected = seq;
  renderInspector(evt);
  highlightRow(seq);
}
function highlightRow(seq) {
  document.querySelectorAll(".event.selected").forEach((e) => e.classList.remove("selected"));
  const row = $("page-list").querySelector(`.event[data-seq="${seq}"]`);
  if (row) row.classList.add("selected");
}
function selectEvent(evt, row) {
  state.selected = evt.seq;
  renderInspector(evt);
  highlightRow(evt.seq);
}
function renderInspector(evt) {
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
  body.appendChild(
    h.requestBody != null
      ? prettySection("Request body", h.requestBody, h.requestBodyTruncated)
      : placeholder("Request body", "none")
  );
  body.appendChild(kvSection("Response headers", h.responseHeaders));
  body.appendChild(
    h.responseBody != null
      ? prettySection("Response body", h.responseBody, h.responseBodyTruncated, h.responseBodyBase64)
      : placeholder("Response body", h.status === 0 ? "no response" : "none")
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
  body.appendChild(w.payload ? prettySection("Payload", w.payload, w.payloadTruncated, w.base64) : placeholder("Payload", "empty"));
}
function renderUiInspector(evt, body) {
  const u = evt.data;
  body.appendChild(section("UI event", u.type));
  if (u.target) body.appendChild(kvSection("Target", u.target));
  if (u.value != null) body.appendChild(section("Value", u.value));
  else body.appendChild(placeholder("Value", "none"));
  if (u.meta) body.appendChild(kvSection("Meta", u.meta));
}

function section(title, text) {
  const d = document.createElement("div");
  d.className = "ins-section";
  d.innerHTML = `<h3>${title}</h3><div class="kv">${esc(text)}</div>`;
  return d;
}
function placeholder(title, reason) {
  const d = document.createElement("div");
  d.className = "ins-section ins-empty";
  d.innerHTML = `<h3>${title}</h3><div class="kv hint">${reason}</div>`;
  return d;
}
function kvSection(title, obj) {
  const d = document.createElement("div");
  d.className = "ins-section";
  const h = document.createElement("h3");
  h.textContent = title;
  const pre = document.createElement("pre");
  const entries = Object.entries(obj);
  pre.textContent = entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("\n") : "— none —";
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
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function toCurl(h) {
  const parts = [`curl -X ${h.method}`];
  for (const [k, v] of Object.entries(h.requestHeaders)) parts.push(`-H ${quote(`${k}: ${v}`)}`);
  if (h.requestBody != null) parts.push(`--data ${quote(h.requestBody)}`);
  parts.push(quote(h.url));
  return parts.join(" \\\n  ");
}
function quote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// ─── catalogue / auth (console dumps) ────────────────────────────────
$("catalogue-btn").onclick = async () => {
  const r = await fetch(`/api/sessions/${state.sessionId}/catalogue`).then((r) => r.json());
  console.table(r.data.catalogue.map((g) => ({ method: g.method, endpoint: g.origin + g.template, count: g.count, statuses: JSON.stringify(g.statuses) })));
};
$("auth-btn").onclick = async () => {
  const r = await fetch(`/api/sessions/${state.sessionId}/auth`).then((r) => r.json());
  console.log("auth snapshot", r.data.auth);
};

// ─── resizable divider ────────────────────────────────────────────────
function setupDividers() {
  const pages = $("pages");
  const MIN = 200;
  const saved = localStorage.getItem("logger.w.pages");
  if (saved) pages.style.flex = `0 0 ${Math.max(MIN, Number(saved) || MIN)}px`;
  $("divider-1").addEventListener("mousedown", (e) => {
    e.preventDefault();
    $("divider-1").classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const startX = e.clientX;
    const startW = pages.getBoundingClientRect().width;
    const onMove = (ev) => { pages.style.flex = `0 0 ${Math.max(MIN, startW + (ev.clientX - startX))}px`; };
    const onUp = () => {
      $("divider-1").classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("logger.w.pages", pages.getBoundingClientRect().width);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ─── boot ────────────────────────────────────────────────────────────
setupDividers();
loadSessions();
poll();

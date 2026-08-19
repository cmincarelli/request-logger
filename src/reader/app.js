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
  filters: new Set(),      // active method/ui chips (e.g. {"GET","UI"}); empty = all
  textFilter: "",         // partial host/path substring (lowercased)
  typeFilter: "",         // resource-type select (Document/Fetch/XHR/Other/WS/UI)
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
  state.selectedGroup = null;
  state.seqToGroup = new Map();
  state.allCollapsed = false;
  state.filters = new Set();
  state.textFilter = "";
  state.typeFilter = "";
  updateChips();
  syncFilterInputs();
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
        // pick the first real call that belongs to a page group (Document
        // requests are boundaries, not children, so they have no group)
        const firstCall = state.events.find((e) => e.kind === "http" && state.seqToGroup.has(e.seq));
        if (firstCall) selectBySeq(firstCall.seq);
        else if (state.groups[0]) setSelectedGroup(state.groups[0]);
      }
      if (state.nearBottom) $("page-list").scrollTop = $("page-list").scrollHeight;
      // refresh the graph if visible
      if (graphActive()) renderGraph();
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
const BOUNDARY_UI = new Set(["install", "popstate", "hashchange", "nav"]);

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

// Which chip bucket an event falls into for the method/ui filter.
function filterBucket(evt) {
  if (evt.kind === "http") return evt.data.method;
  if (evt.kind === "ws") return "WS";
  return "UI";
}
// partial text match on host/path/search of an http/ws URL (case-insensitive)
function matchesText(evt) {
  if (!state.textFilter) return true;
  const t = state.textFilter;
  if (evt.kind === "http" || evt.kind === "ws") {
    return (evt.data.url || "").toLowerCase().includes(t);
  }
  // UI events: match the page url in meta, or target text
  const u = evt.data.meta?.url || "";
  const txt = evt.data.target?.text || evt.data.target?.css || "";
  return u.toLowerCase().includes(t) || txt.toLowerCase().includes(t);
}
// resource-type select (Document/Fetch/XHR/Other/WS/UI)
function matchesType(evt) {
  if (!state.typeFilter) return true;
  const tf = state.typeFilter;
  if (tf === "UI") return evt.kind === "ui";
  if (tf === "WS") return evt.kind === "ws";
  // http resourceType match
  return evt.kind === "http" && evt.data.resourceType === tf;
}
// True when the event passes all active filters (chips + text + type).
function matchesFilters(evt) {
  if (state.filters.size !== 0 && !state.filters.has(filterBucket(evt))) return false;
  if (!matchesText(evt)) return false;
  if (!matchesType(evt)) return false;
  return true;
}

function appendEvent(evt) {
  if (state.renderedSeqs.has(evt.seq)) return;
  state.renderedSeqs.add(evt.seq);

  const boundary = pageBoundary(evt);
  if (boundary) {
    // Every navigation opens a fresh group. The one exception: an `install` UI
    // marker is emitted right before the page's own Document request for the
    // same URL — skip the install marker so the Document (which carries the
    // status) is the sole header. `nav`/`popstate`/`hashchange` are real route
    // changes with no following Document, so they always open their own group.
    if (
      evt.data.type === "install" &&
      state.events.some(
        (e) => e.seq > evt.seq && e.kind === "http" && e.data.resourceType === "Document" && e.data.url === boundary.url
      )
    ) {
      return;
    }
    openGroup(boundary.url, boundary.status, boundary.kind);
    return; // the boundary event is the header, not a child row
  }
  if (!visible(evt)) return;
  // when method/ui filters are active, only render matching children
  if (!matchesFilters(evt)) return;
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
    setSelectedGroup(g);
  };
  groupEl.append(headerEl, body);
  $("page-list").appendChild(groupEl);
  const g = { url, status, createdBy, count: 0, groupEl, headerEl, body, caret, countEl, statusEl, openedAt: Date.now() };
  state.groups.push(g);
  state.currentGroup = g;
}

function appendChildRow(evt) {
  const row = buildRow(evt);
  state.currentGroup.body.appendChild(row);
  state.currentGroup.count++;
  state.currentGroup.countEl.textContent = `${state.currentGroup.count}`;
  state.seqToGroup.set(evt.seq, state.currentGroup);
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
  // kept for filter-bar; currently unused after switch to chips
  return matchesFilters(evt);
}

// full rebuild (filter change / assets toggle / reset)
function rebuild() {
  const list = $("page-list");
  list.innerHTML = "";
  state.groups = [];
  state.currentGroup = null;
  state.seqToGroup = new Map();
  for (const evt of state.events) {
    const boundary = pageBoundary(evt);
    if (boundary) {
      // skip install UI marker when a Document for the same URL follows it
      if (
        evt.data.type === "install" &&
        state.events.some(
          (e) => e.seq > evt.seq && e.kind === "http" && e.data.resourceType === "Document" && e.data.url === boundary.url
        )
      ) {
        continue;
      }
      openGroup(boundary.url, boundary.status, boundary.kind);
    } else if (visible(evt) && matchesFilters(evt)) {
      ensureGroup();
      appendChildRow(evt);
    }
  }
  // when filtering, drop page groups with no surviving children
  if (state.filters.size > 0) {
    for (const g of state.groups) {
      if (g.count === 0) g.groupEl.remove();
    }
  }
  $("page-count").textContent = `(${state.groups.length} pages, ${state.events.length} events)`;
}

// method/ui chip filters in the pages panel
function updateChips() {
  for (const chip of document.querySelectorAll(".chip")) {
    const f = chip.dataset.f;
    const active = f === "" ? state.filters.size === 0 : state.filters.has(f);
    chip.classList.toggle("active", active);
  }
}
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const f = chip.dataset.f;
    if (f === "") {
      state.filters = new Set();
    } else if (state.filters.has(f)) {
      state.filters.delete(f);
    } else {
      state.filters.add(f);
    }
    updateChips();
    rebuild();
  });
});

$("show-assets").addEventListener("change", (e) => {
  state.showAssets = e.target.checked;
  rebuild();
});

$("text-filter").addEventListener("input", (e) => {
  state.textFilter = e.target.value.toLowerCase().trim();
  rebuild();
});
$("type-filter").addEventListener("change", (e) => {
  state.typeFilter = e.target.value;
  rebuild();
});

// keep the filter inputs in sync with state across reset()/import
function syncFilterInputs() {
  $("text-filter").value = state.textFilter || "";
  $("type-filter").value = state.typeFilter || "";
}

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
  setSelectedGroup(state.seqToGroup.get(seq) || null);
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
  setSelectedGroup(state.seqToGroup.get(evt.seq) || null);
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
  body.appendChild(metaCard(httpMeta(h)));
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
  const btn = document.createElement("button");
  btn.className = "copy";
  btn.textContent = "copy curl";
  btn.onclick = async () => {
    const text = toCurl(h);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // clipboard API may be blocked (non-secure context / no gesture);
      // fall back to a transient textarea + execCommand copy.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        ok = true;
      } catch {
        ok = false;
      }
    }
    const orig = "copy curl";
    btn.textContent = ok ? "✓ copied" : "✗ copy failed";
    btn.classList.toggle("copied", ok);
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
  };
  body.appendChild(btn);
  const pre = document.createElement("pre");
  pre.className = "curl";
  pre.textContent = toCurl(h);
  body.appendChild(pre);
}
function renderWsInspector(evt, body) {
  const w = evt.data;
  body.appendChild(metaCard([{ k: "type", v: "WebSocket" }, { k: "direction", v: w.direction }, { k: "opcode", v: w.opcode }, { k: "url", v: w.url }]));
  body.appendChild(w.payload ? prettySection("Payload", w.payload, w.payloadTruncated, w.base64) : placeholder("Payload", "empty"));
}
function renderUiInspector(evt, body) {
  const u = evt.data;
  body.appendChild(metaCard(uiMeta(u)));
  body.appendChild(section("UI event", u.type));
  if (u.target) body.appendChild(kvSection("Target", u.target));
  if (u.value != null) body.appendChild(section("Value", u.value));
  else body.appendChild(placeholder("Value", "none"));
  if (u.meta) body.appendChild(kvSection("Meta", u.meta));
}

// Build the meta key/values for the summary card at the top of the inspector.
function httpMeta(h) {
  const rows = [
    { k: "method", v: h.method, cls: "m-" + h.method },
    { k: "url", v: h.url, cls: "meta-url" },
    { k: "status", v: h.status + (h.statusText ? " " + h.statusText : ""), cls: h.status >= 400 ? "meta-warn" : (h.status >= 200 && h.status < 300 ? "meta-ok" : "") },
    { k: "type", v: h.resourceType },
    { k: "duration", v: (h.durationMs || 0) + "ms" },
  ];
  if (h.failed) rows.push({ k: "error", v: h.errorText || "failed", cls: "meta-warn" });
  return rows;
}
function uiMeta(u) {
  const rows = [{ k: "type", v: "UI · " + u.type, cls: "ev-ui" }];
  if (u.target && u.target.tag) rows.push({ k: "target", v: (u.target.id ? "#" + u.target.id : u.target.css || u.target.tag) });
  if (u.target && u.target.text) rows.push({ k: "label", v: u.target.text, cls: "meta-url" });
  if (u.meta) for (const [k, v] of Object.entries(u.meta)) rows.push({ k, v: String(v) });
  return rows;
}

// A pretty key/value summary card pinned to the top of the inspector.
function metaCard(rows) {
  const card = document.createElement("div");
  card.className = "meta-card";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "meta-row";
    const k = document.createElement("span");
    k.className = "meta-k";
    k.textContent = r.k;
    const v = document.createElement("span");
    v.className = "meta-v " + (r.cls || "");
    v.textContent = String(r.v);
    if (r.k === "url" || r.k === "target") v.title = String(r.v);
    row.append(k, v);
    card.appendChild(row);
  }
  return card;
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

// ─── export / import session logs ────────────────────────────────────
// Sessions are plain JSONL; export downloads the current one, import uploads
// a previously-exported .jsonl so you can review past captures again.
$("export-btn").onclick = () => {
  if (!state.sessionId) return;
  const a = document.createElement("a");
  a.href = `/api/sessions/${encodeURIComponent(state.sessionId)}/download`;
  a.download = `${state.sessionId}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// Start a fresh capture session: capture rotates to a new JSONL file (the old
// one is preserved on disk). Reload the session list and switch to the new one.
$("new-session-btn").onclick = async () => {
  try {
    const r = await fetch("/api/sessions/new", { method: "POST" }).then((r) => r.json());
    if (!r.ok) { alert("new session failed: " + r.error); return; }
    await loadSessions();
    state.sessionId = r.data.id;
    $("session").value = r.data.id;
    reset();
  } catch (err) {
    alert("new session failed: " + err);
  }
};

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  try {
    const r = await fetch("/api/sessions/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: text,
    }).then((r) => r.json());
    if (r.ok) {
      alert(`imported as ${r.data.id}`);
      await loadSessions();
      state.sessionId = r.data.id;
      $("session").value = r.data.id;
      reset();
    } else {
      alert("import failed: " + r.error);
    }
  } catch (err) {
    alert("import failed: " + err);
  }
  e.target.value = "";
});

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

// ─── tabbed right pane: inspector / domain graph ─────────────────────
function graphActive() {
  return document.querySelector(".tab.active")?.dataset.tab === "graph";
}
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    $("tab-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "graph") {
      resizeGraph();
      renderGraph();
    }
  });
});

// ─── domain graph (force-directed, canvas) ─────────────────────────────
// Nodes = origins (hostnames) touched by the selected page group. Edge:
// page origin → called origin, weighted by call count. Node radius scales
// with call count; colour by eTLD+1 so related subdomains share a hue. Labels
// sit beside the node with a leader line; full hostname on hover.

const graph = {
  canvas: null, ctx: null, raf: 0,
  nodes: [], edges: [], byHost: new Map(),
  hover: null,
  // ephemeral selection so replay re-animates from scratch
  t0: 0,
};

function initGraph() {
  graph.canvas = $("graph-canvas");
  if (!graph.canvas) return;
  graph.ctx = graph.canvas.getContext("2d");
  // hover tooltip
  graph.canvas.addEventListener("mousemove", (e) => {
    const r = graph.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    graph.hover = graph.nodes.find((n) => Math.hypot(n.x - mx, n.y - my) <= n.r + 4) || null;
    graph.canvas.style.cursor = graph.hover ? "pointer" : "default";
    graph.canvas.title = graph.hover ? `${graph.hover.host}\n${graph.hover.calls} calls — click to filter pages` : "";
  });
  // click a node -> filter the pages list to that domain
  graph.canvas.addEventListener("click", (e) => {
    const r = graph.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const hit = graph.nodes.find((n) => Math.hypot(n.x - mx, n.y - my) <= n.r + 4);
    if (!hit) return;
    // toggle: if already filtering to this host, clear it instead
    if (state.textFilter === hit.host.toLowerCase()) {
      state.textFilter = "";
    } else {
      state.textFilter = hit.host.toLowerCase();
    }
    $("text-filter").value = state.textFilter;
    rebuild();
  });
}

function resizeGraph() {
  if (!graph.canvas) initGraph();
  if (!graph.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = graph.canvas.clientWidth, h = graph.canvas.clientHeight;
  graph.canvas.width = Math.max(1, w * dpr);
  graph.canvas.height = Math.max(1, h * dpr);
  graph.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => { if (graphActive()) { resizeGraph(); renderGraph(); } });

// eTLD+1-ish colour: hash the registrable domain to a hue.
function domainColor(host) {
  const parts = host.split(".");
  const reg = parts.length >= 2 ? parts.slice(-2).join(".") : host;
  let h = 0;
  for (let i = 0; i < reg.length; i++) h = (h * 31 + reg.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
function origin(u) {
  try { const x = new URL(u); return x.host; } catch { return null; }
}

// Build nodes/edges for the selected page group (or session-wide fallback).
function buildGraphData() {
  const g = state.selectedGroup;
  // events belonging to this group: walk from the group's first child onward.
  // We approximate by using seqToGroup membership.
  const evts = state.events.filter((e) => state.seqToGroup.get(e.seq) === g);
  const pageOrigin = origin(g ? g.url : "");
  const nodes = new Map(); // host -> {host, calls, color}
  const edges = new Map(); // "from\u0000to" -> {from, to, w}
  const bump = (host, n = 1) => {
    let nd = nodes.get(host);
    if (!nd) { nd = { host, calls: 0, color: domainColor(host) }; nodes.set(host, nd); }
    nd.calls += n;
  };
  for (const e of evts) {
    if (e.kind !== "http" && e.kind !== "ws") continue;
    const callee = origin(e.data.url);
    if (!callee) continue;
    const caller = pageOrigin || callee; // page called it; if no page origin, self
    if (caller) bump(caller);
    bump(callee);
    const key = (caller || callee) + "\u0000" + callee;
    let ed = edges.get(key);
    if (!ed) { ed = { from: caller || callee, to: callee, w: 0 }; edges.set(key, ed); }
    ed.w++;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function setSelectedGroup(g) {
  if (state.selectedGroup === g && g) { if (graphActive()) renderGraph(); return; }
  state.selectedGroup = g;
  if (graphActive()) renderGraph();
}

function renderGraph() {
  if (!graph.canvas) initGraph();
  if (!graph.canvas) return;
  const { nodes, edges } = buildGraphData();
  if (!nodes.length) {
    if (graph.raf) cancelAnimationFrame(graph.raf), (graph.raf = 0);
    const ctx = graph.ctx;
    ctx.clearRect(0, 0, graph.canvas.clientWidth, graph.canvas.clientHeight);
    ctx.fillStyle = "#8a93a8"; ctx.font = "12px sans-serif";
    ctx.fillText("no calls in this page", 12, 20);
    graph.nodes = []; graph.edges = [];
    return;
  }
  // spawn on a small gentle ring so nodes start separated (not clumped at
  // centre, which causes a violent expansion). Fade-in hides any residual jitter.
  const W = graph.canvas.clientWidth, H = graph.canvas.clientHeight;
  const cx = W / 2, cy = H / 2;
  const byHost = new Map(nodes.map((n) => [n.host, { ...n, x: cx, y: cy, vx: 0, vy: 0, r: 10 + Math.sqrt(n.calls) * 5 }]));
  const R0 = Math.min(W, H) * 0.18;
  let i = 0;
  for (const n of byHost.values()) {
    const a = (i++ / byHost.size) * Math.PI * 2;
    n.x = cx + Math.cos(a) * R0;
    n.y = cy + Math.sin(a) * R0;
  }
  graph.nodes = [...byHost.values()];
  graph.edges = edges.map((e) => ({ ...e, from: byHost.get(e.from), to: byHost.get(e.to) })).filter((e) => e.from && e.to);
  graph.byHost = byHost;
  graph.t0 = performance.now();
  if (!graph.raf) tickGraph();
}

// No force simulation / movement on spawn — nodes are placed statically and
// only the glow pulses. The RAF loop just re-draws so the pulse animates.
function tickGraph() {
  drawGraph();
  graph.raf = requestAnimationFrame(tickGraph);
}

function drawGraph() {
  const ctx = graph.ctx;
  const W = graph.canvas.clientWidth, H = graph.canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  // edges with arrowheads
  for (const e of graph.edges) {
    const a = e.from, b = e.to;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const ux = dx / d, uy = dy / d;
    // endpoints on circle borders
    const x1 = a.x + ux * a.r, y1 = a.y + uy * a.r;
    const x2 = b.x - ux * (b.r + 6), y2 = b.y - uy * (b.r + 6);
    ctx.strokeStyle = `rgba(140,160,190,${Math.min(0.85, 0.35 + e.w * 0.12)})`;
    ctx.lineWidth = Math.min(4, 1 + Math.log2(1 + e.w));
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    // arrowhead
    const ah = 7;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - ux * ah + uy * ah * 0.5, y2 - uy * ah - ux * ah * 0.5);
    ctx.lineTo(x2 - ux * ah - uy * ah * 0.5, y2 - uy * ah + ux * ah * 0.5);
    ctx.closePath(); ctx.fill();
  }
  // nodes — radial-gradient halo + core, both pulsing; fade in on spawn.
  const nowMs = performance.now();
  const now = nowMs / 1000;
  const fade = Math.min(1, (nowMs - graph.t0) / 600);
  for (const n of graph.nodes) {
    const pulse = 0.5 + 0.5 * Math.sin(now * 2.2 + n.calls);   // 0..1
    const r = n.r * (1 + pulse * 0.18);                         // visible size breath
    const haloR = r + 14 + pulse * 26;                          // wide glow
    ctx.save();
    // halo: radial gradient colour -> transparent (reads strong on dark bg)
    const grad = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, haloR);
    grad.addColorStop(0, n.color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = (0.35 + pulse * 0.45) * fade * (graph.hover === n ? 1.3 : 1);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2);
    ctx.fill();
    // core
    ctx.globalAlpha = fade * (graph.hover === n ? 1 : 0.95);
    ctx.shadowBlur = 18 + pulse * 26;
    ctx.shadowColor = n.color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.lineWidth = graph.hover === n ? 2.5 : 1.5;
    ctx.strokeStyle = "#fff"; ctx.stroke();
  }
  // labels beside node with leader line, truncated
  for (const n of graph.nodes) {
    const ang = Math.atan2(n.y - H / 2, n.x - W / 2) || 0;
    const lx = n.x + Math.cos(ang) * (n.r + 6);
    const ly = n.y + Math.sin(ang) * (n.r + 6);
    // leader line
    ctx.strokeStyle = "#5a6478"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(n.x + Math.cos(ang) * n.r, n.y + Math.sin(ang) * n.r);
    ctx.lineTo(lx, ly); ctx.stroke();
    // label (right of point if ang points right-ish, else left)
    const full = n.host;
    const max = 24;
    const label = full.length > max ? full.slice(0, max - 1) + "…" : full;
    ctx.font = "11px ui-monospace, Menlo, monospace";
    const tw = ctx.measureText(label).width;
    const right = Math.cos(ang) >= 0;
    const tx = right ? lx + 3 : lx - tw - 3;
    ctx.fillStyle = "#e8ecf5";
    ctx.fillText(label, tx, ly + 4);
    ctx.fillStyle = "#8a93a8"; ctx.font = "9px sans-serif";
    ctx.fillText(`${n.calls}`, right ? tx : tx, ly + 14);
  }
}

// replay button: re-seed positions and re-animate
$("graph-replay").addEventListener("click", () => { renderGraph(); });

// keep the canvas sized to its pane (divider drag, window resize, tab switch)
if (typeof ResizeObserver !== "undefined" && $("inspector")) {
  new ResizeObserver(() => { if (graphActive()) { resizeGraph(); } }).observe($("inspector"));
}

// ─── boot ────────────────────────────────────────────────────────────
initGraph();
setupDividers();
loadSessions();
poll();

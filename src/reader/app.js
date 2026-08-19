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
  state.filters = new Set();
  updateChips();
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
// True when the event passes the active chip filters (empty set = show all).
function matchesFilters(evt) {
  if (state.filters.size === 0) return true;
  return state.filters.has(filterBucket(evt));
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

// ─── boot ────────────────────────────────────────────────────────────
setupDividers();
loadSessions();
poll();

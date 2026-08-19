# Agent Review Spec — how to read & diagnose a Logger session log

This document is a guide for an agent (or human) reviewing a Logger session
file to reverse-engineer a web application's API surface. Logger records a
real Chrome browsing session over the DevTools Protocol and writes every
network exchange and user action to a JSONL file, one event per line.

## Where the logs live

- `logs/session-<timestamp>-<rand>.jsonl` — one file per session.
- Each line is a JSON object (an **event envelope**). The whole session is an
  ordered, append-only stream of these lines.
- Sessions can be **exported** from the reader (`export` button →
  `<id>.jsonl`) and **imported** back (`import`). Treat an exported file as
  the canonical artifact for a review; the live `logs/` directory may be
  wiped between runs.

## The event envelope

Every line shares this shape:

```jsonc
{
  "seq": 1,                 // monotonic per-session sequence number
  "t": 1787151642893,        // Unix epoch milliseconds
  "sessionId": "session-…",  // matches the filename
  "kind": "http" | "ws" | "ui",
  "tab": { "targetId": "…", "url": "…", "title": "…" },
  "data": { … }              // kind-specific payload (below)
}
```

Read events **in `seq` order** — that is the chronological order in which they
happened in the browser. Causality (which user action triggered which call) is
implicit in the order: the UI event immediately preceding an API call is the
most likely trigger.

## `kind: "http"` — a fetch / XHR / resource request

```jsonc
"data": {
  "requestId": "14749.349",
  "method": "POST",
  "url": "https://app.example.com/api/leads/12345/claim",
  "resourceType": "Fetch",          // Fetch | XHR | Other | Document | Script | …
  "status": 200, "statusText": "OK",
  "mimeType": "application/json",
  "requestHeaders": { "Authorization": "Bearer …", "Content-Type": "application/json", … },
  "requestBody": "{\"productId\":1}",
  "requestBodyTruncated": false,
  "responseHeaders": { … },
  "responseBody": "{\"ok\":true,…}",
  "responseBodyBase64": false,       // true when binary (e.g. image/octet-stream)
  "responseBodyTruncated": false,
  "durationMs": 124,
  "failed": false,                   // true when the request errored
  "errorText": "…",                  // present when failed
  "phase": "finished"                // request | response | finished | failed
}
```

Things to note:

- **`resourceType`** classifies the request. `Document` is a page navigation
  (a new "page" in the reader). `Fetch`/`XHR` are the API calls you care about.
  `Script`/`Stylesheet`/`Image`/`Font` are static assets (hidden in the UI by
  default; still present in the raw log).
- **Bodies can be truncated** (`requestBodyTruncated`/`responseBodyTruncated`)
  when they exceed `MAX_BODY_BYTES`. A truncated body is a prefix, not the full
  payload — note this when quoting it.
- **Binary responses** are base64-encoded (`responseBodyBase64: true`). Decode
  if you need the bytes.
- **`failed: true`** means the request never completed (network error, blocked,
  cancelled). `status` may still be 0. Cross-check `errorText`.
- The reader's own UI polling shows up as `GET …/api/sessions/:id/events` calls
  to `127.0.0.1:<READER_PORT>` — **ignore these**; they are the tool, not the
  site under investigation.

## `kind: "ws"` — a WebSocket / SignalR frame

```jsonc
"data": {
  "requestId": "…",
  "url": "wss://app.example.com/hubs/leadpool",
  "direction": "send" | "recv",   // send = client→server, recv = server→client
  "opcode": 1,                    // 1 = text, 2 = binary
  "payload": "{\"type\":6,…}",    // text, or base64 when binary
  "base64": false,
  "payloadTruncated": false
}
```

SignalR specifically:

- A `negotiate` POST (an `http` event) precedes the WebSocket upgrade; it
  returns a `connectionId` and the negotiated transport. Look for it as the
  first call to a `/hubs/<name>/negotiate` path.
- Subsequent `ws` frames carry the hub protocol: JSON (`{"type":…}`) or
  MessagePack. `type` 1 = invocation, 6 = ping, 7 = close, 3 = stream item, etc.
- Correlate `send` frames (client invoking a hub method) with `recv` frames
  (server responses/events) via the hub method name in the payload.

## `kind: "ui"` — a user action or navigation marker

```jsonc
"data": {
  "type": "click" | "input" | "change" | "submit" | "keydown" | "scroll" | "popstate" | "hashchange" | "nav" | "install",
  "t": 1787151642893,
  "target": { "tag": "button", "id": "claimBtn", "css": "#claimBtn", "text": "Claim", "cls": "…" },
  "value": "…",       // for input/change: the field value (may be masked by the site)
  "meta": { … }       // e.g. click coords {x,y,button}, or {url} for nav events
}
```

Navigation markers (used by the reader to open page headers):

- `install` — fired when the instrument is injected into a new document load.
- `nav` — fired when the page calls `history.pushState`/`replaceState` (SPA
  client-side routing; no full page load).
- `popstate` / `hashchange` — back/forward and hash routing.

## How to diagnose — a workflow

1. **Get the catalogue.** The reader's `catalogue` API groups every `http`
   event by `METHOD origin + templated path` (numeric/uuid/hex path segments
   are collapsed to `:id`/`:uuid`/`:hex`). In a terminal:
   ```sh
   curl -s http://127.0.0.1:3001/api/sessions/<id>/catalogue | jq '.data.catalogue'
   ```
   This is the fastest view of "what APIs does this site have".

2. **Get the auth snapshot** to reproduce calls:
   ```sh
   curl -s http://127.0.0.1:3001/api/sessions/<id>/auth | jq '.data.auth'
   ```
   Pulls `Authorization` and `Cookie` headers seen on requests. Use these to
   replay endpoints with `curl` (the reader's inspector shows a ready-made
   `curl` for each request).

3. **Walk the pages.** In the raw JSONL, page boundaries are `install`/`nav`/
   `popstate`/`hashchange` `ui` events (and `Document` `http` events). Everything
   between one boundary and the next belongs to that page. Filter:
   ```sh
   jq -c 'select(.kind=="ui" and (.data.type=="install" or .data.type=="nav"))' logs/<file>.jsonl
   ```

4. **Attribute calls to actions.** For a given API call, find the nearest
   preceding `ui` `click`/`submit`/`keydown` event. That is almost certainly
   the trigger. Example — what clicks the `claim` endpoint:
   ```sh
   jq -c 'select(.data.url|test("claim")) or .data.type=="click"' logs/<file>.jsonl
   ```

5. **Inspect a specific call's bodies** by `requestId`:
   ```sh
   jq -c 'select(.data.requestId=="14749.349")' logs/<file>.jsonl
   ```
   Note `requestBody`/`responseBody` and whether they were truncated.

6. **Replay.** Build a `curl` from a captured request: take `method`, `url`,
   `requestHeaders` (especially `Authorization`/`Cookie`), and `requestBody`.
   The reader inspector emits this for you; reproduce it out of band and
   confirm the response matches `responseBody`.

## Things that are easy to misread

- **Status 0 + `failed`** is *not* a server error — it usually means the
  request never left the browser (CORS preflight blocked, network down, or
  the page closed). Check `errorText`.
- **`OPTIONS` requests** preceding a cross-origin `POST` are the CORS
  preflight, not the real call — the real call is the `POST` that follows.
- **Reader self-traffic** (`127.0.0.1:<READER_PORT>/api/sessions/…/events`)
  is noise from the tool polling its own log. Exclude it.
- **Truncated bodies** are prefixes. Do not treat them as complete.
- **SPA route changes** (`nav`) have no `Document` request — the page never
  reloaded, so there is no status code for the header; that is expected.
- **`install` markers** appear immediately before a `Document` request for the
  same URL — they are instrumentation, not a second navigation. The reader
  dedupes them; when reading raw lines, treat the `Document` as the page.

## Quick recipes

```sh
# all 4xx/5xx API calls
jq -c 'select(.kind=="http" and .data.status>=400)' logs/<file>.jsonl

# all calls to a host, with method + status
jq -r 'select(.kind=="http" and (.data.url|test("powerplay")))|.data.method+" "+(.data.url)+" -> "+(.data.status|tostring)' logs/<file>.jsonl

# every SignalR frame
jq -c 'select(.kind=="ws")' logs/<file>.jsonl

# the click that preceded a given call (by seq)
SEQ=42; jq -c --arg s "$SEQ" 'select(.seq < ($s|tonumber))' logs/<file>.jsonl | tail -5

# unique auth tokens
jq -r 'select(.kind=="http")|.data.requestHeaders.Authorization // empty' logs/<file>.jsonl | sort -u
```

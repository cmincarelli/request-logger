# Logger

Attach to a real Chrome over the DevTools Protocol, capture network + user
events to JSONL while you surf normally, and explore the APIs that drive a
site. Purpose-built for reverse-engineering web apps.

This generalizes the one-off monkey-patching from the PowerPlay project into
a reusable tool: drive a real, signed-in Chrome session (no automation
fingerprint), record every fetch/XHR/WebSocket frame and every click/input,
then mine the log to identify the site's API surface.

## How it works

1. **Start Chrome with a debug port** (`scripts/chrome-debug.sh`). This is your
   normal Chrome — your profile, cookies, extensions. `navigator.webdriver` is
   not set; from the site's perspective it's just you browsing.
2. **Run the capture process** (`pnpm start`). It attaches to `localhost:9222`,
   fans out one CDP client per page target, enables the `Network`/`Page`/
   `Runtime` domains, injects a UI-event instrument via
   `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`, and writes a
   single ordered event stream to `logs/session-<timestamp>.jsonl`.
3. **Run the reader** (`pnpm server`) and open `http://127.0.0.1:3001`. It tails
   the session log and shows a timeline, an endpoint explorer (URLs templated
   to `/api/leads/:id/claim`), and a per-call inspector with curl export.

## Quick start

```sh
pnpm install
cp .env.example .env

# Terminal 1 — Chrome with debug port (dedicated profile by default)
pnpm chrome

# Terminal 2 — capture
pnpm start

# Terminal 3 — reader UI + API
pnpm server
# → http://127.0.0.1:3001
```

In the Chrome window Logger started, browse to your target site and click
around. Events stream into the reader in real time.

## Captured events

All records share an envelope: `{ seq, t, sessionId, kind, tab, data }`.

- **`http`** — fetch/XHR: method, url, status, request/response headers and
  bodies (full, with truncation flag over `MAX_BODY_BYTES`), resourceType,
  initiator, duration, failure info.
- **`ws`** — WebSocket / SignalR frames: url, direction (send/recv), opcode,
  payload (text or base64 for binary).
- **`ui`** — capture-phase DOM events: click, change, input (debounced),
  submit, popstate, hashchange, keydown (Enter), scroll (debounced). Each
  carries a CSS selector + truncated text for the target element.

## API

| Method | Path                                  | Purpose                          |
| ------ | ------------------------------------- | -------------------------------- |
| GET    | `/api/sessions`                       | List session JSONL files         |
| GET    | `/api/sessions/:id/events?since=N`    | Events after seq N (long-poll)   |
| GET    | `/api/sessions/:id/catalogue`         | HTTP endpoints grouped by template |
| GET    | `/api/sessions/:id/auth`              | Authorization/cookie snapshot    |

## Log format

One JSONL file per session under `LOG_DIR` (default `./logs`). Plain JSON per
line so you can also work it directly:

```sh
jq 'select(.kind=="http" and .data.status>=400)' logs/session-*.jsonl
```

## Configuration

See `.env.example`. Key knobs: `CDP_HOST`/`CDP_PORT`, `LOG_DIR`,
`READER_PORT`, `MAX_BODY_BYTES` (0 = no limit).

## Limitations / known gaps (v1)

- **Attach only** — Logger connects to an already-running debug Chrome; it does
  not launch Chrome itself yet (`LAUNCH=true` spawn mode is a planned option).
- **Pre-attach requests are lost** — requests that completed before Logger
  attached aren't captured retroactively. Start Logger, then navigate.
- **Causality attribution** (linking a specific call to the preceding user
  action) is computed trivially from the log but not surfaced in the UI yet.
- **Schema inference** across repeated endpoints, and HAR/Postman export, are
  planned phase-2 features.
- No secret masking — the whole point is reproducing authenticated calls.
  Keep logs local.

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { config, newSessionId } from "./config.js";
import { listSessions, readEvents, lastSeq } from "./log.js";
import type { EventEnvelope, HttpEvent } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: false });

// Accept raw string bodies for the import endpoint (JSONL upload).
app.addContentTypeParser(
  ["application/x-ndjson", "text/plain", "application/octet-stream"],
  { parseAs: "string" },
  (_req, body, done) => done(null, body)
);

await app.register(fastifyStatic, {
  root: join(__dirname, "reader"),
  prefix: "/",
});

// ─── API ──────────────────────────────────────────────────────────────

app.get("/api/sessions", async () => {
  const sessions = listSessions(config.logDir).map((s) => {
    const max = lastSeq(s.path);
    return { id: s.id, path: s.path, lastSeq: max };
  });
  return { ok: true, data: { sessions } };
});

app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
  "/api/sessions/:id/events",
  async (req, reply) => {
    const sessions = listSessions(config.logDir);
    const s = sessions.find((x) => x.id === req.params.id);
    if (!s) return reply.code(404).send({ ok: false, error: "session not found" });
    const since = parseInt(req.query.since || "0", 10) || 0;
    const events = readEvents(s.path, since);
    return { ok: true, data: { events, lastSeq: events.length ? events[events.length - 1].seq : since } };
  }
);

// Endpoint catalogue: group HTTP events by method + templated path.
app.get<{ Params: { id: string } }>(
  "/api/sessions/:id/catalogue",
  async (req, reply) => {
    const sessions = listSessions(config.logDir);
    const s = sessions.find((x) => x.id === req.params.id);
    if (!s) return reply.code(404).send({ ok: false, error: "session not found" });
    const events = readEvents(s.path, 0);
    const groups = new Map<string, {
      key: string;
      method: string;
      template: string;
      origin: string;
      count: number;
      statuses: Record<number, number>;
      sample: HttpEvent | null;
      lastT: number;
    }>();
    for (const evt of events) {
      if (evt.kind !== "http") continue;
      const h = evt.data as HttpEvent;
      let parsed: URL;
      try {
        parsed = new URL(h.url);
      } catch {
        continue;
      }
      const tpl = templatePath(parsed.pathname);
      const key = `${h.method} ${parsed.origin}${tpl}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, method: h.method, template: tpl, origin: parsed.origin, count: 0, statuses: {}, sample: null, lastT: 0 };
        groups.set(key, g);
      }
      g.count++;
      g.statuses[h.status] = (g.statuses[h.status] || 0) + 1;
      g.lastT = Math.max(g.lastT, evt.t);
      if (!g.sample) g.sample = h;
    }
    const catalogue = [...groups.values()].sort((a, b) => b.count - a.count);
    return { ok: true, data: { catalogue } };
  }
);

// Auth snapshot: pull token-ish headers/values out of captured requests.
app.get<{ Params: { id: string } }>("/api/sessions/:id/auth", async (req, reply) => {
  const sessions = listSessions(config.logDir);
  const s = sessions.find((x) => x.id === req.params.id);
  if (!s) return reply.code(404).send({ ok: false, error: "session not found" });
  const events = readEvents(s.path, 0);
  const auth = new Map<string, string>();
  for (const evt of events) {
    if (evt.kind !== "http") continue;
    const h = evt.data as HttpEvent;
    const authHeader = h.requestHeaders["Authorization"] || h.requestHeaders["authorization"];
    if (authHeader) auth.set("Authorization", authHeader);
    const cookie = h.requestHeaders["Cookie"] || h.requestHeaders["cookie"];
    if (cookie) auth.set("Cookie", cookie);
  }
  return { ok: true, data: { auth: Object.fromEntries(auth) } };
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/download", async (req, reply) => {
  const sessions = listSessions(config.logDir);
  const s = sessions.find((x) => x.id === req.params.id);
  if (!s) return reply.code(404).send({ ok: false, error: "session not found" });
  if (!existsSync(s.path)) return reply.code(404).send({ ok: false, error: "file missing" });
  // stream the raw JSONL as an attachment
  reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.header(
    "Content-Disposition",
    `attachment; filename="${req.params.id}.jsonl"`
  );
  return reply.send(readFileSync(s.path));
});

// Import a previously-exported session JSONL. Body is the raw file content
// (Content-Type: application/x-ndjson or text/plain). Writes it under LOG_DIR.
app.post("/api/sessions/import", { bodyLimit: 256 * 1024 * 1024 }, async (req, reply) => {
  const body = req.body;
  if (typeof body !== "string" && !Buffer.isBuffer(body))
    return reply.code(400).send({ ok: false, error: "expected raw JSONL body" });
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  // validate: each non-empty line must be valid JSON with the event shape
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return reply.code(400).send({ ok: false, error: "empty" });
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as EventEnvelope;
      if (typeof e.seq !== "number" || typeof e.kind !== "string")
        return reply.code(400).send({ ok: false, error: "not a logger event line" });
    } catch {
      return reply.code(400).send({ ok: false, error: "invalid JSON line" });
    }
  }
  mkdirSync(config.logDir, { recursive: true });
  const id = newSessionId();
  const path = join(config.logDir, `${id}.jsonl`);
  writeFileSync(path, text);
  return { ok: true, data: { id, path } };
});

export function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (seg === "") return "";
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
        return ":uuid";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hex";
      return seg;
    })
    .join("/");
}

export interface ServerOptions {
  /** Called by POST /api/sessions/new to rotate capture to a fresh session. */
  onNewSession?: () => string;
}

export async function startServer(opts: ServerOptions = {}): Promise<{ close: () => Promise<void> }> {
  // Rotate capture to a new session file. Returns the new session id.
  app.post("/api/sessions/new", async (_req, reply) => {
    if (!opts.onNewSession) return reply.code(501).send({ ok: false, error: "capture not running in-process" });
    const id = opts.onNewSession();
    return { ok: true, data: { id } };
  });
  await app.listen({ host: config.readerHost, port: config.readerPort });
  console.log(`[reader] http://${config.readerHost}:${config.readerPort}`);
  console.log(`[reader] logs: ${resolve(config.logDir)}`);
  return {
    async close() {
      await app.close();
    },
  };
}

// Run standalone when invoked directly (npm run server).
const isMain = (() => {
  if (!process.argv[1]) return false;
  return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
})();
if (isMain) {
  startServer().catch((err) => {
    console.error("[reader] failed to start:", err);
    process.exit(1);
  });
}

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.js";
import { listSessions, readEvents, lastSeq } from "./log.js";
import type { EventEnvelope, HttpEvent } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: false });

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

function templatePath(pathname: string): string {
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

const start = async () => {
  try {
    await app.listen({ host: config.readerHost, port: config.readerPort });
    console.log(`[reader] http://${config.readerHost}:${config.readerPort}`);
    console.log(`[reader] logs: ${resolve(config.logDir)}`);
  } catch (err) {
    console.error("[reader] failed to start:", err);
    process.exit(1);
  }
};
void start();

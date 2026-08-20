import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  openSync,
  readSync,
  statSync,
  closeSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { config, newSessionId } from "./config.js";
import type {
  EventEnvelope,
  SessionManifestEntry,
  HttpEvent,
  WsEvent,
  UiEvent,
} from "./schema.js";

/**
 * JSONL log writer. One file per session under LOG_DIR. The reader scans the
 * directory for *.jsonl files so the manifest is advisory, not authoritative.
 */

export class SessionLog {
  readonly sessionId: string;
  readonly path: string;
  private seq = 0;
  private counts = { http: 0, ws: 0, ui: 0, tab: 0 };
  private hosts: Record<string, number> = {};
  private startedAt = Date.now();

  private constructor(sessionId: string, path: string) {
    this.sessionId = sessionId;
    this.path = path;
  }

  static create(logDir: string, label: string): SessionLog {
    mkdirSync(logDir, { recursive: true });
    const id = newSessionId();
    const name = label ? `${id}__${safe(label)}.jsonl` : `${id}.jsonl`;
    const path = join(logDir, name);
    // Touch the file so directory scans see it immediately.
    appendFileSync(path, "");
    return new SessionLog(id, path);
  }

  append(evt: Omit<EventEnvelope, "seq" | "sessionId">): EventEnvelope {
    const full: EventEnvelope = {
      ...evt,
      seq: ++this.seq,
      sessionId: this.sessionId,
    } as EventEnvelope;
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    this.counts[full.kind] += 1;
    if (full.kind === "http") {
      try {
        const host = new URL((full.data as { url: string }).url).host;
        this.hosts[host] = (this.hosts[host] || 0) + 1;
      } catch {
        /* non-URL or ws: URLs fall through */
      }
    }
    return full;
  }

  manifestEntry(): SessionManifestEntry {
    return {
      sessionId: this.sessionId,
      path: basename(this.path),
      startedAt: this.startedAt,
      endedAt: Date.now(),
      counts: this.counts,
      hosts: this.hosts,
    };
  }
}

function safe(s: string): string {
  return s.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40);
}

/** Scan the log dir for *.jsonl. Sorted newest-first by filename (timestamped). */
export function listSessions(logDir = config.logDir): { id: string; path: string }[] {
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .map((f) => ({ id: f.replace(/\.jsonl$/, ""), path: join(logDir, f) }));
}

/** Read events from a session file with seq >= `since` (0 = all).
 *  Streams line-by-line so a huge session file (hundreds of MB) never has to
 *  be materialized as a single string (which would throw ERR_STRING_TOO_LONG).
 *  `limit` stops the scan early so paged reads don't re-walk the whole file. */
export async function readEvents(
  path: string,
  since = 0,
  limit = 0
): Promise<EventEnvelope[]> {
  if (!existsSync(path)) return [];
  const out: EventEnvelope[] = [];
  const rl = readline.createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as EventEnvelope;
      if (evt.seq > since) {
        out.push(evt);
        if (limit > 0 && out.length >= limit) break;
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Last seq number seen in a session file (for long-poll style updates).
 *  Reads only the file tail to avoid loading a huge file into memory. */
export function lastSeq(path: string): number {
  if (!existsSync(path)) return 0;
  // Read the last ~64KB; a single event line is well under that. This avoids
  // pulling a 500MB+ file into a string (which would throw ERR_STRING_TOO_LONG).
  const stat = statSync(path);
  const tailLen = Math.min(64 * 1024, stat.size);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(tailLen);
    readSync(fd, buf, 0, tailLen, Math.max(0, stat.size - tailLen));
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) return 0;
    // The tail may start mid-line; the last complete line is the final event.
    try {
      return (JSON.parse(lines[lines.length - 1]) as EventEnvelope).seq;
    } catch {
      return 0;
    }
  } finally {
    closeSync(fd);
  }
}

/** Body fields stripped from /events metadata responses so bulk reads are
 *  bounded by event count, not body size. Bodies are fetched on demand per
 *  event via readEventBodies(). Keep this explicit (not a generic omit) so
 *  the set of stripped fields is obvious. */
export type EventMeta = Omit<EventEnvelope, "data"> & {
  data: HttpMeta | WsMeta | UiEvent | TabEvent;
};
export type HttpMeta = Omit<HttpEvent,
  "requestBody" | "requestBodyTruncated" |
  "responseBody" | "responseBodyBase64" | "responseBodyTruncated">;
export type WsMeta = Omit<WsEvent, "payload" | "base64" | "payloadTruncated">;
export type TabEvent = { action: "open" | "close" | "update" };

/** Just the bodies for one event, fetched when the inspector opens it. */
export interface EventBodies {
  requestBody?: string | null;
  requestBodyTruncated?: boolean;
  responseBody?: string | null;
  responseBodyBase64?: boolean;
  responseBodyTruncated?: boolean;
  payload?: string;
  base64?: boolean;
  payloadTruncated?: boolean;
}

function stripBodies(e: EventEnvelope): EventMeta {
  if (e.kind === "http") {
    const h = e.data as HttpEvent;
    const { requestBody, requestBodyTruncated, responseBody, responseBodyBase64, responseBodyTruncated, ...meta } = h;
    return { ...e, data: meta } as unknown as EventMeta;
  }
  if (e.kind === "ws") {
    const w = e.data as WsEvent;
    const { payload, base64, payloadTruncated, ...meta } = w;
    return { ...e, data: meta } as unknown as EventMeta;
  }
  return e as unknown as EventMeta;
}

/** Read events with seq >= `since` as metadata-only (bodies stripped),
 *  stopping at a byte budget. Returns the metadata page plus the seq of the
 *  last event included (for the next page request) and hasMore. Bounded by
 *  serialized size so a page is safe to JSON.stringify regardless of how big
 *  the bodies in the file are. */
export async function readEventsMeta(
  path: string,
  since = 0,
  byteBudget = 2 * 1024 * 1024
): Promise<{ events: EventMeta[]; lastSeq: number; hasMore: boolean }> {
  if (!existsSync(path)) return { events: [], lastSeq: since, hasMore: false };
  const events: EventMeta[] = [];
  let size = 0;
  let lastSeq = since;
  let hasMore = false;
  const rl = readline.createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let evt: EventEnvelope;
    try { evt = JSON.parse(line) as EventEnvelope; } catch { continue; }
    if (evt.seq <= since) continue;
    const meta = stripBodies(evt);
    const lineLen = line.length + 1; // +1 for the newline
    if (size > 0 && size + lineLen > byteBudget) { hasMore = true; break; }
    events.push(meta);
    size += lineLen;
    lastSeq = evt.seq;
  }
  return { events, lastSeq, hasMore };
}

/** Find one event by seq and return its bodies (request/response/payload).
 *  Streams the file once; used by the inspector on demand. */
export async function readEventBodies(path: string, seq: number): Promise<EventBodies | null> {
  if (!existsSync(path)) return null;
  const rl = readline.createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let evt: EventEnvelope;
    try { evt = JSON.parse(line) as EventEnvelope; } catch { continue; }
    if (evt.seq !== seq) continue;
    if (evt.kind === "http") {
      const h = evt.data as HttpEvent;
      return {
        requestBody: h.requestBody,
        requestBodyTruncated: h.requestBodyTruncated,
        responseBody: h.responseBody,
        responseBodyBase64: h.responseBodyBase64,
        responseBodyTruncated: h.responseBodyTruncated,
      };
    }
    if (evt.kind === "ws") {
      const w = evt.data as WsEvent;
      return {
        payload: w.payload,
        base64: w.base64,
        payloadTruncated: w.payloadTruncated,
      };
    }
    return {}; // ui / tab events have no bodies
  }
  return null;
}

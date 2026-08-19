import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { config, newSessionId } from "./config.js";
import type { EventEnvelope, SessionManifestEntry } from "./schema.js";

/**
 * JSONL log writer. One file per session under LOG_DIR. The reader scans the
 * directory for *.jsonl files so the manifest is advisory, not authoritative.
 */

export class SessionLog {
  readonly sessionId: string;
  readonly path: string;
  private seq = 0;
  private counts = { http: 0, ws: 0, ui: 0 };
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

/** Read events from a session file with seq >= `since` (0 = all). */
export function readEvents(path: string, since = 0): EventEnvelope[] {
  if (!existsSync(path)) return [];
  const out: EventEnvelope[] = [];
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as EventEnvelope;
      if (evt.seq > since) out.push(evt);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Last seq number seen in a session file (for long-poll style updates). */
export function lastSeq(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return 0;
  try {
    return (JSON.parse(lines[lines.length - 1]) as EventEnvelope).seq;
  } catch {
    return 0;
  }
}

import "dotenv/config";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export const config = {
  cdpHost: process.env.CDP_HOST || "127.0.0.1",
  cdpPort: int("CDP_PORT", 9222),
  logDir: process.env.LOG_DIR || "./logs",
  readerHost: process.env.READER_HOST || "127.0.0.1",
  readerPort: int("READER_PORT", 3001),
  sessionLabel: process.env.SESSION_LABEL || "",
  maxBodyBytes: int("MAX_BODY_BYTES", 262144),
};

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `session-${stamp}-${rand}`;
}

/**
 * Unified entry point: one process, one Ctrl-C.
 *
 *   npm start
 *
 * Spawns Chrome with the debug port (if one isn't already serving), starts the
 * CDP capture, and starts the reader UI server — all in-process. SIGINT/SIGTERM
 * closes the capture, stops the server, and (if we launched it) quits Chrome,
 * then prints the session manifest.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { SessionLog } from "./log.js";
import { startCapture, type CaptureHandle } from "./cdp.js";
import { startServer } from "./server.js";

// ─── Chrome lifecycle ────────────────────────────────────────────────

const CHROME_APP =
  process.env.BROWSER || "Google Chrome";
const CHROME_BIN = `/Applications/${CHROME_APP}.app/Contents/MacOS/${CHROME_APP}`;
const DEDICATED_PROFILE = join(
  homedir(),
  "Library/Application Support/Google/Chrome/logger-debug"
);

async function chromeIsUp(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for Chrome to answer on the debug port (up to timeoutMs). */
async function waitForChrome(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await chromeIsUp(host, port)) return;
    const remain = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r[logger] waiting for Chrome at ${host}:${port} ... (${remain}s)   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\n");
  throw new Error(`Chrome did not come up on ${host}:${port} within ${timeoutMs / 1000}s`);
}

/**
 * Ensure a debug Chrome is running. Returns the child if we spawned it (so we
 * can kill it on shutdown), or null if one was already serving.
 */
async function ensureChrome(): Promise<{ child: ChildProcess | null }> {
  // Already up? Reuse it; don't own it.
  if (await chromeIsUp(config.cdpHost, config.cdpPort)) {
    console.log(`[logger] reusing debug Chrome at ${config.cdpHost}:${config.cdpPort}`);
    return { child: null };
  }

  if (!existsSync(CHROME_BIN)) {
    throw new Error(`Chrome not found at ${CHROME_BIN}`);
  }

  // Dedicated profile: clear a stale SingletonLock from a killed Chrome.
  const lock = join(DEDICATED_PROFILE, "SingletonLock");
  if (existsSync(lock) || existsSync(lock + " ")) {
    try {
      rmSync(lock, { force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(`[logger] launching Chrome (dedicated profile, port ${config.cdpPort})`);
  const child = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${config.cdpPort}`,
      `--user-data-dir=${DEDICATED_PROFILE}`,
    ],
    { stdio: "ignore", detached: false }
  );

  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[logger] Chrome exited with code ${code}`);
    }
  });

  return { child };
}

/** Gracefully quit a Chrome we spawned. */
async function stopChrome(child: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  // Ask Chrome to shut down cleanly via its debug endpoint.
  try {
    await fetch(`http://${config.cdpHost}:${config.cdpPort}/json/close`, {
      method: "PUT",
    });
  } catch {
    /* ignore — fall back to signal */
  }
  // Give it a moment, then SIGTERM, then SIGKILL.
  await new Promise((r) => setTimeout(r, 800));
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }, 3000);
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
  }
}

// ─── orchestration ───────────────────────────────────────────────────

async function main() {
  const log = SessionLog.create(config.logDir, config.sessionLabel);
  console.log(`[logger] session ${log.sessionId}`);
  console.log(`[logger] writing ${log.path}`);

  // 1. Chrome
  let chrome: { child: ChildProcess | null };
  try {
    chrome = await ensureChrome();
  } catch (err) {
    console.error(`[logger] ${(err as Error).message}`);
    process.exit(1);
  }
  try {
    await waitForChrome(config.cdpHost, config.cdpPort);
    process.stdout.write("\r[logger] Chrome is up.                                  \n");
  } catch (err) {
    console.error(`\n[logger] ${(err as Error).message}`);
    if (chrome.child) await stopChrome(chrome.child);
    process.exit(1);
  }

  // 2. Capture
  let capture: CaptureHandle;
  try {
    capture = await startCapture(log);
  } catch (err) {
    console.error("[logger] failed to attach to Chrome:", err);
    if (chrome.child) await stopChrome(chrome.child);
    process.exit(1);
  }

  // 3. Reader
  let server: { close: () => Promise<void> };
  try {
    server = await startServer();
  } catch (err) {
    console.error("[logger] failed to start reader:", err);
    try {
      await capture.close();
    } catch {
      /* ignore */
    }
    if (chrome.child) await stopChrome(chrome.child);
    process.exit(1);
  }

  console.log(`[logger] reader at http://${config.readerHost}:${config.readerPort}`);
  console.log("[logger] ready — browse in the Chrome window. Ctrl-C to stop.");

  // Heartbeat so you can see capture is alive.
  const hb = setInterval(() => {
    const m = log.manifestEntry();
    console.log(
      `[logger] heartbeat http=${m.counts.http} ws=${m.counts.ws} ui=${m.counts.ui}`
    );
  }, 15_000).unref();

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[logger] ${sig} received, shutting down...`);
    clearInterval(hb);
    try {
      await capture.close();
      console.log("[logger] capture closed");
    } catch {
      /* ignore */
    }
    try {
      await server.close();
      console.log("[logger] reader closed");
    } catch {
      /* ignore */
    }
    if (chrome.child) {
      console.log("[logger] closing Chrome");
      await stopChrome(chrome.child);
    }
    console.log(`[logger] session ${log.sessionId} manifest:`);
    console.log(JSON.stringify(log.manifestEntry(), null, 2));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[logger] fatal:", err);
  process.exit(1);
});

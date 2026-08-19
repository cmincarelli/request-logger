import { SessionLog } from "./log.js";
import { config } from "./config.js";
import { startCapture } from "./cdp.js";

/** Poll the CDP /json/version endpoint until Chrome is up (or give up). */
async function waitForChrome(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const url = `http://${host}:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    const remain = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r[logger] waiting for Chrome at ${host}:${port} ... (${remain}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\n");
  throw new Error(`Chrome did not come up on ${host}:${port} within ${timeoutMs / 1000}s`);
}

async function main() {
  const log = SessionLog.create(config.logDir, config.sessionLabel);
  console.log(`[logger] session ${log.sessionId}`);
  console.log(`[logger] writing ${log.path}`);
  console.log(`[logger] attaching to ${config.cdpHost}:${config.cdpPort} ...`);
  console.log(`[logger] reader at http://${config.readerHost}:${config.readerPort}`);

  // Wait for Chrome so capture can start before/alongside the browser boot.
  try {
    await waitForChrome(config.cdpHost, config.cdpPort);
    process.stdout.write("\r[logger] Chrome is up.                              \n");
  } catch (err) {
    console.error(`\n[logger] ${(err as Error).message}`);
    console.error("[logger] start Chrome with the debug port first:  pnpm chrome");
    process.exit(1);
  }

  let handle;
  try {
    handle = await startCapture(log);
  } catch (err) {
    console.error("[logger] failed to attach to Chrome:", err);
    console.error("[logger] is Chrome running with --remote-debugging-port?  run: pnpm chrome");
    process.exit(1);
  }

  const shutdown = async (sig: string) => {
    console.log(`\n[logger] ${sig} received, closing session ${log.sessionId}`);
    console.log(`[logger] manifest: ${JSON.stringify(log.manifestEntry())}`);
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep alive + periodic manifest heartbeat.
  setInterval(() => {
    const m = log.manifestEntry();
    console.log(
      `[logger] heartbeat http=${m.counts.http} ws=${m.counts.ws} ui=${m.counts.ui}`
    );
  }, 15_000).unref();
}

main().catch((err) => {
  console.error("[logger] fatal:", err);
  process.exit(1);
});

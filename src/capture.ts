import { SessionLog } from "./log.js";
import { config } from "./config.js";
import { startCapture } from "./cdp.js";

async function main() {
  const log = SessionLog.create(config.logDir, config.sessionLabel);
  console.log(`[logger] session ${log.sessionId}`);
  console.log(`[logger] writing ${log.path}`);
  console.log(`[logger] attaching to ${config.cdpHost}:${config.cdpPort} ...`);
  console.log(`[logger] reader at http://${config.readerHost}:${config.readerPort}`);

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

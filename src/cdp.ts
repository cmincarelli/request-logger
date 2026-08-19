import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import CDP from "chrome-remote-interface";
import { config } from "./config.js";
import { SessionLog } from "./log.js";
import type {
  EventEnvelope,
  HttpEvent,
  WsEvent,
  UiEvent,
  TabRef,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SCRIPT = readFileSync(join(__dirname, "init-script.js"), "utf8");

/** Fetch the browser-level webSocketDebuggerUrl from /json/version. */
async function browserWsUrl(): Promise<string> {
  const res = await fetch(`http://${config.cdpHost}:${config.cdpPort}/json/version`);
  if (!res.ok) throw new Error(`/json/version returned ${res.status}`);
  const json = (await res.json()) as { webSocketDebuggerUrl: string };
  if (!json.webSocketDebuggerUrl)
    throw new Error("no webSocketDebuggerUrl in /json/version");
  return json.webSocketDebuggerUrl;
}

interface ListEntry {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
}

/** List page-type targets with their webSocketDebuggerUrl from /json/list. */
async function listPageTargets(): Promise<ListEntry[]> {
  const res = await fetch(`http://${config.cdpHost}:${config.cdpPort}/json/list`);
  if (!res.ok) throw new Error(`/json/list returned ${res.status}`);
  const entries = (await res.json()) as ListEntry[];
  return entries.filter((e) => e.type === "page" && e.webSocketDebuggerUrl);
}

/** Resolve a single targetId to its /json/list entry (retry briefly for new tabs). */
async function resolveTarget(
  targetId: string,
  tries = 5
): Promise<ListEntry | null> {
  for (let i = 0; i < tries; i++) {
    const pages = await listPageTargets();
    const found = pages.find((p) => p.id === targetId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

interface PendingRequest {
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  initiator?: unknown;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  requestBodyTruncated?: boolean;
  startWallMs: number;
  response?: {
    status: number;
    statusText: string;
    mimeType?: string;
    headers: Record<string, string>;
  };
}

interface TargetState {
  targetId: string;
  client: CDPClient;
  tab: TabRef;
  pending: Map<string, PendingRequest>;
  wsUrls: Map<string, string>;
}

// chrome-remote-interface is loosely typed here; we cast to any for ergonomics.
type CDPClient = {
  [domain: string]: any;
  close: () => Promise<void>;
  on: (event: string, handler: (params: any) => void) => void;
  send: (method: string, params?: any) => Promise<any>;
};

export interface CaptureHandle {
  close: () => Promise<void>;
}

export async function startCapture(getLog: () => SessionLog): Promise<CaptureHandle> {
  const targets = new Map<string, TargetState>();
  const maxBody = config.maxBodyBytes;

  const browser = (await CDP({
    target: await browserWsUrl(),
  })) as unknown as CDPClient;

  // Browser-level Target domain has no .enable(); setDiscoverTargets turns on
  // targetCreated/targetDestroyed notifications.
  await browser.Target.setDiscoverTargets({ discover: true });

  const emit = (kind: "http" | "ws" | "ui", data: any, tab: TabRef) => {
    getLog().append({ t: Date.now(), kind, tab, data });
  };

  async function attach(targetInfo: any) {
    const targetId = targetInfo.targetId as string;
    if (targetInfo.type !== "page") return;
    if (targets.has(targetId)) return;

    // Resolve the page's webSocketDebuggerUrl (targetInfo from CDP lacks it).
    const entry = await resolveTarget(targetId);
    if (!entry) {
      console.error(`[cdp] could not resolve ws url for ${targetId}`);
      return;
    }

    let client: CDPClient;
    try {
      client = (await CDP({
        target: entry.webSocketDebuggerUrl,
      })) as unknown as CDPClient;
    } catch (err) {
      console.error(`[cdp] failed to attach ${targetId}:`, err);
      return;
    }

    const state: TargetState = {
      targetId,
      client,
      tab: { targetId, url: targetInfo.url || "", title: targetInfo.title },
      pending: new Map(),
      wsUrls: new Map(),
    };
    targets.set(targetId, state);

    const truncate = (s: string): { body: string; truncated: boolean } => {
      if (maxBody > 0 && s.length > maxBody)
        return { body: s.slice(0, maxBody), truncated: true };
      return { body: s, truncated: false };
    };

    try {
      await client.Network.enable({ maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 });
      await client.Page.enable();
      await client.Runtime.enable();
      await client.Runtime.addBinding({ name: "__loggerEvent" });
      await client.Page.addScriptToEvaluateOnNewDocument({ source: INIT_SCRIPT });
      // Install on the currently-loaded document too (best-effort).
      try {
        await client.Runtime.evaluate({
          expression: INIT_SCRIPT,
          allowUnsafeEvalBlockedByCSP: false,
        } as any);
      } catch {
        /* CSP or detached frame — ignore */
      }
    } catch (err) {
      console.error(`[cdp] enable failed for ${targetId}:`, err);
    }

    client.on("Page.frameNavigated", (params: any) => {
      const url: string | undefined = params?.frame?.url;
      if (url) state.tab.url = url;
    });

    client.on("Network.requestWillBeSent", (params: any) => {
      const req = params.request || {};
      const body: string | null = req.postData ?? null;
      const t = truncate(body || "");
      state.pending.set(params.requestId, {
        requestId: params.requestId,
        method: req.method,
        url: req.url,
        resourceType: params.type || "Other",
        initiator: params.initiator,
        requestHeaders: req.headers || {},
        requestBody: body ? t.body : null,
        requestBodyTruncated: body ? t.truncated : undefined,
        startWallMs: Date.now(),
      });
    });

    client.on("Network.responseReceived", (params: any) => {
      const p = state.pending.get(params.requestId);
      if (!p) return;
      const r = params.response || {};
      p.response = {
        status: r.status || 0,
        statusText: r.statusText || "",
        mimeType: r.mimeType,
        headers: r.headers || {},
      };
    });

    client.on("Network.loadingFinished", async (params: any) => {
      const p = state.pending.get(params.requestId);
      if (!p) return;
      state.pending.delete(params.requestId);
      let responseBody: string | null = null;
      let responseBodyBase64 = false;
      let responseBodyTruncated = false;
      try {
        const bodyResp = await client.Network.getResponseBody({ requestId: params.requestId });
        const raw = bodyResp.body ?? "";
        if (bodyResp.base64Encoded) {
          responseBodyBase64 = true;
          if (maxBody > 0 && raw.length > maxBody) {
            responseBody = raw.slice(0, maxBody);
            responseBodyTruncated = true;
          } else {
            responseBody = raw;
          }
        } else {
          const t = truncate(raw);
          responseBody = t.body;
          responseBodyTruncated = t.truncated;
        }
      } catch {
        /* not available (redirect/blocked/cached) — leave body null */
      }
      const ev: HttpEvent = {
        requestId: p.requestId,
        method: p.method,
        url: p.url,
        resourceType: p.resourceType,
        status: p.response?.status || 0,
        statusText: p.response?.statusText || "",
        mimeType: p.response?.mimeType,
        initiator: p.initiator,
        requestHeaders: p.requestHeaders,
        requestBody: p.requestBody,
        requestBodyTruncated: p.requestBodyTruncated,
        responseHeaders: p.response?.headers || {},
        responseBody,
        responseBodyBase64,
        responseBodyTruncated,
        durationMs: Math.max(0, Date.now() - p.startWallMs),
        phase: "finished",
      };
      emit("http", ev, state.tab);
    });

    client.on("Network.loadingFailed", (params: any) => {
      const p = state.pending.get(params.requestId);
      if (!p) return;
      state.pending.delete(params.requestId);
      const ev: HttpEvent = {
        requestId: p.requestId,
        method: p.method,
        url: p.url,
        resourceType: p.resourceType,
        status: p.response?.status || 0,
        statusText: p.response?.statusText || "",
        mimeType: p.response?.mimeType,
        initiator: p.initiator,
        requestHeaders: p.requestHeaders,
        requestBody: p.requestBody,
        requestBodyTruncated: p.requestBodyTruncated,
        responseHeaders: p.response?.headers || {},
        responseBody: null,
        durationMs: Math.max(0, Date.now() - p.startWallMs),
        failed: true,
        errorText: params.errorText,
        canceled: params.canceled,
        phase: "failed",
      };
      emit("http", ev, state.tab);
    });

    // WebSocket / SignalR
    client.on("Network.webSocketCreated", (params: any) => {
      state.wsUrls.set(params.requestId, params.url);
    });
    client.on("Network.webSocketFrameSent", (params: any) => {
      emitWs("send", params, state, maxBody, emit);
    });
    client.on("Network.webSocketFrameReceived", (params: any) => {
      emitWs("recv", params, state, maxBody, emit);
    });

    // UI events via Runtime binding
    client.on("Runtime.bindingCalled", (params: any) => {
      if (params.name !== "__loggerEvent") return;
      try {
        const ui = JSON.parse(params.payload) as UiEvent;
        emit("ui", ui, state.tab);
      } catch {
        /* drop malformed */
      }
    });

    console.log(`[cdp] attached ${targetId} ${state.tab.url}`);
  }

  function emitWs(
    direction: "send" | "recv",
    params: any,
    state: TargetState,
    maxBody: number,
    emit: (k: "http" | "ws" | "ui", d: any, t: TabRef) => void
  ) {
    const url = state.wsUrls.get(params.requestId) || "";
    const frame = params.response || params;
    let payload = String(frame.payloadData ?? "");
    let base64 = false;
    let truncated = false;
    // opcode: 1 text, 2 binary. chrome-remote-interface gives payloadData as text
    // for text frames; binary frames arrive base64 in payloadData with opcode 2.
    if (frame.opcode === 2) {
      base64 = true;
      if (maxBody > 0 && payload.length > maxBody) {
        payload = payload.slice(0, maxBody);
        truncated = true;
      }
    } else {
      if (maxBody > 0 && payload.length > maxBody) {
        payload = payload.slice(0, maxBody);
        truncated = true;
      }
    }
    const ev: WsEvent = {
      requestId: params.requestId,
      url,
      direction,
      opcode: frame.opcode ?? 1,
      payload,
      base64,
      payloadTruncated: truncated,
    };
    emit("ws", ev, state.tab);
  }

  // Attach to existing pages (use /json/list so we have ws urls).
  try {
    const pages = await listPageTargets();
    for (const p of pages)
      await attach({ targetId: p.id, type: "page", url: p.url, title: p.title });
  } catch (err) {
    console.error("[cdp] listPageTargets failed:", err);
  }

  // Watch for new tabs + closed tabs.
  browser.on("Target.targetCreated", (params: any) => {
    attach(params.targetInfo).catch((e) => console.error("[cdp] attach err:", e));
  });
  browser.on("Target.targetDestroyed", (params: any) => {
    const id = params.targetId as string;
    const st = targets.get(id);
    if (st) {
      st.client.close().catch(() => {});
      targets.delete(id);
      console.log(`[cdp] detached ${id}`);
    }
  });

  return {
    async close() {
      for (const st of targets.values()) {
        try {
          await st.client.close();
        } catch {
          /* ignore */
        }
      }
      targets.clear();
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// Reference the envelope type so the import is used by tooling.
export type { EventEnvelope };

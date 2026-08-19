// Shared event types. One envelope per line in the session JSONL.

export type EventKind = "http" | "ws" | "ui";

export interface TabRef {
  targetId: string;
  url: string;
  title?: string;
}

export interface EventEnvelope {
  /** Monotonic per-session sequence number. */
  seq: number;
  /** Unix epoch milliseconds. */
  t: number;
  /** Session id (matches the JSONL filename). */
  sessionId: string;
  kind: EventKind;
  tab: TabRef;
  data: HttpEvent | WsEvent | UiEvent;
}

export interface HttpEvent {
  requestId: string;
  method: string;
  url: string;
  /** Parsed into origin + templatedPath by the reader; raw url kept here. */
  resourceType: string;
  status: number;
  statusText: string;
  mimeType?: string;
  initiator?: unknown;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  /** True if requestBody was truncated to MAX_BODY_BYTES. */
  requestBodyTruncated?: boolean;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  /** True if responseBody is base64-encoded (binary). */
  responseBodyBase64?: boolean;
  responseBodyTruncated?: boolean;
  /** Milliseconds from requestWillBeSent to loadingFinished. */
  durationMs?: number;
  failed?: boolean;
  errorText?: string;
  canceled?: boolean;
  /** Updated as the request progresses through the CDP lifecycle. */
  phase: "request" | "response" | "finished" | "failed";
}

export interface WsEvent {
  requestId: string;
  url: string;
  /** "send" = client→server (webSocketFrameSent), "recv" = server→client. */
  direction: "send" | "recv";
  opcode: number;
  /** Text payload, or base64 if binary. */
  payload: string;
  base64?: boolean;
  payloadTruncated?: boolean;
}

export interface UiEvent {
  type:
    | "click"
    | "change"
    | "input"
    | "submit"
    | "popstate"
    | "hashchange"
    | "keydown"
    | "scroll"
    | "install";
  target?: {
    tag?: string;
    id?: string | null;
    css?: string;
    text?: string;
    cls?: string | null;
  };
  value?: string | null;
  meta?: Record<string, unknown>;
}

export interface SessionManifestEntry {
  sessionId: string;
  label?: string;
  path: string;
  startedAt: number;
  endedAt?: number;
  counts: { http: number; ws: number; ui: number };
  hosts: Record<string, number>;
}

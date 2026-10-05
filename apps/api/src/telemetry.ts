import { createHmac, timingSafeEqual } from "node:crypto";

// Observability for managed MCP servers. Each server exports its tool calls
// as OpenTelemetry spans (OTLP/HTTP JSON) to <API_PUBLIC_URL>/api/otel,
// authenticated with a token derived for its hosting project. Nothing here is
// altship-specific on the server's side: it's the standard OTEL_* env vars.

/** One tool call, as read from a span. */
export interface ToolCallSpan {
  startedAt: string;
  tool: string;
  ok: boolean;
  errorType: string | null;
  httpStatus: number | null;
  durationMs: number;
  callerKind: string;
  callerId: string | null;
  traceId: string | null;
  spanId: string | null;
}

const MAX_SPANS_PER_EXPORT = 200;
const CALLER_KINDS = new Set(["key", "user", "end-user", "anonymous", "local"]);
const ERROR_TYPES = new Set(["unknown_tool", "invalid_input", "upstream_error", "request_failed"]);

function signature(projectId: string, secret: string): string {
  return createHmac("sha256", secret).update(`telemetry:${projectId}`).digest("base64url");
}

/** The token a server sends with its exports: "<project id>.<signature>". Derived, so it's never stored. */
function telemetryToken(projectId: string, secret: string): string {
  return `${projectId}.${signature(projectId, secret)}`;
}

/** The hosting project a telemetry token belongs to, or null if it isn't one of ours. */
export function projectIdFromToken(token: string): string | null {
  const secret = process.env.MCP_INTERNAL_KEY_SECRET;
  const at = token.lastIndexOf(".");
  if (!secret || at <= 0) return null;
  const projectId = token.slice(0, at);
  const given = Buffer.from(token.slice(at + 1));
  const expected = Buffer.from(signature(projectId, secret));
  return given.length === expected.length && timingSafeEqual(given, expected) ? projectId : null;
}

/**
 * The env vars that point a server's telemetry at altship. Empty when
 * API_PUBLIC_URL (or MCP_INTERNAL_KEY_SECRET) isn't set or is this machine: the server then only
 * writes its audit log locally, and the dashboard has no calls to show.
 */
export function telemetryEnv(projectId: string): Record<string, string> {
  const base = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
  const secret = process.env.MCP_INTERNAL_KEY_SECRET;
  // A hosted server can't reach an API on this machine (local development).
  if (!base || !secret || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) return {};
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/api/otel`,
    // Header values are URL-encoded in this variable (the OpenTelemetry convention).
    OTEL_EXPORTER_OTLP_HEADERS: `authorization=${encodeURIComponent(`Bearer ${telemetryToken(projectId, secret)}`)}`,
  };
}

type AnyValue = { stringValue?: unknown; intValue?: unknown; boolValue?: unknown };

function attributes(list: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    const key = (item as { key?: unknown })?.key;
    const value = (item as { value?: AnyValue })?.value;
    const raw = value?.stringValue ?? value?.intValue ?? value?.boolValue;
    if (typeof key === "string" && raw !== undefined && raw !== null) map.set(key, String(raw).slice(0, 300));
  }
  return map;
}

/** Nanoseconds since the epoch (a string or number in OTLP JSON) as milliseconds, or null. */
function nanosToMs(value: unknown): number | null {
  try {
    const ms = Number(BigInt(String(value)) / 1_000_000n);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/** The tool calls in an OTLP/HTTP JSON trace export. Spans that aren't tool calls, or are malformed, are skipped. */
export function parseToolCallSpans(body: unknown): ToolCallSpan[] {
  const calls: ToolCallSpan[] = [];
  const resourceSpans = (body as { resourceSpans?: unknown })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return calls;

  for (const resource of resourceSpans) {
    for (const scope of Array.isArray(resource?.scopeSpans) ? resource.scopeSpans : []) {
      for (const span of Array.isArray(scope?.spans) ? scope.spans : []) {
        if (calls.length >= MAX_SPANS_PER_EXPORT) return calls;
        const attrs = attributes(span?.attributes);
        const tool = attrs.get("gen_ai.tool.name");
        const start = nanosToMs(span?.startTimeUnixNano);
        const end = nanosToMs(span?.endTimeUnixNano);
        if (attrs.get("mcp.method.name") !== "tools/call" || !tool || start === null || end === null) continue;

        const callerKind = attrs.get("mcp.caller.kind") ?? "";
        const errorType = attrs.get("error.type") ?? "";
        const httpStatus = Number(attrs.get("http.response.status_code"));
        const hex = (value: unknown, length: number) => (typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value) ? value : null);
        calls.push({
          startedAt: new Date(start).toISOString(),
          tool: tool.slice(0, 200),
          ok: span?.status?.code !== 2,
          errorType: ERROR_TYPES.has(errorType) ? errorType : null,
          httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
          durationMs: Math.min(Math.max(end - start, 0), 86_400_000),
          callerKind: CALLER_KINDS.has(callerKind) ? callerKind : "anonymous",
          callerId: attrs.get("enduser.id")?.slice(0, 100) ?? null,
          traceId: hex(span?.traceId, 32),
          spanId: hex(span?.spanId, 16),
        });
      }
    }
  }
  return calls;
}

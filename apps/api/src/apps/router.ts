import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { requireAuth, userIdOf } from "../auth.js";
import { dashboardUrl } from "../email.js";
import {
  AppsConfigError,
  appsEnabled,
  connectLink,
  disconnectApp,
  getAppSession,
  isRelayToken,
  listApps,
  sessionMcp,
  toolkitSlug,
} from "./composio.js";

// Connected apps (see composio.ts): the relay agents call to reach a user's
// apps, and the dashboard routes for listing, connecting and disconnecting.

export const appsRouter = Router();

/** Request headers an MCP client sends that the relay passes on. Never Authorization: that's altship's token. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"];
const RELAY_TIMEOUT_MS = 280_000;

// The relay: MCP over HTTP for one app session. Public, authenticated by the
// session's derived token. It forwards only to the address Composio gave for
// that session, and never logs what passes through.
appsRouter.all("/mcp/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const token = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token || !isRelayToken(sessionId, token) || !(await getAppSession(sessionId))) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown app session or token." }, id: null });
  }

  try {
    const mcp = await sessionMcp(sessionId);
    const target = new URL(mcp.url);
    if (target.protocol !== "https:" || !(target.hostname === "composio.dev" || target.hostname.endsWith(".composio.dev"))) {
      throw new Error("The app provider returned an unexpected address.");
    }

    const headers: Record<string, string> = { ...mcp.headers };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.header(name);
      if (value) headers[name] = value;
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });

    res.status(upstream.status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!upstream.body) return res.end();
    // Streamed through as it arrives: a tool's answer may come as server-sent events.
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } catch (err) {
    console.error("App relay failed:", err instanceof Error ? err.name : "unknown error");
    if (!res.headersSent) {
      res.status(502).json({ jsonrpc: "2.0", error: { code: -32603, message: "Couldn't reach the connected apps." }, id: null });
    }
  }
});

appsRouter.use(requireAuth);

// A page of the apps a user can connect, and whether they have (`search`
// narrows, `connected=true` lists only theirs, `cursor` continues). `enabled`
// is false when altship has no app provider configured, so the dashboard can
// hide the feature.
appsRouter.get("/", async (req, res) => {
  if (!appsEnabled()) return res.json({ enabled: false, apps: [], nextCursor: null });
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 80) : "";
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor.slice(0, 500) : "";
  const page = await listApps(userIdOf(req), { search: search || undefined, connectedOnly: req.query.connected === "true", cursor: cursor || undefined });
  res.json({ enabled: true, ...page });
});

// Starts signing in to an app: returns the page to send the user to.
appsRouter.post("/:toolkit/connect", async (req, res) => {
  const toolkit = toolkitSlug(req.params.toolkit);
  if (!toolkit) return res.status(400).json({ error: "Unknown app." });
  res.json({ url: await connectLink(userIdOf(req), toolkit, `${dashboardUrl()}/apps/connected`) });
});

appsRouter.delete("/:toolkit", async (req, res) => {
  const toolkit = toolkitSlug(req.params.toolkit);
  if (!toolkit) return res.status(400).json({ error: "Unknown app." });
  if (!(await disconnectApp(userIdOf(req), toolkit))) return res.status(404).json({ error: "That app isn't connected." });
  res.json({ ok: true });
});

/** Maps known failures to useful HTTP errors; mounted after the router in server.ts. */
export function appsErrorHandler(err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) {
  if (res.headersSent) return next(err);
  if (err instanceof AppsConfigError) return res.status(503).json({ error: err.message });
  console.error("Apps API error:", err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
  res.status(502).json({ error: "The connected-apps service returned an error. Try again in a moment." });
}

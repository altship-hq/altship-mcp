import { createHmac, timingSafeEqual } from "node:crypto";
import { Composio, SessionPreset } from "@composio/core";
import { getSupabase } from "../supabase.js";

// Connected apps: third-party tools (Gmail, Slack, ...) that agents can use
// on a user's behalf, provided by Composio. altship has one Composio account;
// each altship user is a Composio user id inside it and signs in to their own
// apps. Everything Composio-specific lives in this file, so the provider can
// be swapped without touching agents.
//
//   COMPOSIO_API_KEY  altship's Composio API key. Unset: the feature is off.

export class AppsConfigError extends Error {}

/** A third-party app a user can connect. */
export interface AppInfo {
  /** Composio's toolkit slug, e.g. "gmail". */
  slug: string;
  name: string;
  logo: string | null;
  /** The user has signed in to it (or it needs no sign-in). */
  connected: boolean;
}

export function appsEnabled(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

let client: Composio | undefined;

function composio(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new AppsConfigError("Connected apps aren't set up: COMPOSIO_API_KEY is missing in apps/api/.env.");
  client ??= new Composio({ apiKey });
  return client;
}

const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A toolkit slug as Composio expects it, or null if it isn't one. */
export function toolkitSlug(value: unknown): string | null {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TOOLKIT_SLUG.test(slug) ? slug : null;
}

// ---- Sessions ------------------------------------------------------------
// A Composio session scopes tools and connections to one user. Each user has
// one "browse" session (every app, for listing and signing in) and one
// session per set of apps their agents use. Only ids are stored; a session's
// MCP address and credential are fetched from Composio when needed.

interface SessionRow {
  id: string;
  user_id: string;
  toolkits: string[];
}

async function findSession(userId: string, key: string): Promise<string | null> {
  const { data, error } = await getSupabase().from("app_sessions").select("id").eq("user_id", userId).eq("toolkits_key", key).maybeSingle();
  if (error) throw new Error(`Failed to load app session: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

async function saveSession(id: string, userId: string, toolkits: string[], key: string): Promise<void> {
  const { error } = await getSupabase().from("app_sessions").insert({ id, user_id: userId, toolkits, toolkits_key: key });
  // Two requests can create the same session at once; either row will do.
  if (error && error.code !== "23505") throw new Error(`Failed to save app session: ${error.message}`);
}

/** The session row with that id, if it's one altship created. */
export async function getAppSession(id: string): Promise<{ id: string; userId: string; toolkits: string[] } | null> {
  const { data, error } = await getSupabase().from("app_sessions").select("id,user_id,toolkits").eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to load app session: ${error.message}`);
  const row = data as SessionRow | null;
  return row ? { id: row.id, userId: row.user_id, toolkits: row.toolkits } : null;
}

const BROWSE = "*";

/** The user's session for listing apps and signing in to them. */
async function browseSession(userId: string) {
  const existing = await findSession(userId, BROWSE);
  if (existing) return composio().sessions.use(existing);
  const session = await composio().sessions.create(userId, { manageConnections: false });
  await saveSession(session.sessionId, userId, [], BROWSE);
  return session;
}

/**
 * The session an agent uses for a set of apps: only those apps, their tools
 * listed individually (so each can have its own permission), and no in-chat
 * sign-in, since users connect apps in the dashboard. Returns its id.
 */
export async function ensureAgentSession(userId: string, toolkits: string[]): Promise<string> {
  const sorted = [...new Set(toolkits)].sort();
  const key = sorted.join(",");
  const existing = await findSession(userId, key);
  if (existing) return existing;
  const session = await composio().sessions.create(userId, {
    toolkits: sorted,
    manageConnections: false,
    sessionPreset: SessionPreset.DIRECT_TOOLS,
  });
  await saveSession(session.sessionId, userId, sorted, key);
  return session.sessionId;
}

/** Where a session's tools are served (MCP over HTTP) and the headers Composio needs. Not to be stored or logged. */
export async function sessionMcp(sessionId: string): Promise<{ url: string; headers: Record<string, string> }> {
  const session = await composio().sessions.use(sessionId, { mcp: true });
  return { url: session.mcp.url, headers: session.mcp.headers ?? {} };
}

// ---- Apps ----------------------------------------------------------------

/** Apps the user can connect, with whether they have. `search` narrows by name. */
export async function listApps(userId: string, options: { search?: string; connectedOnly?: boolean } = {}): Promise<AppInfo[]> {
  const session = await browseSession(userId);
  const page = await session.toolkits({
    limit: 50,
    ...(options.search ? { search: options.search } : {}),
    ...(options.connectedOnly ? { isConnected: true } : {}),
  });
  // Composio's own helper toolkits ("composio", "composio_search") aren't apps a user would recognise.
  return page.items
    .filter((item) => !item.slug.startsWith("composio"))
    .map((item) => ({
      slug: item.slug,
      name: item.name,
      logo: item.logo ?? null,
      connected: item.isNoAuth || item.connection?.isActive === true,
    }));
}

/** The page where the user signs in to an app. They're sent to `callbackUrl` afterwards. */
export async function connectLink(userId: string, toolkit: string, callbackUrl: string): Promise<string> {
  const session = await browseSession(userId);
  const request = await session.authorize(toolkit, { callbackUrl });
  if (!request.redirectUrl) throw new Error(`${toolkit} didn't return a sign-in page.`);
  return request.redirectUrl;
}

/** Removes the user's connection to an app, revoking altship's access to it. False if they weren't connected. */
export async function disconnectApp(userId: string, toolkit: string): Promise<boolean> {
  const session = await browseSession(userId);
  // Looked up through the user's own session, so it can only be their account.
  const page = await session.toolkits({ toolkits: [toolkit] });
  const accountId = page.items.find((item) => item.slug === toolkit)?.connection?.connectedAccount?.id;
  if (!accountId) return false;
  await composio().connectedAccounts.delete(accountId);
  return true;
}

// ---- Relay ---------------------------------------------------------------
// Agents run on Anthropic's side and can only present a bearer token to an
// MCP server, while Composio expects its own key headers. So agents call
// altship's relay (apps/router.ts) with a token derived for the session, and
// the relay forwards to Composio. The Composio key never leaves altship.

function relaySignature(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`apps:${sessionId}`).digest("base64url");
}

/** The bearer token an agent presents to the relay for a session. Derived, so it's never stored. */
export function relayToken(sessionId: string): string {
  const secret = process.env.MCP_INTERNAL_KEY_SECRET;
  if (!secret) throw new AppsConfigError("Missing MCP_INTERNAL_KEY_SECRET in apps/api/.env.");
  return relaySignature(sessionId, secret);
}

export function isRelayToken(sessionId: string, token: string): boolean {
  const secret = process.env.MCP_INTERNAL_KEY_SECRET;
  if (!secret) return false;
  const given = Buffer.from(token);
  const expected = Buffer.from(relaySignature(sessionId, secret));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The relay's address for a session, as agents are given it. Null when the API has no public address. */
export function relayUrl(sessionId: string): string | null {
  const base = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
  return base ? `${base}/api/apps/mcp/${sessionId}` : null;
}

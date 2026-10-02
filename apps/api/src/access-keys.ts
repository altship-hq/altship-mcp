import { createHash, createHmac, randomBytes } from "node:crypto";

// Access keys for deployed MCP servers. A server only ever sees SHA-256
// hashes (in its MCP_ACCESS_KEY_SHA256 env var); we store the same hash plus
// a short prefix for display, and show the full key to the user once.

const KEY_PREFIX = "altship_sk_";

export class AccessKeyConfigError extends Error {}

export function generateAccessKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function hashAccessKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** What the dashboard shows for a key after creation, e.g. "altship_sk_Ab3x…". */
export function displayPrefix(key: string): string {
  return `${key.slice(0, KEY_PREFIX.length + 4)}…`;
}

/**
 * The key altship's own services (Agent Creator) use to call a deployed
 * server, keyed by its hosting project (known before the first deploy).
 * Derived from MCP_INTERNAL_KEY_SECRET rather than stored, so it never sits
 * in the database; its hash is added to every deployment's accepted keys.
 */
export function internalAccessKey(projectId: string): string {
  const secret = process.env.MCP_INTERNAL_KEY_SECRET;
  if (!secret) {
    throw new AccessKeyConfigError("Missing MCP_INTERNAL_KEY_SECRET in apps/api/.env (any long random string).");
  }
  return `${KEY_PREFIX}int_${createHmac("sha256", secret).update(`project:${projectId}`).digest("base64url")}`;
}

/** OAuth issuer for MCP sign-in: the project's Supabase Auth (OAuth 2.1 server). */
export function oauthIssuer(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new AccessKeyConfigError("Missing SUPABASE_URL in apps/api/.env.");
  return `${url.replace(/\/$/, "")}/auth/v1`;
}

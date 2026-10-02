import { hashAccessKey, internalAccessKey, oauthIssuer } from "./access-keys.js";
import { setProjectEnvVar } from "./vercel-client.js";
import { endUserIssuer, serverAudience, upstreamKey } from "./end-users/crypto.js";

// Who a deployed MCP server is for, and the env vars that enforce it. Every
// server, whatever its audience, runs the same generated access check
// (lib/access.ts); only what these env vars point it at differs.

export type Audience = "private" | "customers";

/** Audiences that can be chosen today. */
export const AVAILABLE_AUDIENCES: Audience[] = ["private", "customers"];

export class AudienceError extends Error {}

/** Parses a requested audience; missing means "private". */
export function parseAudience(value: unknown): Audience {
  if (value === undefined || value === null || value === "") return "private";
  if (value !== "private" && value !== "customers") {
    throw new AudienceError('audience must be "private" or "customers".');
  }
  if (!AVAILABLE_AUDIENCES.includes(value)) {
    throw new AudienceError("MCP servers for your customers are coming soon. Deploy as private for now.");
  }
  return value;
}

export interface AccessConfig {
  audience: Audience;
  /** Hosting project, which altship's own (Agent Creator) key is derived from. */
  projectId: string;
  /** The altship user who owns the server. */
  ownerId: string;
  /** SHA-256 hashes of the server's active access keys. */
  keyHashes: string[];
}

/**
 * The env vars that decide who may call the server.
 *
 * - private:   the owner's access keys and altship's own key, plus the owner
 *              signing in with their altship account (OAuth).
 * - customers: anyone who signs in through the end-user sign-in server
 *              (src/end-users) with their own credential for the API. Their
 *              tokens are issued for this server's audience and carry that
 *              credential, sealed with this server's upstream key. No
 *              access keys: every call must be made as some end user.
 */
export function accessEnv(config: AccessConfig): Record<string, string> {
  switch (config.audience) {
    case "private":
      return {
        MCP_ACCESS_KEY_SHA256: [...config.keyHashes, hashAccessKey(internalAccessKey(config.projectId))].join(","),
        MCP_OAUTH_ISSUER: oauthIssuer(),
        MCP_OAUTH_ALLOWED_SUBJECTS: config.ownerId,
      };
    case "customers":
      return {
        MCP_OAUTH_ISSUER: endUserIssuer(),
        MCP_OAUTH_AUDIENCE: serverAudience(config.projectId),
        MCP_OAUTH_UPSTREAM_KEY: upstreamKey(config.projectId),
      };
  }
}

/** Writes the access env vars to the server's hosting project (takes effect on its next deploy). */
export async function applyAccessEnv(config: AccessConfig): Promise<void> {
  for (const [key, value] of Object.entries(accessEnv(config))) {
    await setProjectEnvVar(config.projectId, key, value);
  }
}

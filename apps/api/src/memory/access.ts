import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { internalAccessKey, oauthIssuer } from "../access-keys.js";
import { activeKeyHashes, memberIds, type DeploymentRecord } from "../store.js";

// Who may call a memory store. The same rules as a private server generated
// from an API (its access keys, altship's own key, the owner and the people
// they've added signing in with their altship accounts), but checked against
// the database on every request, so a revoked key or a removed person loses
// access immediately.

/** As recorded with each tool call: an access key's hash prefix, or an altship user id. */
export interface MemoryCaller {
  kind: "key" | "user";
  id: string;
}

export const ACCESS_KEY_HEADER = "x-mcp-access-key";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function keyCaller(store: DeploymentRecord, candidate: string): Promise<MemoryCaller | null> {
  const hash = createHash("sha256").update(candidate).digest("hex");
  const accepted = [...(await activeKeyHashes(store.id))];
  try {
    accepted.push(createHash("sha256").update(internalAccessKey(store.projectId)).digest("hex"));
  } catch {
    // No internal key configured: only the store's own keys are accepted.
  }
  return accepted.some((expected) => sameHash(expected, hash)) ? { kind: "key", id: hash.slice(0, 12) } : null;
}

async function userCaller(store: DeploymentRecord, token: string): Promise<MemoryCaller | null> {
  try {
    const issuer = oauthIssuer();
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, { issuer });
    if (typeof payload.sub !== "string") return null;
    const allowed = payload.sub === store.userId || (await memberIds(store.id)).includes(payload.sub);
    return allowed ? { kind: "user", id: payload.sub } : null;
  } catch {
    return null;
  }
}

/** The caller, if the request carries an accepted access key or sign-in token; otherwise null. */
export async function memoryCaller(store: DeploymentRecord, headers: { authorization?: string; accessKey?: string }): Promise<MemoryCaller | null> {
  if (headers.accessKey) {
    const caller = await keyCaller(store, headers.accessKey);
    if (caller) return caller;
  }
  const token = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  return (await keyCaller(store, token)) ?? (await userCaller(store, token));
}

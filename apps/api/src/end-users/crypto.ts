import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { importJWK, SignJWT, type CryptoKey, type JWK } from "jose";
import { AccessKeyConfigError } from "../access-keys.js";

// Keys for the end-user sign-in server ("for your customers" MCP servers).
//
// - Access tokens are ES256 JWTs signed with END_USER_OAUTH_PRIVATE_JWK; MCP
//   servers verify them against the public half at <issuer>/.well-known/jwks.json.
// - Each end user's own upstream credential is sealed (AES-256-GCM) with a key
//   unique to the MCP server they connected to, derived from
//   MCP_INTERNAL_KEY_SECRET. The same sealed value is stored here and carried
//   in their access token; only that server (given its key as
//   MCP_OAUTH_UPSTREAM_KEY) can open it.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new AccessKeyConfigError(`Missing ${name} in apps/api/.env.`);
  return value;
}

/** The end-user OAuth issuer: <API_PUBLIC_URL>/oauth. */
export function endUserIssuer(): string {
  return `${requireEnv("API_PUBLIC_URL").replace(/\/$/, "")}/oauth`;
}

/** Token audience for one MCP server: tied to its hosting project, which is known before it's deployed. */
export function serverAudience(projectId: string): string {
  return `altship:project:${projectId}`;
}

/** The server's key for opening sealed credentials (base64url, 32 bytes). */
export function upstreamKey(projectId: string): string {
  return createHmac("sha256", requireEnv("MCP_INTERNAL_KEY_SECRET")).update(`upstream:${projectId}`).digest("base64url");
}

/** AES-256-GCM, encoded as base64url(iv[12] | ciphertext | tag[16]) -- the format generated servers open. */
export function sealCredential(projectId: string, credential: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(upstreamKey(projectId), "base64url"), iv);
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

/** Opens a sealed credential (used in tests and diagnostics; servers do this themselves). */
export function openCredential(projectId: string, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(upstreamKey(projectId), "base64url"), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
}

let signingKey: { key: CryptoKey | Uint8Array; kid: string; publicJwk: JWK } | undefined;

async function getSigningKey() {
  if (!signingKey) {
    const jwk = JSON.parse(requireEnv("END_USER_OAUTH_PRIVATE_JWK")) as JWK;
    const { d: _private, ...publicJwk } = jwk;
    signingKey = { key: await importJWK(jwk, "ES256"), kid: jwk.kid ?? "end-user", publicJwk: { ...publicJwk, alg: "ES256", use: "sig" } };
  }
  return signingKey;
}

/** The public signing keys, for the JWKS endpoint. */
export async function publicJwks(): Promise<{ keys: JWK[] }> {
  return { keys: [(await getSigningKey()).publicJwk] };
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export async function signAccessToken(claims: {
  sub: string;
  audience: string;
  clientId: string;
  sealedCredential: string;
}): Promise<string> {
  const { key, kid } = await getSigningKey();
  return new SignJWT({ client_id: claims.clientId, upc: claims.sealedCredential })
    .setProtectedHeader({ alg: "ES256", kid, typ: "at+jwt" })
    .setIssuer(endUserIssuer())
    .setAudience(claims.audience)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(randomBytes(12).toString("base64url"))
    .sign(key);
}

/** Random opaque token (authorization codes, refresh tokens, ids). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

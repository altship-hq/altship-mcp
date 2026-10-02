import { createHash } from "node:crypto";
import { getSupabase } from "../supabase.js";

// Storage for the end-user sign-in server. Codes and refresh tokens are kept
// only as SHA-256 hashes; credentials only sealed (see crypto.ts).

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function fail(what: string, error: { message: string }): never {
  throw new Error(`Failed to ${what}: ${error.message}`);
}

// ---- Clients --------------------------------------------------------------

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  clientUri: string | null;
  redirectUris: string[];
}

export async function insertClient(client: OAuthClient): Promise<void> {
  const { error } = await getSupabase().from("oauth_clients").insert({
    client_id: client.clientId,
    client_name: client.clientName,
    client_uri: client.clientUri,
    redirect_uris: client.redirectUris,
  });
  if (error) fail("register client", error);
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const { data, error } = await getSupabase().from("oauth_clients").select("*").eq("client_id", clientId).maybeSingle();
  if (error) fail("load client", error);
  if (!data) return null;
  return { clientId: data.client_id, clientName: data.client_name, clientUri: data.client_uri, redirectUris: data.redirect_uris };
}

// ---- Authorization requests ---------------------------------------------

export interface AuthorizationRequest {
  id: string;
  expiresAt: string;
  clientId: string;
  deploymentId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
  connectionId: string | null;
  usedAt: string | null;
}

function fromRequestRow(row: Record<string, any>): AuthorizationRequest {
  return {
    id: row.id,
    expiresAt: row.expires_at,
    clientId: row.client_id,
    deploymentId: row.deployment_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    state: row.state,
    scope: row.scope,
    connectionId: row.connection_id,
    usedAt: row.used_at,
  };
}

export async function insertRequest(request: Omit<AuthorizationRequest, "connectionId" | "usedAt">): Promise<void> {
  const { error } = await getSupabase().from("oauth_requests").insert({
    id: request.id,
    expires_at: request.expiresAt,
    client_id: request.clientId,
    deployment_id: request.deploymentId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    state: request.state,
    scope: request.scope,
  });
  if (error) fail("save authorization request", error);
}

export async function getRequest(id: string): Promise<AuthorizationRequest | null> {
  const { data, error } = await getSupabase().from("oauth_requests").select("*").eq("id", id).maybeSingle();
  if (error) fail("load authorization request", error);
  return data ? fromRequestRow(data) : null;
}

/** Marks a request approved: links the connection and stores the code's hash. Only succeeds once. */
export async function approveRequest(id: string, connectionId: string, codeHash: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("oauth_requests")
    .update({ connection_id: connectionId, code_hash: codeHash })
    .eq("id", id)
    .is("code_hash", null)
    .select("id");
  if (error) fail("approve authorization request", error);
  return (data ?? []).length > 0;
}

/** Atomically uses a code: returns its request the first time, null after (or if unknown). */
export async function consumeCode(codeHash: string): Promise<AuthorizationRequest | null> {
  const { data, error } = await getSupabase()
    .from("oauth_requests")
    .update({ used_at: new Date().toISOString() })
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .select("*");
  if (error) fail("use authorization code", error);
  return data && data.length > 0 ? fromRequestRow(data[0]) : null;
}

// ---- Connections ----------------------------------------------------------

export interface ConnectionRecord {
  id: string;
  deploymentId: string;
  clientId: string;
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  credentialHint: string;
}

export async function insertConnection(connection: {
  id: string;
  deploymentId: string;
  clientId: string;
  credentialHint: string;
  credentialSealed: string;
}): Promise<void> {
  const { error } = await getSupabase().from("end_user_connections").insert({
    id: connection.id,
    deployment_id: connection.deploymentId,
    client_id: connection.clientId,
    credential_hint: connection.credentialHint,
    credential_sealed: connection.credentialSealed,
  });
  if (error) fail("save connection", error);
}

/** An active (not revoked) connection with its sealed credential, for issuing tokens. */
export async function getActiveConnection(id: string): Promise<{ id: string; deploymentId: string; credentialSealed: string } | null> {
  const { data, error } = await getSupabase()
    .from("end_user_connections")
    .select("id, deployment_id, credential_sealed")
    .eq("id", id)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) fail("load connection", error);
  return data ? { id: data.id, deploymentId: data.deployment_id, credentialSealed: data.credential_sealed } : null;
}

export async function touchConnection(id: string): Promise<void> {
  const { error } = await getSupabase().from("end_user_connections").update({ last_used_at: new Date().toISOString() }).eq("id", id);
  if (error) fail("update connection", error);
}

export async function listConnections(deploymentId: string): Promise<ConnectionRecord[]> {
  const { data, error } = await getSupabase()
    .from("end_user_connections")
    .select("id, deployment_id, client_id, created_at, last_used_at, credential_hint, oauth_clients(client_name)")
    .eq("deployment_id", deploymentId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) fail("list connections", error);
  return (data ?? []).map((row: Record<string, any>) => ({
    id: row.id,
    deploymentId: row.deployment_id,
    clientId: row.client_id,
    clientName: row.oauth_clients?.client_name ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    credentialHint: row.credential_hint,
  }));
}

/** Revokes a connection and its refresh tokens. Access tokens already issued expire within the hour. */
export async function revokeConnection(id: string, deploymentId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("end_user_connections")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("deployment_id", deploymentId)
    .is("revoked_at", null)
    .select("id");
  if (error) fail("revoke connection", error);
  if ((data ?? []).length === 0) return false;
  const { error: tokenError } = await getSupabase().from("oauth_refresh_tokens").delete().eq("connection_id", id);
  if (tokenError) fail("revoke refresh tokens", tokenError);
  return true;
}

// ---- Refresh tokens ---------------------------------------------------------

export const REFRESH_TOKEN_TTL_DAYS = 30;

export async function insertRefreshToken(token: { hash: string; connectionId: string; clientId: string }): Promise<void> {
  const { error } = await getSupabase()
    .from("oauth_refresh_tokens")
    .insert({
      token_hash: token.hash,
      connection_id: token.connectionId,
      client_id: token.clientId,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
    });
  if (error) fail("save refresh token", error);
}

/** Atomically uses a refresh token (they rotate): returns it the first time, null after. */
export async function consumeRefreshToken(hash: string): Promise<{ connectionId: string; clientId: string; expiresAt: string } | null> {
  const { data, error } = await getSupabase()
    .from("oauth_refresh_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("token_hash", hash)
    .is("used_at", null)
    .select("connection_id, client_id, expires_at");
  if (error) fail("use refresh token", error);
  return data && data.length > 0 ? { connectionId: data[0].connection_id, clientId: data[0].client_id, expiresAt: data[0].expires_at } : null;
}

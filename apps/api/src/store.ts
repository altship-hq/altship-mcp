import { getSupabase } from "./supabase.js";
import type { Audience } from "./server-access.js";

/** A tool as deployed, kept so other products (Agent Creator) can see what a server offers. */
export interface DeployedTool {
  name: string;
  description: string;
  destructive: boolean;
  sensitive: boolean;
  inputSchema: Record<string, unknown>;
}

/** How end users connect to a "for your customers" server (shown on its connect page). */
export interface ConnectSettings {
  /** Product name shown to end users, e.g. "Bukeen". */
  displayName: string;
  /** How their own credential is applied upstream; decides what the connect page asks for. */
  credentialKind: "apiKey-header" | "apiKey-query" | "bearer" | "basic";
  /** Optional: where end users find their credential, e.g. "Bukeen → Settings → API". */
  helpText: string | null;
}

export interface DeploymentRecord {
  id: string;
  userId: string;
  /** Who the server is for: the owner's team ("private") or the owner's own customers. */
  audience: Audience;
  createdAt: string;
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
  /** Null for deployments recorded before tools were stored. */
  tools: DeployedTool[] | null;
  authMode: "static" | "passthrough" | null;
  /** Only for audience "customers". */
  connectSettings: ConnectSettings | null;
}

interface DeploymentRow {
  id: string;
  user_id: string;
  audience: Audience | null;
  created_at: string;
  api_title: string;
  tool_names: string[];
  project_name: string;
  project_id: string;
  url: string;
  tools: DeployedTool[] | null;
  auth_mode: "static" | "passthrough" | null;
  connect_settings: ConnectSettings | null;
}

function fromRow(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    audience: row.audience ?? "private",
    createdAt: row.created_at,
    apiTitle: row.api_title,
    toolNames: row.tool_names,
    projectName: row.project_name,
    projectId: row.project_id,
    url: row.url,
    tools: row.tools ?? null,
    authMode: row.auth_mode ?? null,
    connectSettings: row.connect_settings ?? null,
  };
}

export async function listDeployments(userId: string): Promise<DeploymentRecord[]> {
  const { data, error } = await getSupabase()
    .from("deployments")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to list deployments: ${error.message}`);
  return (data as DeploymentRow[]).map(fromRow);
}

export async function recordDeployment(record: Omit<DeploymentRecord, "createdAt">): Promise<void> {
  const { error } = await getSupabase()
    .from("deployments")
    .insert({
      id: record.id,
      user_id: record.userId,
      audience: record.audience,
      api_title: record.apiTitle,
      tool_names: record.toolNames,
      project_name: record.projectName,
      project_id: record.projectId,
      url: record.url,
      tools: record.tools,
      auth_mode: record.authMode,
      connect_settings: record.connectSettings,
    });

  if (error) throw new Error(`Failed to record deployment: ${error.message}`);
}

export async function getDeployment(id: string, userId: string): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase().from("deployments").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`Failed to load deployment: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

/** The "for your customers" server whose MCP endpoint is `mcpUrl` (served at <deployment url>/api/mcp). */
export async function findCustomerDeploymentByMcpUrl(mcpUrl: string): Promise<DeploymentRecord | null> {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/$/, "") !== "/api/mcp") return null;
  const { data, error } = await getSupabase()
    .from("deployments")
    .select("*")
    .eq("url", url.origin)
    .eq("audience", "customers")
    .maybeSingle();
  if (error) throw new Error(`Failed to look up MCP server: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

/** Any deployment by id, regardless of owner (for the end-user sign-in server). */
export async function getDeploymentById(id: string): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase().from("deployments").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to load deployment: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

/** An access key for a deployment, as shown in the dashboard (never the key itself). */
export interface ServerKeyRecord {
  id: string;
  deploymentId: string;
  createdAt: string;
  name: string;
  prefix: string;
  revokedAt: string | null;
}

interface ServerKeyRow {
  id: string;
  deployment_id: string;
  user_id: string;
  created_at: string;
  name: string;
  prefix: string;
  key_hash: string;
  revoked_at: string | null;
}

function fromKeyRow(row: ServerKeyRow): ServerKeyRecord {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    createdAt: row.created_at,
    name: row.name,
    prefix: row.prefix,
    revokedAt: row.revoked_at,
  };
}

export async function insertServerKey(key: {
  id: string;
  deploymentId: string;
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
}): Promise<ServerKeyRecord> {
  const { data, error } = await getSupabase()
    .from("server_keys")
    .insert({
      id: key.id,
      deployment_id: key.deploymentId,
      user_id: key.userId,
      name: key.name,
      prefix: key.prefix,
      key_hash: key.keyHash,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save access key: ${error.message}`);
  return fromKeyRow(data as ServerKeyRow);
}

export async function listServerKeys(deploymentId: string, userId: string): Promise<ServerKeyRecord[]> {
  const { data, error } = await getSupabase()
    .from("server_keys")
    .select("*")
    .eq("deployment_id", deploymentId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list access keys: ${error.message}`);
  return (data as ServerKeyRow[]).map(fromKeyRow);
}

/** Hashes of a deployment's active keys -- what its MCP_ACCESS_KEY_SHA256 should hold. */
export async function activeKeyHashes(deploymentId: string): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("server_keys")
    .select("key_hash")
    .eq("deployment_id", deploymentId)
    .is("revoked_at", null);
  if (error) throw new Error(`Failed to load access keys: ${error.message}`);
  return (data as { key_hash: string }[]).map((r) => r.key_hash);
}

/** Returns false if no active key with that id belongs to the user's deployment. */
export async function revokeServerKey(keyId: string, deploymentId: string, userId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("server_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("deployment_id", deploymentId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`Failed to revoke access key: ${error.message}`);
  return (data ?? []).length > 0;
}

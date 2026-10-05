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

/** Another altship user the owner has let connect to a private server. */
export interface MemberRecord {
  userId: string;
  email: string;
  createdAt: string;
}

interface MemberRow {
  deployment_id: string;
  user_id: string;
  email: string;
  created_at: string;
}

function fromMemberRow(row: MemberRow): MemberRecord {
  return { userId: row.user_id, email: row.email, createdAt: row.created_at };
}

export async function listMembers(deploymentId: string): Promise<MemberRecord[]> {
  const { data, error } = await getSupabase()
    .from("deployment_members")
    .select("*")
    .eq("deployment_id", deploymentId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list people: ${error.message}`);
  return (data as MemberRow[]).map(fromMemberRow);
}

/** Adding someone who's already there leaves them as they were. */
export async function addMember(member: { deploymentId: string; userId: string; email: string }): Promise<MemberRecord> {
  const { error } = await getSupabase()
    .from("deployment_members")
    .upsert(
      { deployment_id: member.deploymentId, user_id: member.userId, email: member.email },
      { onConflict: "deployment_id,user_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Failed to add person: ${error.message}`);
  const { data, error: readError } = await getSupabase()
    .from("deployment_members")
    .select("*")
    .eq("deployment_id", member.deploymentId)
    .eq("user_id", member.userId)
    .single();
  if (readError) throw new Error(`Failed to add person: ${readError.message}`);
  return fromMemberRow(data as MemberRow);
}

/** Returns false if that user wasn't one of the deployment's people. */
export async function removeMember(deploymentId: string, userId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("deployment_members")
    .delete()
    .eq("deployment_id", deploymentId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) throw new Error(`Failed to remove person: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Ids of a deployment's people -- what its MCP_OAUTH_ALLOWED_SUBJECTS should hold, after the owner. */
export async function memberIds(deploymentId: string): Promise<string[]> {
  const { data, error } = await getSupabase().from("deployment_members").select("user_id").eq("deployment_id", deploymentId);
  if (error) throw new Error(`Failed to load people: ${error.message}`);
  return (data as { user_id: string }[]).map((r) => r.user_id);
}

/** An invite to a private server. `id` is the token in the invite link. */
export interface InviteRecord {
  id: string;
  deploymentId: string;
  email: string;
  createdAt: string;
  /** Null while pending. */
  acceptedBy: string | null;
}

interface InviteRow {
  id: string;
  deployment_id: string;
  email: string;
  created_at: string;
  accepted_by: string | null;
}

function fromInviteRow(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    email: row.email,
    createdAt: row.created_at,
    acceptedBy: row.accepted_by,
  };
}

/** Creates an invite, or returns the one that email already has (`created` false). */
export async function createInvite(invite: { id: string; deploymentId: string; email: string }): Promise<{ invite: InviteRecord; created: boolean }> {
  const { data: inserted, error } = await getSupabase()
    .from("deployment_invites")
    .upsert(
      { id: invite.id, deployment_id: invite.deploymentId, email: invite.email },
      { onConflict: "deployment_id,email", ignoreDuplicates: true },
    )
    .select("*");
  if (error) throw new Error(`Failed to save invite: ${error.message}`);
  if (inserted && inserted.length > 0) return { invite: fromInviteRow(inserted[0] as InviteRow), created: true };

  const { data, error: readError } = await getSupabase()
    .from("deployment_invites")
    .select("*")
    .eq("deployment_id", invite.deploymentId)
    .eq("email", invite.email)
    .single();
  if (readError) throw new Error(`Failed to save invite: ${readError.message}`);
  return { invite: fromInviteRow(data as InviteRow), created: false };
}

/** Invites nobody has accepted yet. */
export async function listPendingInvites(deploymentId: string): Promise<InviteRecord[]> {
  const { data, error } = await getSupabase()
    .from("deployment_invites")
    .select("*")
    .eq("deployment_id", deploymentId)
    .is("accepted_by", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list invites: ${error.message}`);
  return (data as InviteRow[]).map(fromInviteRow);
}

/** Any invite by id, regardless of owner (for the person accepting it). */
export async function getInvite(id: string): Promise<InviteRecord | null> {
  const { data, error } = await getSupabase().from("deployment_invites").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to load invite: ${error.message}`);
  return data ? fromInviteRow(data as InviteRow) : null;
}

/** Returns false if the deployment has no pending invite with that id. */
export async function cancelInvite(id: string, deploymentId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("deployment_invites")
    .delete()
    .eq("id", id)
    .eq("deployment_id", deploymentId)
    .is("accepted_by", null)
    .select("id");
  if (error) throw new Error(`Failed to cancel invite: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function markInviteAccepted(id: string, userId: string): Promise<void> {
  const { error } = await getSupabase().from("deployment_invites").update({ accepted_by: userId }).eq("id", id);
  if (error) throw new Error(`Failed to accept invite: ${error.message}`);
}

/** Drops a removed person's invite, so their old link stops working. */
export async function deleteAcceptedInvites(deploymentId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().from("deployment_invites").delete().eq("deployment_id", deploymentId).eq("accepted_by", userId);
  if (error) throw new Error(`Failed to remove invite: ${error.message}`);
}

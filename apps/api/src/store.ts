import { GENERATOR_VERSION } from "@altship/mcp-gen";
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
  /** What the owner calls the server; the spec's title until they rename it. */
  name: string;
  /** The title from the OpenAPI spec the server was generated from. */
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
  /** The hosting deployment holding the server's current code: `id`, until an in-place upgrade. */
  sourceDeploymentId: string;
  /** Runs older generated code than today's (e.g. without call logging) and can be upgraded in place. */
  needsUpgrade: boolean;
}

interface DeploymentRow {
  id: string;
  user_id: string;
  audience: Audience | null;
  created_at: string;
  name?: string | null;
  api_title: string;
  tool_names: string[];
  project_name: string;
  project_id: string;
  url: string;
  tools: DeployedTool[] | null;
  auth_mode: "static" | "passthrough" | null;
  connect_settings: ConnectSettings | null;
  generator_version?: number | null;
  source_deployment_id?: string | null;
}

function fromRow(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    audience: row.audience ?? "private",
    createdAt: row.created_at,
    name: row.name || row.api_title,
    apiTitle: row.api_title,
    toolNames: row.tool_names,
    projectName: row.project_name,
    projectId: row.project_id,
    url: row.url,
    tools: row.tools ?? null,
    authMode: row.auth_mode ?? null,
    connectSettings: row.connect_settings ?? null,
    sourceDeploymentId: row.source_deployment_id || row.id,
    needsUpgrade: (row.generator_version ?? 0) < GENERATOR_VERSION,
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

/** Records a server deployed just now, which runs the current generation of the generated code. */
export async function recordDeployment(record: Omit<DeploymentRecord, "createdAt" | "sourceDeploymentId" | "needsUpgrade">): Promise<void> {
  const row = {
      id: record.id,
      user_id: record.userId,
      audience: record.audience,
      // Only stored when it differs from the spec's title, which is the default.
      ...(record.name !== record.apiTitle ? { name: record.name } : {}),
      api_title: record.apiTitle,
      tool_names: record.toolNames,
      project_name: record.projectName,
      project_id: record.projectId,
      url: record.url,
      tools: record.tools,
      auth_mode: record.authMode,
      connect_settings: record.connectSettings,
  };
  let { error } = await getSupabase().from("deployments").insert({ ...row, generator_version: GENERATOR_VERSION });
  // That column was added later; a database without it still records the server.
  if (error && /generator_version/.test(error.message)) ({ error } = await getSupabase().from("deployments").insert(row));

  if (error) throw new Error(`Failed to record deployment: ${error.message}`);
}

/** Whether the database has the columns an in-place upgrade records its result in. */
export async function canRecordUpgrades(): Promise<boolean> {
  const { error } = await getSupabase().from("deployments").select("generator_version,source_deployment_id").limit(1);
  return !error;
}

/** Records that the user's deployment now runs the current generation, from `sourceDeploymentId`. */
export async function markUpgraded(id: string, userId: string, sourceDeploymentId: string): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase()
    .from("deployments")
    .update({ generator_version: GENERATOR_VERSION, source_deployment_id: sourceDeploymentId })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to record the upgrade: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

export async function getDeployment(id: string, userId: string): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase().from("deployments").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`Failed to load deployment: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

/** Renames the user's deployment; null goes back to the spec's title. Returns null if it isn't theirs. */
export async function renameDeployment(id: string, userId: string, name: string | null): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase()
    .from("deployments")
    .update({ name })
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to rename MCP server: ${error.message}`);
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

/** The managed server hosted in that project (for telemetry it exports). */
export async function getDeploymentByProjectId(projectId: string): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase().from("deployments").select("*").eq("project_id", projectId).limit(1).maybeSingle();
  if (error) throw new Error(`Failed to load deployment: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

/** A recorded tool call on a managed server. */
export interface ToolCallRecord {
  id: string;
  deploymentId: string;
  startedAt: string;
  tool: string;
  ok: boolean;
  errorType: string | null;
  httpStatus: number | null;
  durationMs: number;
  callerKind: string;
  callerId: string | null;
  /** The OpenTelemetry trace the server exported the call as. */
  traceId: string | null;
}

interface ToolCallRow {
  id: string;
  deployment_id: string;
  started_at: string;
  tool: string;
  ok: boolean;
  error_type: string | null;
  http_status: number | null;
  duration_ms: number;
  caller_kind: string;
  caller_id: string | null;
  trace_id?: string | null;
}

export async function insertToolCalls(
  deploymentId: string,
  calls: Array<Omit<ToolCallRecord, "id" | "deploymentId"> & { spanId: string | null }>,
): Promise<void> {
  if (calls.length === 0) return;
  const { error } = await getSupabase()
    .from("tool_calls")
    .insert(
      calls.map((c) => ({
        deployment_id: deploymentId,
        started_at: c.startedAt,
        tool: c.tool,
        ok: c.ok,
        error_type: c.errorType,
        http_status: c.httpStatus,
        duration_ms: c.durationMs,
        caller_kind: c.callerKind,
        caller_id: c.callerId,
        trace_id: c.traceId,
        span_id: c.spanId,
      })),
    );
  if (error) throw new Error(`Failed to record tool calls: ${error.message}`);
}

/** The most recent calls on those deployments, newest first; `before` pages further back, `since` is the oldest to include. */
export async function listToolCalls(deploymentIds: string[], options: { limit: number; before?: string; since?: string }): Promise<ToolCallRecord[]> {
  if (deploymentIds.length === 0) return [];
  let query = getSupabase()
    .from("tool_calls")
    .select("id,deployment_id,started_at,tool,ok,error_type,http_status,duration_ms,caller_kind,caller_id,trace_id")
    .in("deployment_id", deploymentIds)
    .order("started_at", { ascending: false })
    .limit(options.limit);
  if (options.before) query = query.lt("started_at", options.before);
  if (options.since) query = query.gte("started_at", options.since);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list tool calls: ${error.message}`);
  return (data as ToolCallRow[]).map((row) => ({
    id: row.id,
    deploymentId: row.deployment_id,
    startedAt: row.started_at,
    tool: row.tool,
    ok: row.ok,
    errorType: row.error_type,
    httpStatus: row.http_status,
    durationMs: row.duration_ms,
    callerKind: row.caller_kind,
    callerId: row.caller_id,
    traceId: row.trace_id ?? null,
  }));
}

/** Every key a deployment has had, revoked ones included, to name the callers in its logs. */
export async function listKeyHashes(deploymentIds: string[]): Promise<Array<{ deploymentId: string; name: string; keyHash: string; revoked: boolean }>> {
  if (deploymentIds.length === 0) return [];
  const { data, error } = await getSupabase().from("server_keys").select("deployment_id,name,key_hash,revoked_at").in("deployment_id", deploymentIds);
  if (error) throw new Error(`Failed to load access keys: ${error.message}`);
  return (data as Array<{ deployment_id: string; name: string; key_hash: string; revoked_at: string | null }>).map((r) => ({
    deploymentId: r.deployment_id,
    name: r.name,
    keyHash: r.key_hash,
    revoked: r.revoked_at !== null,
  }));
}

/** The members of several deployments at once, to name the callers in their logs. */
export async function listMembersOf(deploymentIds: string[]): Promise<Array<{ deploymentId: string; userId: string; email: string }>> {
  if (deploymentIds.length === 0) return [];
  const { data, error } = await getSupabase().from("deployment_members").select("deployment_id,user_id,email").in("deployment_id", deploymentIds);
  if (error) throw new Error(`Failed to load people: ${error.message}`);
  return (data as MemberRow[]).map((r) => ({ deploymentId: r.deployment_id, userId: r.user_id, email: r.email }));
}

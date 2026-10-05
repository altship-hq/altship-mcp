import { deleteJson, getJson, patchJson, postJson } from "../../http.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  category: "structural" | "quality";
  code: string;
  message: string;
  path?: string;
}

export interface AuthRequirement {
  kind: string;
  envVar: string;
  paramName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  path: string;
  operationId?: string;
  destructive: boolean;
  sensitive: boolean;
  inputSchema: { type: "object"; properties: Record<string, { type?: string; description?: string }> };
  issues: { code: string; message: string }[];
}

export interface ToolsResponse {
  valid: boolean;
  apiTitle: string | null;
  issues: ValidationIssue[];
  tools: ToolDefinition[];
  auth: AuthRequirement | null;
  /** Whether the spec's auth scheme (http-bearer) supports forwarding each caller's own token instead of one shared credential. */
  passthroughAvailable: boolean;
}

export interface GenerateResponse {
  outDir: string;
  filesWritten: string[];
  warnings: string[];
}

export interface DeploymentRecord {
  id: string;
  createdAt: string;
  /** What the owner calls the server; the spec's title until they rename it. */
  name: string;
  /** The title from the OpenAPI spec. */
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
  authMode: AuthMode | null;
  audience: Audience;
  /** For servers offered to customers: what their connect page shows. */
  connectSettings: { displayName: string; credentialKind: string; helpText: string | null } | null;
  /** Runs older generated code than today's (e.g. without call logging) and can be upgraded in place. */
  needsUpgrade: boolean;
  /** "memory": a notes store altship hosts itself; "api" (or missing): generated from an OpenAPI spec. */
  kind?: "api" | "memory";
  /** A memory store's starter collections. */
  collections?: MemoryCollection[] | null;
}

export interface MemoryCollection {
  name: string;
  description: string;
}

/** A note in a memory store. */
export interface MemoryRecord {
  id: string;
  collection: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Creates a memory store; like a deploy, the response carries its first access key, shown once. */
export function createMemoryStore(name: string, template: string): Promise<DeployResponse> {
  return postJson<DeployResponse>("/api/memory", { name, template });
}

/** A store's collections (with note counts) and its notes; `q` searches, `collection` narrows. */
export function listMemoryRecords(
  storeId: string,
  options: { collection?: string; q?: string } = {},
): Promise<{ collections: Array<MemoryCollection & { notes: number }>; records: MemoryRecord[] }> {
  const params = new URLSearchParams();
  if (options.collection) params.set("collection", options.collection);
  if (options.q) params.set("q", options.q);
  const query = params.toString();
  return getJson(`/api/memory/${storeId}/records${query ? `?${query}` : ""}`);
}

export type NoteInput = { collection: string; title: string; body: string; tags: string[] };

export function saveMemoryRecord(storeId: string, note: NoteInput): Promise<MemoryRecord> {
  return postJson(`/api/memory/${storeId}/records`, note);
}

export function updateMemoryRecord(storeId: string, recordId: string, note: Partial<NoteInput>): Promise<MemoryRecord> {
  return patchJson(`/api/memory/${storeId}/records/${recordId}`, note);
}

/** How a document was turned into notes: along its headings, organised by AI, or by paragraph. */
export interface MemoryImportPlan {
  notes: NoteInput[];
  method: "headings" | "ai" | "paragraphs";
}

/** Works out the notes a document would become, without saving anything. */
export function previewMemoryImport(storeId: string, text: string, collection?: string): Promise<MemoryImportPlan> {
  return postJson(`/api/memory/${storeId}/import/preview`, { text, ...(collection ? { collection } : {}) });
}

/** Saves the notes from a preview. */
export function importMemoryNotes(storeId: string, notes: NoteInput[]): Promise<{ saved: number }> {
  return postJson(`/api/memory/${storeId}/import`, { notes });
}

export function deleteMemoryRecord(storeId: string, recordId: string): Promise<{ ok: true }> {
  return deleteJson(`/api/memory/${storeId}/records/${recordId}`);
}

/** Someone who connected to a server offered to customers. */
export interface EndUserConnection {
  id: string;
  clientName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Never the credential itself: e.g. "…a1b2", or a username. */
  credentialHint: string;
}

export interface DeployResponse extends DeploymentRecord {
  warnings: string[];
  /** The MCP endpoint clients connect to. */
  mcpUrl: string;
  /** A private server's first access key, in full. Only ever returned here; null for servers offered to customers. */
  accessKey: string | null;
}

/** An access key as listed in the dashboard; the key itself is only shown when created. */
export interface AccessKey {
  id: string;
  deploymentId: string;
  createdAt: string;
  name: string;
  prefix: string;
  revokedAt: string | null;
}

/** Where the OpenAPI spec comes from: a public URL, or a file the user picked (read in the browser). */
export type SpecSource = { url: string } | { fileName: string; content: string };

function specBody(source: SpecSource) {
  return "url" in source ? { spec: source.url } : { specContent: source.content };
}

export function importSpec(source: SpecSource): Promise<ToolsResponse> {
  return postJson<ToolsResponse>("/api/tools", specBody(source));
}

export type Platform = "node" | "vercel";
export type AuthMode = "static" | "passthrough";
/** Who a managed server is for: your team ("private") or your own customers (coming soon). */
export type Audience = "private" | "customers";

export function generateServer(
  source: SpecSource,
  toolNames: string[],
  platform: Platform,
  authMode: AuthMode = "static",
): Promise<GenerateResponse> {
  return postJson<GenerateResponse>("/api/generate", { ...specBody(source), toolNames, platform, authMode });
}

export function deployToVercel(
  source: SpecSource,
  toolNames: string[],
  options: { name?: string; authMode?: AuthMode; credentialValue?: string; audience?: Audience; connectHelpText?: string } = {},
): Promise<DeployResponse> {
  return postJson<DeployResponse>("/api/deploy", { ...specBody(source), toolNames, ...options });
}

export function listDeployments(): Promise<DeploymentRecord[]> {
  return getJson<DeploymentRecord[]>("/api/deployments");
}

/** Renames a server; an empty name goes back to the spec's title. */
export function renameDeployment(deploymentId: string, name: string): Promise<DeploymentRecord> {
  return patchJson<DeploymentRecord>(`/api/deployments/${deploymentId}`, { name });
}

/** Brings a server deployed with older code up to date in place (same URL, keys and people). Takes about a minute. */
export function upgradeDeployment(deploymentId: string): Promise<DeploymentRecord> {
  return postJson<DeploymentRecord>(`/api/deployments/${deploymentId}/upgrade`, {});
}

/** Generated managed servers serve MCP at /api/mcp. */
export function mcpUrl(deployment: Pick<DeploymentRecord, "url">): string {
  return `${deployment.url.replace(/\/$/, "")}/api/mcp`;
}

export function listAccessKeys(deploymentId: string): Promise<AccessKey[]> {
  return getJson<AccessKey[]>(`/api/deployments/${deploymentId}/keys`);
}

export function createAccessKey(deploymentId: string, name: string): Promise<AccessKey & { key: string }> {
  return postJson(`/api/deployments/${deploymentId}/keys`, { name });
}

export function listConnections(deploymentId: string): Promise<EndUserConnection[]> {
  return getJson<EndUserConnection[]>(`/api/deployments/${deploymentId}/connections`);
}

export function revokeConnection(deploymentId: string, connectionId: string): Promise<{ ok: true }> {
  return deleteJson(`/api/deployments/${deploymentId}/connections/${connectionId}`);
}

export function revokeAccessKey(deploymentId: string, keyId: string): Promise<{ ok: true }> {
  return deleteJson(`/api/deployments/${deploymentId}/keys/${keyId}`);
}

/** Another altship user who may sign in to a private server. */
export interface Member {
  userId: string;
  email: string;
  createdAt: string;
}

/** An invite nobody has accepted yet. `link` is what the invited person opens. */
export interface Invite {
  id: string;
  email: string;
  createdAt: string;
  link: string;
}

export function listMembers(deploymentId: string): Promise<{ members: Member[]; invites: Invite[] }> {
  return getJson(`/api/deployments/${deploymentId}/members`);
}

/** `emailed` is false when altship couldn't email the invite, so the link has to be sent by hand. */
export function inviteMember(deploymentId: string, email: string): Promise<Invite & { emailed: boolean }> {
  return postJson(`/api/deployments/${deploymentId}/invites`, { email });
}

export function cancelInvite(deploymentId: string, inviteId: string): Promise<{ ok: true }> {
  return deleteJson(`/api/deployments/${deploymentId}/invites/${inviteId}`);
}

export function removeMember(deploymentId: string, userId: string): Promise<{ ok: true }> {
  return deleteJson(`/api/deployments/${deploymentId}/members/${userId}`);
}

/** The server an accepted invite gives access to. */
export interface AcceptedInvite {
  name: string;
  mcpUrl: string;
  toolCount: number;
}

export function acceptInvite(inviteId: string): Promise<AcceptedInvite> {
  return postJson(`/api/invites/${encodeURIComponent(inviteId)}/accept`, {});
}

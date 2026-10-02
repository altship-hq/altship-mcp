import { deleteJson, getJson, postJson } from "../../http.js";

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
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
  authMode: AuthMode | null;
  audience: Audience;
  /** For servers offered to customers: what their connect page shows. */
  connectSettings: { displayName: string; credentialKind: string; helpText: string | null } | null;
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
  options: { authMode?: AuthMode; credentialValue?: string; audience?: Audience; connectHelpText?: string } = {},
): Promise<DeployResponse> {
  return postJson<DeployResponse>("/api/deploy", { ...specBody(source), toolNames, ...options });
}

export function listDeployments(): Promise<DeploymentRecord[]> {
  return getJson<DeploymentRecord[]>("/api/deployments");
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

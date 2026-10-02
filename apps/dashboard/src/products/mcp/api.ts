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
}

export interface DeployResponse extends DeploymentRecord {
  warnings: string[];
  /** The MCP endpoint clients connect to. */
  mcpUrl: string;
  /** The server's first access key, in full. Only ever returned here. */
  accessKey: string;
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

export function importSpec(spec: string): Promise<ToolsResponse> {
  return postJson<ToolsResponse>("/api/tools", { spec });
}

export type Platform = "node" | "vercel";
export type AuthMode = "static" | "passthrough";

export function generateServer(
  spec: string,
  toolNames: string[],
  platform: Platform,
  authMode: AuthMode = "static",
): Promise<GenerateResponse> {
  return postJson<GenerateResponse>("/api/generate", { spec, toolNames, platform, authMode });
}

export function deployToVercel(
  spec: string,
  toolNames: string[],
  authMode: AuthMode = "static",
  credentialValue?: string,
): Promise<DeployResponse> {
  return postJson<DeployResponse>("/api/deploy", { spec, toolNames, authMode, credentialValue });
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

export function revokeAccessKey(deploymentId: string, keyId: string): Promise<{ ok: true }> {
  return deleteJson(`/api/deployments/${deploymentId}/keys/${keyId}`);
}

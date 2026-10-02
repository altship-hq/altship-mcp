import { getJson, postJson } from "../../http.js";

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
}

export interface DeployResponse extends DeploymentRecord {
  warnings: string[];
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

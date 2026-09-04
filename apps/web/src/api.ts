import { supabase } from "./supabase.js";

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

// Empty by default so local dev keeps using Vite's proxy (relative "/api/..."
// paths); production sets this since apps/web and apps/api are deployed as
// separate Vercel projects on different subdomains.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? `Request to ${url} failed with ${res.status}`);
  }
  return data as T;
}

async function getJson<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { headers: await authHeader() });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? `Request to ${url} failed with ${res.status}`);
  }
  return data as T;
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

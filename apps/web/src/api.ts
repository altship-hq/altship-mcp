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
}

export interface GenerateResponse {
  outDir: string;
  filesWritten: string[];
  warnings: string[];
}

export interface DeployResponse {
  id: string;
  createdAt: string;
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
  warnings: string[];
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

export function generateServer(spec: string, toolNames: string[], platform: Platform): Promise<GenerateResponse> {
  return postJson<GenerateResponse>("/api/generate", { spec, toolNames, platform });
}

export function deployToVercel(spec: string, toolNames: string[], credentialValue?: string): Promise<DeployResponse> {
  return postJson<DeployResponse>("/api/deploy", { spec, toolNames, credentialValue });
}

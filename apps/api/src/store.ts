import { getSupabase } from "./supabase.js";

/** A tool as deployed, kept so other products (Agent Creator) can see what a server offers. */
export interface DeployedTool {
  name: string;
  description: string;
  destructive: boolean;
  sensitive: boolean;
  inputSchema: Record<string, unknown>;
}

export interface DeploymentRecord {
  id: string;
  userId: string;
  createdAt: string;
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
  /** Null for deployments recorded before tools were stored. */
  tools: DeployedTool[] | null;
  authMode: "static" | "passthrough" | null;
}

interface DeploymentRow {
  id: string;
  user_id: string;
  created_at: string;
  api_title: string;
  tool_names: string[];
  project_name: string;
  project_id: string;
  url: string;
  tools: DeployedTool[] | null;
  auth_mode: "static" | "passthrough" | null;
}

function fromRow(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    apiTitle: row.api_title,
    toolNames: row.tool_names,
    projectName: row.project_name,
    projectId: row.project_id,
    url: row.url,
    tools: row.tools ?? null,
    authMode: row.auth_mode ?? null,
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
      api_title: record.apiTitle,
      tool_names: record.toolNames,
      project_name: record.projectName,
      project_id: record.projectId,
      url: record.url,
      tools: record.tools,
      auth_mode: record.authMode,
    });

  if (error) throw new Error(`Failed to record deployment: ${error.message}`);
}

export async function getDeployment(id: string, userId: string): Promise<DeploymentRecord | null> {
  const { data, error } = await getSupabase().from("deployments").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`Failed to load deployment: ${error.message}`);
  return data ? fromRow(data as DeploymentRow) : null;
}

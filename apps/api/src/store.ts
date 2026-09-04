import { getSupabase } from "./supabase.js";

export interface DeploymentRecord {
  id: string;
  createdAt: string;
  userId: string;
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
}

interface DeploymentRow {
  id: string;
  created_at: string;
  user_id: string;
  api_title: string;
  tool_names: string[];
  project_name: string;
  project_id: string;
  url: string;
}

function fromRow(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    userId: row.user_id,
    apiTitle: row.api_title,
    toolNames: row.tool_names,
    projectName: row.project_name,
    projectId: row.project_id,
    url: row.url,
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
    });

  if (error) throw new Error(`Failed to record deployment: ${error.message}`);
}

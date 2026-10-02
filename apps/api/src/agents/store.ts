import type { AgentPlan } from "@altship/agent-design";
import { getSupabase } from "../supabase.js";

export interface AgentRecord {
  id: string;
  createdAt: string;
  name: string;
  description: string;
  plan: AgentPlan;
  coordinatorAgentId: string;
  coordinatorVersion: number;
  specialistAgentIds: { key: string; id: string; version: number }[];
}

interface AgentRow {
  id: string;
  created_at: string;
  name: string;
  description: string;
  plan: AgentPlan;
  coordinator_agent_id: string;
  coordinator_version: number;
  specialist_agent_ids: { key: string; id: string; version: number }[];
}

export type RunSource = "playground" | "endpoint";
export type RunStatus = "running" | "requires_action" | "completed" | "failed";

export interface AgentRunRecord {
  sessionId: string;
  agentId: string;
  createdAt: string;
  source: RunSource;
  status: RunStatus;
  inputPreview: string | null;
  outputPreview: string | null;
}

interface AgentRunRow {
  session_id: string;
  agent_id: string;
  created_at: string;
  source: RunSource;
  status: RunStatus;
  input_preview: string | null;
  output_preview: string | null;
}

const PREVIEW_LENGTH = 280;

function fromAgentRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    name: row.name,
    description: row.description,
    plan: row.plan,
    coordinatorAgentId: row.coordinator_agent_id,
    coordinatorVersion: row.coordinator_version,
    specialistAgentIds: row.specialist_agent_ids,
  };
}

function fromRunRow(row: AgentRunRow): AgentRunRecord {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    source: row.source,
    status: row.status,
    inputPreview: row.input_preview,
    outputPreview: row.output_preview,
  };
}

export function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

export async function insertAgent(record: Omit<AgentRecord, "createdAt">): Promise<AgentRecord> {
  const { data, error } = await getSupabase()
    .from("agents")
    .insert({
      id: record.id,
      name: record.name,
      description: record.description,
      plan: record.plan,
      coordinator_agent_id: record.coordinatorAgentId,
      coordinator_version: record.coordinatorVersion,
      specialist_agent_ids: record.specialistAgentIds,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save agent: ${error.message}`);
  return fromAgentRow(data as AgentRow);
}

export async function listAgents(): Promise<AgentRecord[]> {
  const { data, error } = await getSupabase().from("agents").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list agents: ${error.message}`);
  return (data as AgentRow[]).map(fromAgentRow);
}

export async function getAgent(id: string): Promise<AgentRecord | null> {
  const { data, error } = await getSupabase().from("agents").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to load agent: ${error.message}`);
  return data ? fromAgentRow(data as AgentRow) : null;
}

export async function insertRun(run: { sessionId: string; agentId: string; source: RunSource; input: string }) {
  const { error } = await getSupabase().from("agent_runs").insert({
    session_id: run.sessionId,
    agent_id: run.agentId,
    source: run.source,
    status: "running",
    input_preview: preview(run.input),
  });
  if (error) throw new Error(`Failed to record run: ${error.message}`);
}

export async function updateRun(sessionId: string, update: { status: RunStatus; output?: string | null }) {
  const { error } = await getSupabase()
    .from("agent_runs")
    .update({ status: update.status, ...(update.output !== undefined ? { output_preview: preview(update.output) } : {}) })
    .eq("session_id", sessionId);
  if (error) throw new Error(`Failed to update run: ${error.message}`);
}

export async function getRun(agentId: string, sessionId: string): Promise<AgentRunRecord | null> {
  const { data, error } = await getSupabase()
    .from("agent_runs")
    .select("*")
    .eq("agent_id", agentId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load run: ${error.message}`);
  return data ? fromRunRow(data as AgentRunRow) : null;
}

export async function listRuns(agentId: string): Promise<AgentRunRecord[]> {
  const { data, error } = await getSupabase()
    .from("agent_runs")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to list runs: ${error.message}`);
  return (data as AgentRunRow[]).map(fromRunRow);
}

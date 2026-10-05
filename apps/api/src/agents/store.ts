import type { AgentPlan } from "@altship/agent-design";
import { getSupabase } from "../supabase.js";

export interface AgentRecord {
  id: string;
  userId: string;
  createdAt: string;
  name: string;
  description: string;
  plan: AgentPlan;
  coordinatorAgentId: string;
  coordinatorVersion: number;
  specialistAgentIds: { key: string; id: string; version: number }[];
  /** Anthropic vault with altship's access keys for the agent's MCP servers. */
  vaultId: string | null;
}

interface AgentRow {
  id: string;
  user_id: string;
  created_at: string;
  name: string;
  description: string;
  plan: AgentPlan;
  coordinator_agent_id: string;
  coordinator_version: number;
  specialist_agent_ids: { key: string; id: string; version: number }[];
  vault_id: string | null;
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
  /** When the run last settled; null while running, and on runs from before this was recorded. */
  endedAt: string | null;
  /** Tool calls the agent made; null on runs from before this was recorded. */
  toolCalls: number | null;
}

interface AgentRunRow {
  session_id: string;
  agent_id: string;
  created_at: string;
  source: RunSource;
  status: RunStatus;
  input_preview: string | null;
  output_preview: string | null;
  ended_at?: string | null;
  tool_calls?: number | null;
}

const PREVIEW_LENGTH = 280;

function fromAgentRow(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    name: row.name,
    description: row.description,
    plan: row.plan,
    coordinatorAgentId: row.coordinator_agent_id,
    coordinatorVersion: row.coordinator_version,
    specialistAgentIds: row.specialist_agent_ids,
    vaultId: row.vault_id ?? null,
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
    endedAt: row.ended_at ?? null,
    toolCalls: row.tool_calls ?? null,
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
      user_id: record.userId,
      name: record.name,
      description: record.description,
      plan: record.plan,
      coordinator_agent_id: record.coordinatorAgentId,
      coordinator_version: record.coordinatorVersion,
      specialist_agent_ids: record.specialistAgentIds,
      vault_id: record.vaultId,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to save agent: ${error.message}`);
  return fromAgentRow(data as AgentRow);
}

export async function listAgents(userId: string): Promise<AgentRecord[]> {
  const { data, error } = await getSupabase()
    .from("agents")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list agents: ${error.message}`);
  return (data as AgentRow[]).map(fromAgentRow);
}

/** With a userId, only finds the agent if that user owns it. */
export async function getAgent(id: string, userId?: string): Promise<AgentRecord | null> {
  let query = getSupabase().from("agents").select("*").eq("id", id);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to load agent: ${error.message}`);
  return data ? fromAgentRow(data as AgentRow) : null;
}

export async function setAgentVault(agentId: string, vaultId: string) {
  const { error } = await getSupabase().from("agents").update({ vault_id: vaultId }).eq("id", agentId);
  if (error) throw new Error(`Failed to save agent vault: ${error.message}`);
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

export async function updateRun(sessionId: string, update: { status: RunStatus; output?: string | null; toolCalls?: number }) {
  const base = { status: update.status, ...(update.output !== undefined ? { output_preview: preview(update.output) } : {}) };
  // What Observability shows on top: when the run last settled, and its tool calls.
  const extra = {
    ...(update.status !== "running" ? { ended_at: new Date().toISOString() } : {}),
    ...(update.toolCalls !== undefined ? { tool_calls: update.toolCalls } : {}),
  };
  let { error } = await getSupabase().from("agent_runs").update({ ...base, ...extra }).eq("session_id", sessionId);
  // Those columns were added later; a database without them still records the run.
  if (error && Object.keys(extra).length > 0 && /ended_at|tool_calls/.test(error.message)) {
    ({ error } = await getSupabase().from("agent_runs").update(base).eq("session_id", sessionId));
  }
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

/** An agent's latest runs; `since` is the oldest to include. */
export async function listRuns(agentId: string, since?: string): Promise<AgentRunRecord[]> {
  let query = getSupabase().from("agent_runs").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }).limit(100);
  if (since) query = query.gte("created_at", since);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list runs: ${error.message}`);
  return (data as AgentRunRow[]).map(fromRunRow);
}

/** The most recent runs of those agents, newest first; `before` pages further back, `since` is the oldest to include. */
export async function listRunsForAgents(agentIds: string[], options: { limit: number; before?: string; since?: string }): Promise<AgentRunRecord[]> {
  if (agentIds.length === 0) return [];
  let query = getSupabase().from("agent_runs").select("*").in("agent_id", agentIds).order("created_at", { ascending: false }).limit(options.limit);
  if (options.before) query = query.lt("created_at", options.before);
  if (options.since) query = query.gte("created_at", options.since);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list runs: ${error.message}`);
  return (data as AgentRunRow[]).map(fromRunRow);
}

import { PLANS, paidAccounts, retentionCutoff, type PlanName } from "./plans.js";
import { getSupabase } from "./supabase.js";

// Deletes Observability records that are past their account's retention
// window: tool calls on its MCP servers and runs of its agents. Run daily
// (see /api/cron/retention).

/** PostgREST's list syntax for `in` filters, with each id quoted. */
function idList(ids: string[]): string {
  return `(${ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",")})`;
}

async function idsOwnedBy(table: "deployments" | "agents", userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await getSupabase().from(table).select("id").in("user_id", userIds);
  if (error) throw new Error(`Failed to load ${table}: ${error.message}`);
  return (data as { id: string }[]).map((row) => row.id);
}

/**
 * Deletes rows older than `cutoff` whose owner column is in `only` (a paid
 * plan's servers or agents) or, with `except`, is anything else (everyone on free).
 */
async function deleteOlder(
  table: "tool_calls" | "agent_runs",
  owner: "deployment_id" | "agent_id",
  time: "started_at" | "created_at",
  cutoff: string,
  scope: { only: string[] } | { except: string[] },
): Promise<number> {
  if ("only" in scope && scope.only.length === 0) return 0;
  let query = getSupabase().from(table).delete({ count: "exact" }).lt(time, cutoff);
  if ("only" in scope) query = query.in(owner, scope.only);
  else if (scope.except.length > 0) query = query.not(owner, "in", idList(scope.except));
  const { count, error } = await query;
  if (error) throw new Error(`Failed to clean up ${table}: ${error.message}`);
  return count ?? 0;
}

export async function runRetention(): Promise<{ toolCalls: number; agentRuns: number }> {
  const paid = await paidAccounts();
  const deleted = { toolCalls: 0, agentRuns: 0 };
  const paidDeployments: string[] = [];
  const paidAgents: string[] = [];

  for (const plan of (Object.keys(PLANS) as PlanName[]).filter((p) => p !== "free")) {
    const users = paid.filter((a) => a.plan === plan).map((a) => a.userId);
    const deployments = await idsOwnedBy("deployments", users);
    const agents = await idsOwnedBy("agents", users);
    paidDeployments.push(...deployments);
    paidAgents.push(...agents);
    deleted.toolCalls += await deleteOlder("tool_calls", "deployment_id", "started_at", retentionCutoff(plan), { only: deployments });
    deleted.agentRuns += await deleteOlder("agent_runs", "agent_id", "created_at", retentionCutoff(plan), { only: agents });
  }

  // Everyone else is on free.
  deleted.toolCalls += await deleteOlder("tool_calls", "deployment_id", "started_at", retentionCutoff("free"), { except: paidDeployments });
  deleted.agentRuns += await deleteOlder("agent_runs", "agent_id", "created_at", retentionCutoff("free"), { except: paidAgents });
  return deleted;
}

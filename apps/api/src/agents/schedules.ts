import { randomUUID } from "node:crypto";
import { buildSchedule, type ScheduleInput } from "@altship/agent-design";
import { PLANS, planOf } from "../plans.js";
import { emailEnabled, sendRunEmail } from "../email.js";
import { getSupabase } from "../supabase.js";
import { environmentId, getAnthropic } from "./anthropic.js";
import { followRun } from "./flow-run.js";
import {
  claimRunNotification,
  countSchedules,
  deleteSchedule,
  getAgent,
  getRunBySession,
  getScheduleByDeployment,
  insertSchedule,
  listSchedules,
  listUnsettledScheduledRuns,
  recordScheduledRun,
  updateRun,
  updateSchedule,
  type AgentRecord,
  type RunStatus,
  type ScheduleRecord,
} from "./store.js";

// Scheduled runs. The agent runtime fires them: a schedule is an Anthropic
// "deployment" holding the agent, when to run and what to ask it. altship
// keeps which schedules exist, copies each run into agent_runs (when a page
// that shows them is opened, and from the webhook when that's set up) and
// emails the owner when a run needs them.

/** A schedule couldn't be made as asked: too many, or nothing to ask the agent. */
export class ScheduleLimitError extends Error {}

const MAX_PROMPT_LENGTH = 4000;
/** Unsettled runs checked each time runs are listed; each costs up to a second. */
const SETTLE_PER_SYNC = 3;

/** Whether run emails can be sent: the webhook that reports runs, and email itself, are both set up. */
export function runEmailsEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY) && emailEnabled();
}

export async function scheduleAllowance(userId: string): Promise<{ used: number; limit: number }> {
  const [used, plan] = await Promise.all([countSchedules(userId), planOf(userId)]);
  return { used, limit: PLANS[plan].schedules };
}

/** Creates a schedule for the agent (which must already have its vault, if it needs one). */
export async function createSchedule(agent: AgentRecord, input: ScheduleInput & { prompt: string; emailResults: boolean }): Promise<ScheduleRecord> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new ScheduleLimitError("Say what the agent should do each time.");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new ScheduleLimitError(`Keep what it should do under ${MAX_PROMPT_LENGTH} characters.`);
  const built = buildSchedule(input);

  const plan = await planOf(agent.userId);
  const { used, limit } = await scheduleAllowance(agent.userId);
  if (used >= limit) throw new ScheduleLimitError(`Your plan allows ${limit} schedule${limit === 1 ? "" : "s"}. Delete one to add another.`);

  const id = `sch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const deployment = await getAnthropic().beta.deployments.create({
    name: `${agent.name} — ${built.label}`.slice(0, 200),
    agent: { type: "agent", id: agent.coordinatorAgentId, version: agent.coordinatorVersion },
    environment_id: environmentId(),
    initial_events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    schedule: { type: "cron", expression: built.cron, timezone: built.timezone },
    // Nobody is watching a scheduled run, so each has a spending cap.
    budget: { type: "limit", max_list_cost: { amount: String(PLANS[plan].scheduledRunCents), currency: "USD" } },
    metadata: { altship_agent_id: agent.id, altship_schedule_id: id },
    ...(agent.vaultId ? { vault_ids: [agent.vaultId] } : {}),
  });

  try {
    return await insertSchedule({
      id,
      agentId: agent.id,
      userId: agent.userId,
      prompt,
      cron: built.cron,
      timezone: built.timezone,
      label: built.label,
      deploymentId: deployment.id,
      emailResults: input.emailResults,
    });
  } catch (err) {
    // Without its row the schedule would keep firing with nothing to show for it.
    await getAnthropic().beta.deployments.archive(deployment.id).catch(() => {});
    throw err;
  }
}

export async function setSchedulePaused(schedule: ScheduleRecord, paused: boolean) {
  if (paused) await getAnthropic().beta.deployments.pause(schedule.deploymentId);
  else await getAnthropic().beta.deployments.unpause(schedule.deploymentId);
  await updateSchedule(schedule.id, { status: paused ? "paused" : "active" });
}

/** Stops the schedule for good. Its past runs stay in the run log. */
export async function removeSchedule(schedule: ScheduleRecord) {
  await getAnthropic().beta.deployments.archive(schedule.deploymentId);
  await deleteSchedule(schedule.id);
}

/** Runs the schedule's request once, now. Works while paused too. */
export async function runScheduleNow(schedule: ScheduleRecord): Promise<string> {
  const run = await getAnthropic().beta.deployments.run(schedule.deploymentId);
  if (!run.session_id) throw new Error(run.error?.message ?? "The run couldn't be started.");
  await recordScheduledRun({ sessionId: run.session_id, schedule, startedAt: run.created_at });
  return run.session_id;
}

/** When each schedule runs next, as the runtime has it; null when paused or it couldn't be read. */
export async function nextRuns(schedules: ScheduleRecord[]): Promise<Map<string, string | null>> {
  const entries = await Promise.all(
    schedules.map(async (s) => {
      if (s.status === "paused") return [s.id, null] as const;
      try {
        const deployment = await getAnthropic().beta.deployments.retrieve(s.deploymentId);
        return [s.id, deployment.schedule?.upcoming_runs_at?.[0] ?? null] as const;
      } catch {
        return [s.id, null] as const;
      }
    }),
  );
  return new Map(entries);
}

/**
 * Brings agent_runs up to date with what the agent's schedules have run:
 * copies in runs not seen yet, and checks on a few that hadn't finished.
 * Called when runs are about to be shown; the webhook does the same as
 * things happen, when it's set up.
 */
export async function syncScheduledRuns(agent: AgentRecord) {
  const schedules = await listSchedules(agent.id);
  await Promise.all(
    schedules.map(async (schedule) => {
      let latest = schedule.syncedTo;
      const since = schedule.syncedTo ?? schedule.createdAt;
      for await (const run of getAnthropic().beta.deploymentRuns.list({ deployment_id: schedule.deploymentId, "created_at[gt]": since, limit: 50 })) {
        await recordScheduledRun({
          sessionId: run.session_id ?? run.id,
          schedule,
          startedAt: run.created_at,
          ...(run.session_id ? {} : { failure: `The run couldn't start: ${run.error?.message ?? "unknown reason"}` }),
        });
        if (!latest || run.created_at > latest) latest = run.created_at;
      }
      if (latest && latest !== schedule.syncedTo) await updateSchedule(schedule.id, { syncedTo: latest });
    }),
  );
  for (const run of await listUnsettledScheduledRuns(agent.id, SETTLE_PER_SYNC)) await settleRun(agent, run.sessionId);
}

/**
 * Checks where a run has got to and records it once it has stopped. For an
 * agent with a flow, this is also what moves the flow to its next step.
 * Returns the status found.
 */
export async function settleRun(agent: AgentRecord, sessionId: string): Promise<{ status: RunStatus; reply: string }> {
  const outcome = await followRun(agent, sessionId, { maxMs: 1_000 });
  if (outcome.status !== "running") await updateRun(sessionId, { status: outcome.status, output: outcome.reply || null, toolCalls: outcome.toolCalls });
  return { status: outcome.status, reply: outcome.reply };
}

/**
 * A session stopped (the webhook says so): if it's a scheduled run, record
 * where it got to and email its owner when it needs them, when it failed, or
 * with the result if the schedule asks for that.
 */
export async function onSessionStopped(sessionId: string) {
  let run = await getRunBySession(sessionId);
  let schedule: ScheduleRecord | null = null;
  if (!run) {
    // The "run started" webhook may not have arrived first: find the schedule from the session.
    const session = await getAnthropic().beta.sessions.retrieve(sessionId);
    schedule = session.deployment_id ? await getScheduleByDeployment(session.deployment_id) : null;
    if (!schedule) return; // not a scheduled run of ours
    await recordScheduledRun({ sessionId, schedule, startedAt: session.created_at });
    run = await getRunBySession(sessionId);
  }
  if (!run || run.source !== "schedule") return;

  const agent = await getAgent(run.agentId);
  if (!agent) return;
  const { status, reply } = await settleRun(agent, sessionId);
  if (status === "running") return;

  schedule ??= (await listSchedules(agent.id)).find((s) => s.id === run.scheduleId) ?? null;
  const wanted = status === "requires_action" || status === "failed" || (status === "completed" && schedule?.emailResults === true);
  if (!wanted) return;
  await emailOwner(agent, { sessionId, status, scheduleLabel: schedule?.label ?? null, output: reply || null });
}

/** Emails the agent's owner about a run, once per status. Does nothing when email is off or they have no confirmed address. */
async function emailOwner(agent: AgentRecord, run: { sessionId: string; status: RunStatus; scheduleLabel: string | null; output: string | null }) {
  if (!emailEnabled() || !(await claimRunNotification(run.sessionId, run.status))) return;
  const { data } = await getSupabase().auth.admin.getUserById(agent.userId);
  const to = data.user?.email_confirmed_at ? data.user.email : null;
  if (to) await sendRunEmail({ to, agentId: agent.id, agentName: agent.name, ...run });
}

/** A scheduled run started, or couldn't (the webhook says so): record it. */
export async function onDeploymentRun(runId: string) {
  const run = await getAnthropic().beta.deploymentRuns.retrieve(runId);
  const schedule = await getScheduleByDeployment(run.deployment_id);
  if (!schedule) return;
  const failure = run.session_id ? null : `The run couldn't start: ${run.error?.message ?? "unknown reason"}`;
  await recordScheduledRun({ sessionId: run.session_id ?? run.id, schedule, startedAt: run.created_at, ...(failure ? { failure } : {}) });
  if (!failure) return;
  const agent = await getAgent(schedule.agentId);
  if (agent) await emailOwner(agent, { sessionId: run.id, status: "failed", scheduleLabel: schedule.label, output: failure });
}

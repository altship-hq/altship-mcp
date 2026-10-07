import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { BUILTIN_TOOLS, PlanError, ScheduleError, compileFlow, validatePlan, type AgentPlan, type BuiltinTool, type ScheduleFrequency } from "@altship/agent-design";
import { AgentConfigError } from "./anthropic.js";
import { PLANS, planOf, retentionCutoff } from "../plans.js";
import { appsCatalogEntry, loadCatalog, publicEntry, serversUsedBy, toToolCatalog, type CatalogEntry } from "./catalog.js";
import { AppsConfigError, appsEnabled, toolkitSlug } from "../apps/composio.js";
import { planAgent, PlannerError } from "./planner.js";
import { confirmToolCall, createAgentVault, createManagedAgents, followSession, sendUserMessage, startSession } from "./runtime.js";
import { requireAuth, userIdOf } from "../auth.js";
import {
  ScheduleLimitError,
  createSchedule,
  nextRuns,
  removeSchedule,
  runEmailsEnabled,
  runScheduleNow,
  scheduleAllowance,
  setSchedulePaused,
  syncScheduledRuns,
} from "./schedules.js";
import {
  getAgent,
  getRun,
  getSchedule,
  insertAgent,
  listScheduledAgentIds,
  listSchedules,
  updateSchedule,
  insertRun,
  listRunsForAgents,
  listAgents,
  listRuns,
  setAgentVault,
  updateRun,
  type AgentRecord,
  type ScheduleRecord,
} from "./store.js";

// Agent Creator API. Dashboard routes need a signed-in user and only see that
// user's agents. The deployed-endpoint routes (/:id/run, /:id/runs/:sid...)
// are called by the agent's own clients, not the dashboard, so they stay open
// until they get their own API-key check.

export const agentsRouter = Router();

/** Matches the deployed-endpoint routes; GET /:id/runs (the dashboard's run list) is not one. */
const ENDPOINT_ROUTE = /^\/[^/]+\/(run|runs\/[^/]+(\/confirm)?)$/;

agentsRouter.use((req, res, next) => (ENDPOINT_ROUTE.test(req.path) ? next() : requireAuth(req, res, next)));

/** How long a request may wait on an agent before returning "running". */
const RUN_WAIT_MS = 120_000;
/** Playground streams end before the hosting function's time limit; the client reconnects. */
const STREAM_MAX_MS = 240_000;

// `?apps=gmail,slack` adds the user's connected apps as one more server.
agentsRouter.get("/catalog", async (req, res) => {
  const { servers, unavailable } = await loadCatalog(userIdOf(req));
  const apps = appToolkits(typeof req.query.apps === "string" ? req.query.apps.split(",") : []);
  if (apps.length > 0) servers.push(await appsCatalogEntry(userIdOf(req), apps));
  res.json({ servers: servers.map(publicEntry), unavailable });
});

/** The app (toolkit) slugs in a request, cleaned up; none when connected apps aren't set up. */
function appToolkits(value: unknown): string[] {
  if (!appsEnabled() || !Array.isArray(value)) return [];
  return [...new Set(value.flatMap((v) => toolkitSlug(v) ?? []))].slice(0, 20);
}

/**
 * The tools the user chose for this agent: MCP servers they ticked (none by
 * default) and built-in tools they turned on. Agents don't need any MCP server.
 */
async function chosenTools(req: Request): Promise<{ servers: CatalogEntry[]; allowedBuiltins: BuiltinTool[] }> {
  const ids: unknown = req.body?.serverDeploymentIds;
  const wanted = new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : []);
  const builtins: unknown = req.body?.builtinTools;
  const allowedBuiltins = Array.isArray(builtins)
    ? BUILTIN_TOOLS.filter((tool) => builtins.includes(tool))
    : [];
  const servers = wanted.size > 0 ? (await loadCatalog(userIdOf(req))).servers.filter((s) => wanted.has(s.deploymentId)) : [];
  // Connected apps the user ticked join as one more server.
  const apps = appToolkits(req.body?.appToolkits);
  if (apps.length > 0) servers.push(await appsCatalogEntry(userIdOf(req), apps));
  return { servers, allowedBuiltins };
}

agentsRouter.post("/plan", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (!name || !description) return res.status(400).json({ error: "Give the agent a name and a description." });

  const { servers, allowedBuiltins } = await chosenTools(req);
  const focus = typeof req.body?.focusDeploymentId === "string" ? servers.find((s) => s.deploymentId === req.body.focusDeploymentId) : undefined;
  const plan = await planAgent(
    {
      name,
      description,
      feedback: typeof req.body?.feedback === "string" && req.body.feedback.trim() ? req.body.feedback.trim() : undefined,
      previousPlan: req.body?.previousPlan as AgentPlan | undefined,
      focusServer: focus?.name,
      allowedBuiltins,
    },
    toToolCatalog(servers),
  );
  res.json({ plan, catalog: servers.map(publicEntry) });
});

// Approve: create the Managed Agents and save the agent.
agentsRouter.post("/", async (req, res) => {
  const { servers, allowedBuiltins } = await chosenTools(req);
  const catalog = toToolCatalog(servers);
  const plan = validatePlan(req.body?.plan, catalog, { allowedBuiltins });
  // A plan with an execution flow runs as a coordinator following that flow;
  // the plan as the user designed it is what's saved.
  const runnable = compileFlow(plan);

  const { coordinator, specialists } = await createManagedAgents(runnable, catalog);
  const id = `agt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  // A vault only when the agent calls MCP servers (it holds their access keys).
  const used = serversUsedBy(runnable, servers);
  const vaultId = used.length > 0 ? await createAgentVault(id, used) : null;
  const record = await insertAgent({
    id,
    userId: userIdOf(req),
    name: plan.name,
    description: plan.description,
    plan,
    coordinatorAgentId: coordinator.id,
    coordinatorVersion: coordinator.version,
    specialistAgentIds: specialists,
    vaultId,
  });
  res.status(201).json(record);
});

agentsRouter.get("/", async (req, res) => {
  res.json(await listAgents(userIdOf(req)));
});

// Runs across all of the user's agents (or one, with ?agentId=), newest first,
// for Observability. `before` (a run's start time) pages further back.
agentsRouter.get("/runs", async (req, res) => {
  const agents = await listAgents(userIdOf(req));
  const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
  const wanted = agentId ? agents.filter((a) => a.id === agentId) : agents;
  if (agentId && wanted.length === 0) return res.status(404).json({ error: "Agent not found." });

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
  // On the newest page, pick up what scheduled agents have run since last time. Best effort.
  if (!before) {
    const scheduled = await listScheduledAgentIds(userIdOf(req)).catch(() => new Set<string>());
    await Promise.all(
      wanted.filter((a) => scheduled.has(a.id)).map((a) => syncScheduledRuns(a).catch((err) => console.error("Schedule sync failed:", errorMessage(err)))),
    );
  }
  // Only what the account's plan keeps is shown (older runs are deleted daily).
  const plan = await planOf(userIdOf(req));
  // One extra row tells us whether there's another page.
  const rows = await listRunsForAgents(wanted.map((a) => a.id), { limit: limit + 1, before, since: retentionCutoff(plan) });
  const runs = rows.slice(0, limit);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  res.json({
    runs: runs.map((run) => ({ ...run, agentName: names.get(run.agentId) ?? "" })),
    nextBefore: rows.length > limit ? runs[runs.length - 1].createdAt : null,
    plan,
    retentionDays: PLANS[plan].retentionDays,
  });
});

agentsRouter.get("/:id", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (agent) res.json(agent);
});

agentsRouter.get("/:id/runs", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  // Scheduled runs happen away from here: bring the log up to date first. Best effort, so the log still shows.
  await syncScheduledRuns(agent).catch((err) => console.error("Schedule sync failed:", errorMessage(err)));
  res.json(await listRuns(agent.id, retentionCutoff(await planOf(agent.userId))));
});

// ---- Schedules ----------------------------------------------------------

agentsRouter.get("/:id/schedules", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const schedules = await listSchedules(agent.id);
  const [next, allowance] = await Promise.all([nextRuns(schedules), scheduleAllowance(agent.userId)]);
  res.json({
    schedules: schedules.map((s) => publicSchedule(s, next.get(s.id) ?? null)),
    ...allowance,
    // Whether the owner is emailed about runs, so the page doesn't promise what isn't set up.
    emails: runEmailsEnabled(),
  });
});

agentsRouter.post("/:id/schedules", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const body = req.body ?? {};
  const schedule = await createSchedule(await withVault(agent), {
    frequency: body.frequency as ScheduleFrequency,
    time: body.time,
    weekday: body.weekday,
    timezone: body.timezone,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    emailResults: body.emailResults === true,
  });
  const next = await nextRuns([schedule]);
  res.status(201).json(publicSchedule(schedule, next.get(schedule.id) ?? null));
});

agentsRouter.patch("/:id/schedules/:scheduleId", async (req, res) => {
  const found = await requireSchedule(req, res);
  if (!found) return;
  const { paused, emailResults } = req.body ?? {};
  if (typeof paused === "boolean") await setSchedulePaused(found.schedule, paused);
  if (typeof emailResults === "boolean") await updateSchedule(found.schedule.id, { emailResults });
  const schedule = (await getSchedule(found.agent.id, found.schedule.id))!;
  const next = await nextRuns([schedule]);
  res.json(publicSchedule(schedule, next.get(schedule.id) ?? null));
});

agentsRouter.delete("/:id/schedules/:scheduleId", async (req, res) => {
  const found = await requireSchedule(req, res);
  if (!found) return;
  await removeSchedule(found.schedule);
  res.json({ ok: true });
});

agentsRouter.post("/:id/schedules/:scheduleId/run", async (req, res) => {
  const found = await requireSchedule(req, res);
  if (!found) return;
  res.status(202).json({ sessionId: await runScheduleNow(found.schedule) });
});

/** A schedule as the dashboard sees it: no runtime ids. */
function publicSchedule(s: ScheduleRecord, nextRunAt: string | null) {
  return { id: s.id, createdAt: s.createdAt, prompt: s.prompt, label: s.label, timezone: s.timezone, status: s.status, emailResults: s.emailResults, nextRunAt };
}

async function requireSchedule(req: Request, res: Response): Promise<{ agent: AgentRecord; schedule: ScheduleRecord } | null> {
  const agent = await requireAgent(req, res);
  if (!agent) return null;
  const schedule = await getSchedule(agent.id, String(req.params.scheduleId));
  if (!schedule) {
    res.status(404).json({ error: "Schedule not found." });
    return null;
  }
  return { agent, schedule };
}

// ---- Playground ---------------------------------------------------------

agentsRouter.post("/:id/sessions", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const sessionId = await startSession(await withVault(agent), `${agent.name} — playground`);
  res.status(201).json({ sessionId });
});

agentsRouter.post("/:id/sessions/:sid/messages", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "Message text is required." });

  const sessionId = String(req.params.sid);
  if (!(await getRun(agent.id, sessionId))) {
    await insertRun({ sessionId, agentId: agent.id, source: "playground", input: text });
  }
  await sendUserMessage(sessionId, text);
  res.status(202).json({ ok: true });
});

agentsRouter.post("/:id/sessions/:sid/confirm", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const { toolCallId, result, denyMessage } = req.body ?? {};
  if (typeof toolCallId !== "string" || (result !== "allow" && result !== "deny")) {
    return res.status(400).json({ error: "toolCallId and result (allow | deny) are required." });
  }
  await confirmToolCall(String(req.params.sid), toolCallId, result, typeof denyMessage === "string" ? denyMessage : undefined);
  res.status(202).json({ ok: true });
});

/** Server-Sent Events: every event of the session so far, then live ones until the turn settles. */
agentsRouter.get("/:id/sessions/:sid/stream", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const sessionId = String(req.params.sid);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  try {
    const tracker = await followSession(sessionId, {
      maxMs: STREAM_MAX_MS,
      signal: abort.signal,
      onEvent: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    });
    if (tracker.settled && (await getRun(agent.id, sessionId))) {
      await updateRun(sessionId, { status: tracker.status, output: tracker.reply || null, toolCalls: tracker.toolCalls });
    }
    res.write(`event: done\ndata: ${JSON.stringify({ status: tracker.status })}\n\n`);
  } catch (err) {
    res.write(`event: failure\ndata: ${JSON.stringify({ error: errorMessage(err) })}\n\n`);
  }
  res.end();
});

// ---- Deployed endpoint --------------------------------------------------

agentsRouter.post("/:id/run", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const input = typeof req.body?.input === "string" ? req.body.input.trim() : "";
  if (!input) return res.status(400).json({ error: 'Body must be JSON with an "input" string.' });

  const sessionId = await startSession(await withVault(agent), `${agent.name} — API run`);
  await insertRun({ sessionId, agentId: agent.id, source: "endpoint", input });
  const tracker = await followSession(sessionId, { maxMs: RUN_WAIT_MS, afterStreamOpen: () => sendUserMessage(sessionId, input) });
  res.json(await runResponse(sessionId, tracker));
});

agentsRouter.get("/:id/runs/:sid", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const sessionId = String(req.params.sid);
  if (!(await getRun(agent.id, sessionId))) return res.status(404).json({ error: "Run not found." });

  const tracker = await followSession(sessionId, { maxMs: 1_000 });
  res.json(await runResponse(sessionId, tracker));
});

agentsRouter.post("/:id/runs/:sid/confirm", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const sessionId = String(req.params.sid);
  if (!(await getRun(agent.id, sessionId))) return res.status(404).json({ error: "Run not found." });

  const { toolCallId, result, denyMessage } = req.body ?? {};
  if (typeof toolCallId !== "string" || (result !== "allow" && result !== "deny")) {
    return res.status(400).json({ error: "toolCallId and result (allow | deny) are required." });
  }
  const tracker = await followSession(sessionId, {
    maxMs: RUN_WAIT_MS,
    afterStreamOpen: () => confirmToolCall(sessionId, toolCallId, result, typeof denyMessage === "string" ? denyMessage : undefined),
  });
  res.json(await runResponse(sessionId, tracker));
});

async function runResponse(sessionId: string, tracker: Awaited<ReturnType<typeof followSession>>) {
  await updateRun(sessionId, { status: tracker.status, output: tracker.reply || null, toolCalls: tracker.toolCalls });
  return {
    status: tracker.status,
    session_id: sessionId,
    output: tracker.status === "completed" ? tracker.reply : null,
    pending_approvals: tracker.pendingApprovals.map((a) => ({ tool_call_id: a.id, server: a.server, tool: a.tool, input: a.input })),
  };
}

/** Agents created before access keys existed get their vault on first use. */
async function withVault(agent: AgentRecord): Promise<AgentRecord> {
  if (agent.vaultId) return agent;
  const used = serversUsedBy(compileFlow(agent.plan), (await loadCatalog(agent.userId)).servers);
  if (used.length === 0) return agent; // no MCP servers: nothing to authorize
  const vaultId = await createAgentVault(agent.id, used);
  await setAgentVault(agent.id, vaultId);
  return { ...agent, vaultId };
}

/** Loads the agent named in the URL; on dashboard routes, only if the signed-in user owns it. */
async function requireAgent(req: Request, res: Response): Promise<AgentRecord | null> {
  const agent = await getAgent(String(req.params.id), req.userId);
  if (!agent) res.status(404).json({ error: "Agent not found." });
  return agent;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps known failures to useful HTTP errors; mounted after the router in server.ts. */
export function agentsErrorHandler(err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) {
  if (res.headersSent) return next(err);
  if (err instanceof PlanError || err instanceof PlannerError || err instanceof ScheduleError || err instanceof ScheduleLimitError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof AgentConfigError) return res.status(500).json({ error: err.message });
  if (err instanceof AppsConfigError) return res.status(503).json({ error: err.message });
  if (err instanceof Anthropic.APIError) {
    console.error("Anthropic API error:", err.status, err.message);
    return res.status(502).json({ error: `Anthropic API error (${err.status ?? "network"}): ${err.message}` });
  }
  console.error("Agents API error:", err);
  res.status(500).json({ error: errorMessage(err) });
}

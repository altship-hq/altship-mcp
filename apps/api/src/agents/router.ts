import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { PlanError, validatePlan, type AgentPlan } from "@altship/agent-design";
import { AgentConfigError } from "./anthropic.js";
import { loadCatalog, toToolCatalog } from "./catalog.js";
import { planAgent, PlannerError } from "./planner.js";
import { confirmToolCall, createManagedAgents, followSession, sendUserMessage, startSession } from "./runtime.js";
import { getAgent, getRun, insertAgent, insertRun, listAgents, listRuns, updateRun, type AgentRecord } from "./store.js";

// Agent Creator API. No auth yet (pre-launch, by decision) — when sign-in
// comes back, it goes in front of this router, and the deployed-endpoint
// routes (/:id/run...) get their own API-key check.

export const agentsRouter = Router();

/** How long a request may wait on an agent before returning "running". */
const RUN_WAIT_MS = 120_000;
/** Playground streams end before the hosting function's time limit; the client reconnects. */
const STREAM_MAX_MS = 240_000;

agentsRouter.get("/catalog", async (_req, res) => {
  res.json(await loadCatalog());
});

agentsRouter.post("/plan", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (!name || !description) return res.status(400).json({ error: "Give the agent a name and a description." });

  const { servers } = await loadCatalog();
  const focus = typeof req.body?.focusDeploymentId === "string" ? servers.find((s) => s.deploymentId === req.body.focusDeploymentId) : undefined;
  const plan = await planAgent(
    {
      name,
      description,
      feedback: typeof req.body?.feedback === "string" && req.body.feedback.trim() ? req.body.feedback.trim() : undefined,
      previousPlan: req.body?.previousPlan as AgentPlan | undefined,
      focusServer: focus?.name,
    },
    toToolCatalog(servers),
  );
  res.json({ plan, catalog: servers });
});

// Approve: create the Managed Agents and save the agent.
agentsRouter.post("/", async (req, res) => {
  const { servers } = await loadCatalog();
  const catalog = toToolCatalog(servers);
  const plan = validatePlan(req.body?.plan, catalog);

  const { coordinator, specialists } = await createManagedAgents(plan, catalog);
  const record = await insertAgent({
    id: `agt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    name: plan.name,
    description: plan.description,
    plan,
    coordinatorAgentId: coordinator.id,
    coordinatorVersion: coordinator.version,
    specialistAgentIds: specialists,
  });
  res.status(201).json(record);
});

agentsRouter.get("/", async (_req, res) => {
  res.json(await listAgents());
});

agentsRouter.get("/:id", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (agent) res.json(agent);
});

agentsRouter.get("/:id/runs", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (agent) res.json(await listRuns(agent.id));
});

// ---- Playground ---------------------------------------------------------

agentsRouter.post("/:id/sessions", async (req, res) => {
  const agent = await requireAgent(req, res);
  if (!agent) return;
  const sessionId = await startSession(agent, `${agent.name} — playground`);
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
      await updateRun(sessionId, { status: tracker.status, output: tracker.reply || null });
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

  const sessionId = await startSession(agent, `${agent.name} — API run`);
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
  await updateRun(sessionId, { status: tracker.status, output: tracker.reply || null });
  return {
    status: tracker.status,
    session_id: sessionId,
    output: tracker.status === "completed" ? tracker.reply : null,
    pending_approvals: tracker.pendingApprovals.map((a) => ({ tool_call_id: a.id, server: a.server, tool: a.tool, input: a.input })),
  };
}

async function requireAgent(req: Request, res: Response): Promise<AgentRecord | null> {
  const agent = await getAgent(String(req.params.id));
  if (!agent) res.status(404).json({ error: "Agent not found." });
  return agent;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps known failures to useful HTTP errors; mounted after the router in server.ts. */
export function agentsErrorHandler(err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) {
  if (res.headersSent) return next(err);
  if (err instanceof PlanError || err instanceof PlannerError) return res.status(400).json({ error: err.message });
  if (err instanceof AgentConfigError) return res.status(500).json({ error: err.message });
  if (err instanceof Anthropic.APIError) {
    console.error("Anthropic API error:", err.status, err.message);
    return res.status(502).json({ error: `Anthropic API error (${err.status ?? "network"}): ${err.message}` });
  }
  console.error("Agents API error:", err);
  res.status(500).json({ error: errorMessage(err) });
}

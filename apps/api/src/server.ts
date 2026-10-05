import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { validateSpec, type SpecInput } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer, generateVercelServer, deriveAuthBinding, envSlug, upgradeVercelServerFiles, UpgradeError } from "@altship/mcp-gen";
import { ensureProject, setProjectEnvVar, assignMcpSubdomain, deployFiles, getDeploymentFiles, redeploy, VercelConfigError } from "./vercel-client.js";
import {
  recordDeployment,
  listDeployments,
  getDeployment,
  renameDeployment,
  canRecordUpgrades,
  markUpgraded,
  insertServerKey,
  listServerKeys,
  activeKeyHashes,
  revokeServerKey,
  getDeploymentById,
  listMembers,
  addMember,
  removeMember,
  memberIds,
  createInvite,
  listPendingInvites,
  getInvite,
  cancelInvite,
  markInviteAccepted,
  deleteAcceptedInvites,
  getDeploymentByProjectId,
  insertToolCalls,
  listToolCalls,
  listKeyHashes,
  listMembersOf,
  type ToolCallRecord,
  type ConnectSettings,
  type DeploymentRecord,
  type InviteRecord,
} from "./store.js";
import { AccessKeyConfigError, displayPrefix, generateAccessKey, hashAccessKey, internalAccessKey } from "./access-keys.js";
import { AudienceError, applyAccessEnv, parseAudience } from "./server-access.js";
import { confirmedEmailOf, requireAuth, userIdOf } from "./auth.js";
import { inviteLink, sendInviteEmail } from "./email.js";
import { parseToolCallSpans, projectIdFromToken, telemetryEnv } from "./telemetry.js";
import { getSupabase } from "./supabase.js";
import { PLANS, planOf, retentionCutoff } from "./plans.js";
import { runRetention } from "./retention.js";
import { agentsRouter, agentsErrorHandler } from "./agents/router.js";
import { endUsersRouter } from "./end-users/router.js";
import { appsRouter, appsErrorHandler } from "./apps/router.js";
import { memoryRouter } from "./memory/router.js";
import { MemoryError, deleteRecord, listRecords, saveRecord, saveRecords, searchRecords, updateRecord } from "./memory/records.js";
import { MAX_IMPORT_NOTES, planImport } from "./memory/import.js";
import { MEMORY_TEMPLATES, collectionsOf, deployedMemoryTools } from "./memory/tools.js";
import { listConnections, revokeConnection } from "./end-users/store.js";

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

const SPEC_REQUIRED = "Provide the spec as a public URL (spec) or the file's contents (specContent).";

/**
 * The OpenAPI spec from a request: uploaded file contents (specContent) or a
 * public URL (spec). Parsed with { untrusted: true }, so it can never read
 * files on this server or reach private-network addresses.
 */
function specInput(body: Record<string, unknown> | undefined): SpecInput | null {
  if (typeof body?.specContent === "string" && body.specContent.trim()) return { content: body.specContent };
  if (typeof body?.spec === "string" && body.spec.trim()) return body.spec.trim();
  return null;
}

export const app = express();
// Uploaded OpenAPI specs travel in the JSON body, so allow large ones.
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: false }));
// The end-user sign-in server (public, its own CORS) comes before the
// dashboard API's origin-restricted CORS.
app.use(endUsersRouter);
// Memory stores are MCP servers this API serves itself, called by MCP clients from anywhere.
app.use(memoryRouter);
app.use(cors({ origin: allowedOrigins }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Telemetry from managed MCP servers: an OTLP/HTTP (JSON) trace receiver.
// Each server authenticates with the token derived for its hosting project
// (see telemetry.ts), so a server can only ever add calls to its own log.
app.post("/api/otel/v1/traces", async (req, res) => {
  const token = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const projectId = token ? projectIdFromToken(token) : null;
  const deployment = projectId ? await getDeploymentByProjectId(projectId) : null;
  if (!deployment) return res.status(401).json({ error: "Unknown telemetry token." });
  await insertToolCalls(deployment.id, parseToolCallSpans(req.body));
  // OTLP's success response: an empty ExportTraceServiceResponse.
  res.json({});
});

// Daily cleanup of Observability records past their account's retention
// window, called by the host's scheduler (Vercel Cron sends CRON_SECRET as a
// bearer token).
app.all("/api/cron/retention", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET isn't set, so scheduled cleanup is off." });
  const given = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(given), digest(secret))) return res.status(401).json({ error: "Not allowed." });
  res.json({ deleted: await runRetention() });
});

app.use("/api/agents", agentsRouter, agentsErrorHandler);
app.use("/api/apps", appsRouter, appsErrorHandler);

// Everything else is the MCP Creator dashboard API: signed-in users only.
app.use(["/api/tools", "/api/generate", "/api/deployments", "/api/deploy", "/api/invites", "/api/logs", "/api/memory"], requireAuth);

app.post("/api/tools", async (req, res) => {
  const spec = specInput(req.body);
  if (!spec) return res.status(400).json({ error: SPEC_REQUIRED });

  const validation = await validateSpec(spec, { untrusted: true });
  if (!validation.document) {
    return res.json({ valid: false, apiTitle: null, issues: validation.issues, tools: [], auth: null });
  }

  const tools = designTools(validation.document);
  const apiEnvSlug = envSlug(validation.document.info?.title ?? "Generated API") || "API";
  const { binding } = deriveAuthBinding(validation.document, apiEnvSlug);

  res.json({
    valid: validation.valid,
    apiTitle: validation.document.info?.title ?? "Untitled API",
    issues: validation.issues,
    tools,
    auth: binding.kind === "none" ? null : { kind: binding.kind, envVar: binding.envVar, paramName: binding.paramName },
    // Passthrough (forwarding each caller's own token instead of one shared
    // credential) only makes sense for http-bearer schemes.
    passthroughAvailable: binding.kind === "bearer",
  });
});

app.post("/api/generate", async (req, res) => {
  const spec = specInput(req.body);
  const toolNames: unknown = req.body?.toolNames;
  const platform = req.body?.platform === "vercel" ? "vercel" : "node";
  const authMode = req.body?.authMode === "passthrough" ? "passthrough" : "static";

  if (!spec) return res.status(400).json({ error: SPEC_REQUIRED });
  if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== "string")) {
    return res.status(400).json({ error: "toolNames must be an array of strings." });
  }

  const validation = await validateSpec(spec, { untrusted: true });
  if (!validation.document) {
    return res.status(422).json({ error: "Spec failed to validate.", issues: validation.issues });
  }

  const selected = new Set(toolNames as string[]);
  const tools = designTools(validation.document).filter((t) => selected.has(t.name));

  if (tools.length === 0) {
    return res.status(400).json({ error: "No matching tools selected." });
  }

  const outDir = path.join(os.tmpdir(), `altship-mcp-${Date.now()}`);
  const generate = platform === "vercel" ? generateVercelServer : generateServer;
  const result = await generate({ document: validation.document, tools, outDir, authMode });

  res.json(result);
});

app.get("/api/deployments", async (req, res) => {
  res.json(await listDeployments(userIdOf(req)));
});

app.post("/api/deploy", async (req, res) => {
  const spec = specInput(req.body);
  const toolNames: unknown = req.body?.toolNames;
  const credentialValue: unknown = req.body?.credentialValue;
  const authMode: "static" | "passthrough" = req.body?.authMode === "passthrough" ? "passthrough" : "static";

  if (!spec) return res.status(400).json({ error: SPEC_REQUIRED });
  if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== "string")) {
    return res.status(400).json({ error: "toolNames must be an array of strings." });
  }

  let audience;
  try {
    audience = parseAudience(req.body?.audience);
  } catch (err) {
    if (err instanceof AudienceError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const validation = await validateSpec(spec, { untrusted: true });
  if (!validation.document) {
    return res.status(422).json({ error: "Spec failed to validate.", issues: validation.issues });
  }

  const selected = new Set(toolNames as string[]);
  const tools = designTools(validation.document).filter((t) => selected.has(t.name));
  if (tools.length === 0) {
    return res.status(400).json({ error: "No matching tools selected." });
  }

  const apiTitle = validation.document.info?.title ?? "Generated API";
  const name = serverName(req.body?.name) ?? apiTitle;
  const apiEnvSlug = envSlug(apiTitle) || "API";
  const forCustomers = audience === "customers";
  // For customers, each end user brings their own credential, so the shared
  // and passthrough modes don't apply.
  const { binding } = deriveAuthBinding(validation.document, apiEnvSlug, { passthrough: !forCustomers && authMode === "passthrough" });

  let connectSettings: ConnectSettings | null = null;
  if (forCustomers) {
    if (binding.kind === "none" || binding.kind === "passthrough") {
      return res.status(400).json({
        error: "To offer this server to your customers, the API's spec must declare how users authenticate (an API key, bearer token or basic auth).",
      });
    }
    const helpText = typeof req.body?.connectHelpText === "string" ? req.body.connectHelpText.trim().slice(0, 300) : "";
    connectSettings = { displayName: apiTitle, credentialKind: binding.kind, helpText: helpText || null };
  } else if (binding.kind !== "none" && binding.kind !== "passthrough" && (typeof credentialValue !== "string" || credentialValue.trim() === "")) {
    return res.status(400).json({ error: `This API requires a credential (${binding.envVar}) to deploy.` });
  }

  const outDir = path.join(os.tmpdir(), `altship-mcp-deploy-${Date.now()}`);

  try {
    const generated = await generateVercelServer({
      document: validation.document,
      tools,
      outDir,
      authMode: forCustomers ? "static" : authMode,
      perUserCredential: forCustomers,
    });

    const files: Record<string, string> = {};
    for (const relativePath of generated.filesWritten) {
      files[relativePath] = await readFile(path.join(outDir, relativePath), "utf8");
    }

    const projectName = `${apiEnvSlug.toLowerCase().replace(/_/g, "-")}-mcp-${randomUUID().slice(0, 8)}`;
    const project = await ensureProject(projectName);

    if (!forCustomers && binding.envVar && typeof credentialValue === "string") {
      await setProjectEnvVar(project.id, binding.envVar, credentialValue);
    }

    // Who may call the server. Private servers start with the owner's first
    // access key; servers for customers are reached only by signed-in end users.
    const accessKey = forCustomers ? null : generateAccessKey();
    await applyAccessEnv({
      audience,
      projectId: project.id,
      ownerId: userIdOf(req),
      memberIds: [],
      keyHashes: accessKey ? [hashAccessKey(accessKey)] : [],
    });

    // Where the server sends its tool-call telemetry (shown under Logs).
    for (const [key, value] of Object.entries(telemetryEnv(project.id))) {
      await setProjectEnvVar(project.id, key, value);
    }

    // Best-effort: gives the deployment a "<slug>.mcp.altship.io" URL
    // instead of a random *.vercel.app one. deployFiles() falls back
    // gracefully if this doesn't succeed (e.g. DNS not propagated yet).
    await assignMcpSubdomain(project);

    const deployment = await deployFiles(project, files);

    const record = {
      id: deployment.id,
      userId: userIdOf(req),
      audience,
      name,
      apiTitle,
      toolNames: tools.map((t) => t.name),
      projectName: project.name,
      projectId: project.id,
      url: deployment.url,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        destructive: t.destructive,
        sensitive: t.sensitive,
        inputSchema: t.inputSchema as unknown as Record<string, unknown>,
      })),
      authMode: forCustomers ? ("static" as const) : authMode,
      connectSettings,
      kind: "api" as const,
      collections: null,
    };
    await recordDeployment(record);
    if (accessKey) {
      await insertServerKey({
        id: newKeyId(),
        deploymentId: record.id,
        userId: record.userId,
        name: "Default",
        prefix: displayPrefix(accessKey),
        keyHash: hashAccessKey(accessKey),
      });
    }

    res.json({
      ...record,
      sourceDeploymentId: record.id,
      needsUpgrade: false,
      createdAt: new Date().toISOString(),
      mcpUrl: mcpEndpoint(record.url),
      accessKey,
      warnings: generated.warnings,
    });
  } catch (err) {
    if (err instanceof VercelConfigError || err instanceof AccessKeyConfigError || err instanceof AudienceError) {
      return res.status(500).json({ error: err.message });
    }
    console.error("Deploy failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Deployment failed." });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// Renames a server. An empty name goes back to the spec's title.
app.patch("/api/deployments/:id", async (req, res) => {
  if (typeof req.body?.name !== "string") return res.status(400).json({ error: "name must be a string." });
  const deployment = await renameDeployment(String(req.params.id), userIdOf(req), serverName(req.body.name));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  res.json(deployment);
});

// Upgrades a server deployed with older generated code (before access checks
// or call logging, say) to what's generated today, in place: same URL, keys
// and people. Its OpenAPI spec isn't kept, so the server's own files are
// fetched back from the host, the shared logic in them is replaced, and the
// result is deployed to the same project. If the new build fails, the host
// keeps serving the old one and nothing is recorded.
app.post("/api/deployments/:id/upgrade", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (!deployment.needsUpgrade) return res.json(deployment);
  // Checked first: an upgrade that can't be recorded would be undone by the next key change.
  if (!(await canRecordUpgrades())) {
    return res.status(500).json({ error: "The database is missing the columns upgrades are recorded in. Run the latest supabase-schema.sql, then try again." });
  }

  try {
    const files = await getDeploymentFiles(deployment.sourceDeploymentId);
    const upgraded = upgradeVercelServerFiles(files, { authMode: deployment.authMode ?? "static" });

    await applyAccessEnv({
      audience: deployment.audience,
      projectId: deployment.projectId,
      ownerId: deployment.userId,
      memberIds: await memberIds(deployment.id),
      keyHashes: await activeKeyHashes(deployment.id),
    });
    for (const [key, value] of Object.entries(telemetryEnv(deployment.projectId))) {
      await setProjectEnvVar(deployment.projectId, key, value);
    }

    const deployed = await deployFiles({ id: deployment.projectId, name: deployment.projectName }, upgraded);
    res.json(await markUpgraded(deployment.id, deployment.userId, deployed.id));
  } catch (err) {
    if (err instanceof UpgradeError) return res.status(400).json({ error: err.message });
    console.error("Upgrade failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Upgrade failed." });
  }
});

// ---- Memory stores (notes an LLM or agent can search and write, served over MCP) ----

/** The user's memory store with that id; answers 404 and returns null if there isn't one. */
async function ownMemoryStore(req: Request, res: Response): Promise<DeploymentRecord | null> {
  const store = await getDeployment(String(req.params.id), userIdOf(req));
  if (store?.kind === "memory") return store;
  res.status(404).json({ error: "Memory store not found." });
  return null;
}

/** Answers 400 for a mistake the user can fix (a note too long, a full store); rethrows anything else. */
function memoryFailure(res: Response, err: unknown) {
  if (err instanceof MemoryError) return res.status(400).json({ error: err.message });
  throw err;
}

// Creates a memory store: nothing to import or deploy, so it's ready at once.
app.post("/api/memory", async (req, res) => {
  const base = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
  if (!base) return res.status(500).json({ error: "Memory stores need API_PUBLIC_URL set, so they have an address." });
  const name = serverName(req.body?.name);
  if (!name) return res.status(400).json({ error: "Give the memory store a name." });
  const template = typeof req.body?.template === "string" && Object.hasOwn(MEMORY_TEMPLATES, req.body.template) ? req.body.template : "blank";

  const id = `mem_${randomBytes(12).toString("hex")}`;
  const tools = deployedMemoryTools();
  const accessKey = generateAccessKey();
  const record = {
    id,
    userId: userIdOf(req),
    audience: "private" as const,
    name,
    apiTitle: name,
    toolNames: tools.map((t) => t.name),
    projectName: `${envSlug(name).toLowerCase().replace(/_/g, "-") || "memory"}-${id.slice(4, 12)}`,
    // No hosting project: the id stands in, and altship's own key for the store is derived from it.
    projectId: id,
    url: `${base}/memory/${id}`,
    tools,
    authMode: "static" as const,
    connectSettings: null,
    kind: "memory" as const,
    collections: MEMORY_TEMPLATES[template],
  };
  await recordDeployment(record);
  await insertServerKey({
    id: newKeyId(),
    deploymentId: id,
    userId: record.userId,
    name: "Default",
    prefix: displayPrefix(accessKey),
    keyHash: hashAccessKey(accessKey),
  });
  res.status(201).json({
    ...record,
    sourceDeploymentId: id,
    needsUpgrade: false,
    createdAt: new Date().toISOString(),
    mcpUrl: mcpEndpoint(record.url),
    accessKey,
    warnings: [],
  });
});

// A store's collections and notes, for the dashboard. `q` searches; `collection` narrows.
app.get("/api/memory/:id/records", async (req, res) => {
  const store = await ownMemoryStore(req, res);
  if (!store) return;
  const collection = typeof req.query.collection === "string" && req.query.collection ? req.query.collection : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const [collections, records] = await Promise.all([
    collectionsOf(store),
    q ? searchRecords(store.id, q, { collection, limit: 50 }) : listRecords(store.id, { collection, limit: 100 }),
  ]);
  res.json({ collections, records });
});

app.post("/api/memory/:id/records", async (req, res) => {
  const store = await ownMemoryStore(req, res);
  if (!store) return;
  const { collection, title, body, tags } = noteFields(req.body);
  if (collection === undefined || title === undefined) return res.status(400).json({ error: "A note needs a collection and a title." });
  try {
    res.status(201).json(await saveRecord(store.id, { collection, title, body, tags }));
  } catch (err) {
    memoryFailure(res, err);
  }
});

app.patch("/api/memory/:id/records/:recordId", async (req, res) => {
  const store = await ownMemoryStore(req, res);
  if (!store) return;
  try {
    const updated = await updateRecord(store.id, String(req.params.recordId), noteFields(req.body));
    if (!updated) return res.status(404).json({ error: "Note not found." });
    res.json(updated);
  } catch (err) {
    memoryFailure(res, err);
  }
});

app.delete("/api/memory/:id/records/:recordId", async (req, res) => {
  const store = await ownMemoryStore(req, res);
  if (!store) return;
  if (!(await deleteRecord(store.id, String(req.params.recordId)))) return res.status(404).json({ error: "Note not found." });
  res.json({ ok: true });
});

// Works out the notes a document (Markdown, an essay, a few paragraphs) would
// become, without saving anything, so the user can look before adding them.
app.post("/api/memory/:id/import/preview", async (req, res) => {
  const store = await ownMemoryStore(req, res);
  if (!store) return;
  if (typeof req.body?.text !== "string") return res.status(400).json({ error: "Send the text to import." });
  try {
    res.json(await planImport(req.body.text, { collection: typeof req.body.collection === "string" ? req.body.collection : undefined, existing: await collectionsOf(store) }));
  } catch (err) {
    memoryFailure(res, err);
  }
});

// Saves the notes from a preview (as shown, or with some removed).
app.post("/api/memory/:id/import", async (req, res) => {
  const store = await ownMemoryStore(req, res);
  if (!store) return;
  const notes = (Array.isArray(req.body?.notes) ? req.body.notes : []).map(noteFields);
  if (notes.length === 0 || notes.length > MAX_IMPORT_NOTES || notes.some((n: ReturnType<typeof noteFields>) => n.collection === undefined || n.title === undefined)) {
    return res.status(400).json({ error: `Send 1 to ${MAX_IMPORT_NOTES} notes, each with a collection and a title.` });
  }
  try {
    res.status(201).json({ saved: await saveRecords(store.id, notes as { collection: string; title: string; body?: string; tags?: string[] }[]) });
  } catch (err) {
    memoryFailure(res, err);
  }
});

/** A note's fields from a request body: only the ones present and of the right type. */
function noteFields(body: unknown): { collection?: string; title?: string; body?: string; tags?: string[] } {
  const input = (body ?? {}) as Record<string, unknown>;
  return {
    ...(typeof input.collection === "string" ? { collection: input.collection } : {}),
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.body === "string" ? { body: input.body } : {}),
    ...(Array.isArray(input.tags) ? { tags: input.tags.filter((t): t is string => typeof t === "string") } : {}),
  };
}

// ---- Access keys ----------------------------------------------------------

app.get("/api/deployments/:id/keys", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  res.json(deployment.audience === "private" ? await listServerKeys(deployment.id, deployment.userId) : []);
});

// Creates a key and returns it in full -- the only time it's ever shown.
app.post("/api/deployments/:id/keys", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (deployment.audience !== "private") {
    return res.status(400).json({ error: "Servers for your customers don't use access keys; each person signs in with their own credential." });
  }
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : "Untitled key";

  const key = generateAccessKey();
  const record = await insertServerKey({
    id: newKeyId(),
    deploymentId: deployment.id,
    userId: deployment.userId,
    name,
    prefix: displayPrefix(key),
    keyHash: hashAccessKey(key),
  });
  await syncAccessKeys(deployment);
  res.status(201).json({ ...record, key });
});

app.delete("/api/deployments/:id/keys/:keyId", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (!(await revokeServerKey(String(req.params.keyId), deployment.id, deployment.userId))) {
    return res.status(404).json({ error: "Access key not found." });
  }
  await syncAccessKeys(deployment);
  res.json({ ok: true });
});

// ---- End-user connections (servers for your customers) -------------------

app.get("/api/deployments/:id/connections", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  res.json(deployment.audience === "customers" ? await listConnections(deployment.id) : []);
});

app.delete("/api/deployments/:id/connections/:connectionId", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (!(await revokeConnection(String(req.params.connectionId), deployment.id))) {
    return res.status(404).json({ error: "Connection not found." });
  }
  res.json({ ok: true });
});

// ---- Logs (tool calls on the user's servers) ------------------------------

const MAX_LOG_PAGE = 200;

// The most recent tool calls, newest first, on one server (?deploymentId=) or
// all of the user's. `before` (a call's time) pages further back.
app.get("/api/logs", async (req, res) => {
  const deploymentId = typeof req.query.deploymentId === "string" ? req.query.deploymentId : null;
  let deployments: DeploymentRecord[];
  if (deploymentId) {
    const deployment = await getDeployment(deploymentId, userIdOf(req));
    if (!deployment) return res.status(404).json({ error: "MCP server not found." });
    deployments = [deployment];
  } else {
    deployments = await listDeployments(userIdOf(req));
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LOG_PAGE);
  const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
  // Only what the account's plan keeps is shown (older calls are deleted daily).
  const plan = await planOf(userIdOf(req));
  // One extra row tells us whether there's another page.
  const rows = await listToolCalls(deployments.map((d) => d.id), { limit: limit + 1, before, since: retentionCutoff(plan) });
  const calls = rows.slice(0, limit);
  const callerLabel = await callerLabeller(deployments, calls, confirmedEmailOf(req));
  const byId = new Map(deployments.map((d) => [d.id, d]));

  res.json({
    calls: calls.map((call) => ({
      id: call.id,
      deploymentId: call.deploymentId,
      serverName: byId.get(call.deploymentId)?.name ?? "",
      startedAt: call.startedAt,
      tool: call.tool,
      ok: call.ok,
      errorType: call.errorType,
      httpStatus: call.httpStatus,
      durationMs: call.durationMs,
      traceId: call.traceId,
      caller: { kind: call.callerKind, id: call.callerId, label: callerLabel(call) },
    })),
    nextBefore: rows.length > limit ? calls[calls.length - 1].startedAt : null,
    plan,
    retentionDays: PLANS[plan].retentionDays,
  });
});

/**
 * Names the caller of each call for the owner: which access key (by the hash
 * prefix the server recorded), which altship user, or which end-user connection.
 */
async function callerLabeller(deployments: DeploymentRecord[], calls: ToolCallRecord[], ownerEmail: string | null) {
  const ids = deployments.map((d) => d.id);
  const endUserIds = [...new Set(calls.filter((c) => c.callerKind === "end-user" && c.callerId).map((c) => c.callerId!))];
  const [keys, members, connections] = await Promise.all([
    listKeyHashes(ids),
    listMembersOf(ids),
    endUserIds.length
      ? getSupabase().from("end_user_connections").select("id,credential_hint").in("id", endUserIds)
      : Promise.resolve({ data: [] as Array<{ id: string; credential_hint: string }>, error: null }),
  ]);
  if (connections.error) throw new Error(`Failed to load connections: ${connections.error.message}`);
  const hints = new Map((connections.data ?? []).map((c) => [c.id, c.credential_hint]));
  const internalHashes = new Map<string, string>();
  for (const d of deployments) {
    try {
      internalHashes.set(d.id, hashAccessKey(internalAccessKey(d.projectId)));
    } catch {
      // No internal key configured: Agent Creator's calls show as an unknown key.
    }
  }
  const owners = new Map(deployments.map((d) => [d.id, d.userId]));

  return (call: ToolCallRecord): string => {
    const id = call.callerId;
    switch (call.callerKind) {
      case "key": {
        if (!id) return "Access key";
        const key = keys.find((k) => k.deploymentId === call.deploymentId && k.keyHash.startsWith(id));
        if (key) return `Access key "${key.name}"${key.revoked ? " (revoked)" : ""}`;
        return internalHashes.get(call.deploymentId)?.startsWith(id) ? "altship Agent Creator" : "Unknown access key";
      }
      case "user": {
        if (id && id === owners.get(call.deploymentId)) return ownerEmail ? `${ownerEmail} (you)` : "You";
        const member = members.find((m) => m.deploymentId === call.deploymentId && m.userId === id);
        return member ? member.email : "Removed user";
      }
      case "end-user":
        return id && hints.has(id) ? `End user ${hints.get(id)}` : "End user";
      case "local":
        return "Local (stdio)";
      default:
        return "Unauthenticated";
    }
  };
}

// ---- People (other altship users who may sign in to a private server) ----
// The owner invites an email address; whoever signs in with that address and
// opens the invite link becomes a member.

const MAX_MEMBERS = 50;

app.get("/api/deployments/:id/members", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (deployment.audience !== "private") return res.json({ members: [], invites: [] });
  const [members, invites] = await Promise.all([listMembers(deployment.id), listPendingInvites(deployment.id)]);
  res.json({ members, invites: invites.map(inviteView) });
});

app.post("/api/deployments/:id/invites", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (deployment.audience !== "private") {
    return res.status(400).json({ error: "Servers for your customers don't have people to invite; each person signs in with their own credential." });
  }
  if (deployment.authMode === "passthrough") {
    return res.status(400).json({ error: "This server forwards each caller's own token, so it has no altship sign-in. Share an access key instead." });
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  const ownerEmail = confirmedEmailOf(req);
  if (email === ownerEmail) {
    return res.status(400).json({ error: "That's you. As the owner you can already sign in to this server." });
  }

  const [members, pending] = await Promise.all([listMembers(deployment.id), listPendingInvites(deployment.id)]);
  if (members.some((m) => m.email === email)) {
    return res.status(400).json({ error: "That person already has access." });
  }
  if (!pending.some((i) => i.email === email) && members.length + pending.length >= MAX_MEMBERS) {
    return res.status(400).json({ error: `A server can have up to ${MAX_MEMBERS} people, including pending invites.` });
  }

  const { invite, created } = await createInvite({ id: newInviteId(), deploymentId: deployment.id, email });
  // An invite that was already pending isn't emailed again.
  const emailed = created
    ? await sendInviteEmail({ to: email, inviterEmail: ownerEmail, serverName: deployment.name, link: inviteLink(invite.id) })
    : false;
  res.status(201).json({ ...inviteView(invite), emailed });
});

app.delete("/api/deployments/:id/invites/:inviteId", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  if (!(await cancelInvite(String(req.params.inviteId), deployment.id))) {
    return res.status(404).json({ error: "Invite not found." });
  }
  res.json({ ok: true });
});

app.delete("/api/deployments/:id/members/:userId", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
  const userId = String(req.params.userId);
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !(await removeMember(deployment.id, userId))) {
    return res.status(404).json({ error: "Person not found." });
  }
  await deleteAcceptedInvites(deployment.id, userId);
  await syncAccessKeys(deployment);
  res.json({ ok: true });
});

// Accepting an invite: any signed-in user, but only the one it was sent to.
app.post("/api/invites/:id/accept", async (req, res) => {
  const invite = await getInvite(String(req.params.id));
  const deployment = invite ? await getDeploymentById(invite.deploymentId) : null;
  if (!invite || !deployment || deployment.audience !== "private") {
    return res.status(404).json({ error: "This invite doesn't exist or was cancelled." });
  }
  const email = confirmedEmailOf(req);
  if (!email) {
    return res.status(403).json({ error: "Confirm your email address first, then open the invite link again." });
  }
  if (email !== invite.email) {
    return res.status(403).json({ error: `This invite was sent to ${invite.email}, and you're signed in as ${email}. Sign in with that account to accept it.` });
  }

  const userId = userIdOf(req);
  if (invite.acceptedBy !== userId) {
    // Marked accepted last, so opening the link again retries a failed server update.
    await addMember({ deploymentId: deployment.id, userId, email });
    await syncAccessKeys(deployment);
    await markInviteAccepted(invite.id, userId);
  }
  res.json({ name: deployment.name, mcpUrl: mcpEndpoint(deployment.url), toolCount: deployment.toolNames.length });
});

function inviteView(invite: InviteRecord) {
  return { id: invite.id, email: invite.email, createdAt: invite.createdAt, link: inviteLink(invite.id) };
}

function newInviteId(): string {
  return `inv_${randomBytes(16).toString("hex")}`;
}

/** Pushes the deployment's current access settings (keys and people) to its env and redeploys so they take effect. */
async function syncAccessKeys(deployment: DeploymentRecord) {
  // A memory store checks keys and people against the database on every request: nothing to push.
  if (deployment.kind === "memory") return;
  await applyAccessEnv({
    audience: deployment.audience,
    projectId: deployment.projectId,
    ownerId: deployment.userId,
    memberIds: await memberIds(deployment.id),
    keyHashes: await activeKeyHashes(deployment.id),
  });
  await redeploy({ id: deployment.projectId, name: deployment.projectName }, deployment.sourceDeploymentId);
}

const MAX_SERVER_NAME = 80;

/** A server name as the owner typed it: one line, trimmed, capped. Null when there's nothing left. */
function serverName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_SERVER_NAME) || null;
}

function newKeyId(): string {
  return `key_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Generated Vercel servers serve MCP at /api/mcp. */
function mcpEndpoint(url: string): string {
  return `${url.replace(/\/$/, "")}/api/mcp`;
}

// Unhandled errors come back as JSON (Express's default is an HTML page,
// which the dashboard can't show).
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  console.error("API error:", err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Something went wrong." });
});

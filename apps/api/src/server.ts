import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { validateSpec, type SpecInput } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer, generateVercelServer, deriveAuthBinding, envSlug } from "@altship/mcp-gen";
import { ensureProject, setProjectEnvVar, assignMcpSubdomain, deployFiles, redeploy, VercelConfigError } from "./vercel-client.js";
import {
  recordDeployment,
  listDeployments,
  getDeployment,
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
  type ConnectSettings,
  type DeploymentRecord,
  type InviteRecord,
} from "./store.js";
import { AccessKeyConfigError, displayPrefix, generateAccessKey, hashAccessKey } from "./access-keys.js";
import { AudienceError, applyAccessEnv, parseAudience } from "./server-access.js";
import { confirmedEmailOf, requireAuth, userIdOf } from "./auth.js";
import { inviteLink, sendInviteEmail } from "./email.js";
import { agentsRouter, agentsErrorHandler } from "./agents/router.js";
import { endUsersRouter } from "./end-users/router.js";
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
app.use(cors({ origin: allowedOrigins }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/agents", agentsRouter, agentsErrorHandler);

// Everything else is the MCP Creator dashboard API: signed-in users only.
app.use(["/api/tools", "/api/generate", "/api/deployments", "/api/deploy", "/api/invites"], requireAuth);

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

    // Best-effort: gives the deployment a "<slug>.mcp.altship.io" URL
    // instead of a random *.vercel.app one. deployFiles() falls back
    // gracefully if this doesn't succeed (e.g. DNS not propagated yet).
    await assignMcpSubdomain(project);

    const deployment = await deployFiles(project, files);

    const record = {
      id: deployment.id,
      userId: userIdOf(req),
      audience,
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
    ? await sendInviteEmail({ to: email, inviterEmail: ownerEmail, serverName: deployment.apiTitle, link: inviteLink(invite.id) })
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
  res.json({ apiTitle: deployment.apiTitle, mcpUrl: mcpEndpoint(deployment.url), toolCount: deployment.toolNames.length });
});

function inviteView(invite: InviteRecord) {
  return { id: invite.id, email: invite.email, createdAt: invite.createdAt, link: inviteLink(invite.id) };
}

function newInviteId(): string {
  return `inv_${randomBytes(16).toString("hex")}`;
}

/** Pushes the deployment's current access settings (keys and people) to its env and redeploys so they take effect. */
async function syncAccessKeys(deployment: DeploymentRecord) {
  await applyAccessEnv({
    audience: deployment.audience,
    projectId: deployment.projectId,
    ownerId: deployment.userId,
    memberIds: await memberIds(deployment.id),
    keyHashes: await activeKeyHashes(deployment.id),
  });
  await redeploy({ id: deployment.projectId, name: deployment.projectName }, deployment.id);
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

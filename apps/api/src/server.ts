import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { validateSpec } from "@altship/openapi";
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
  type DeploymentRecord,
} from "./store.js";
import {
  AccessKeyConfigError,
  displayPrefix,
  generateAccessKey,
  hashAccessKey,
  internalAccessKey,
  oauthIssuer,
} from "./access-keys.js";
import { requireAuth, userIdOf } from "./auth.js";
import { agentsRouter, agentsErrorHandler } from "./agents/router.js";

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

export const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/agents", agentsRouter, agentsErrorHandler);

// Everything else is the MCP Creator dashboard API: signed-in users only.
app.use(["/api/tools", "/api/generate", "/api/deployments", "/api/deploy"], requireAuth);

app.post("/api/tools", async (req, res) => {
  const spec = req.body?.spec;
  if (typeof spec !== "string" || spec.trim() === "") {
    return res.status(400).json({ error: "Missing required field: spec (URL or file path)." });
  }

  const validation = await validateSpec(spec);
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
  const spec = req.body?.spec;
  const toolNames: unknown = req.body?.toolNames;
  const platform = req.body?.platform === "vercel" ? "vercel" : "node";
  const authMode = req.body?.authMode === "passthrough" ? "passthrough" : "static";

  if (typeof spec !== "string" || spec.trim() === "") {
    return res.status(400).json({ error: "Missing required field: spec (URL or file path)." });
  }
  if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== "string")) {
    return res.status(400).json({ error: "toolNames must be an array of strings." });
  }

  const validation = await validateSpec(spec);
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
  const spec = req.body?.spec;
  const toolNames: unknown = req.body?.toolNames;
  const credentialValue: unknown = req.body?.credentialValue;
  const authMode: "static" | "passthrough" = req.body?.authMode === "passthrough" ? "passthrough" : "static";

  if (typeof spec !== "string" || spec.trim() === "") {
    return res.status(400).json({ error: "Missing required field: spec (URL or file path)." });
  }
  if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== "string")) {
    return res.status(400).json({ error: "toolNames must be an array of strings." });
  }

  const validation = await validateSpec(spec);
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
  const { binding } = deriveAuthBinding(validation.document, apiEnvSlug, { passthrough: authMode === "passthrough" });

  if (binding.kind !== "none" && binding.kind !== "passthrough" && (typeof credentialValue !== "string" || credentialValue.trim() === "")) {
    return res.status(400).json({ error: `This API requires a credential (${binding.envVar}) to deploy.` });
  }

  const outDir = path.join(os.tmpdir(), `altship-mcp-deploy-${Date.now()}`);

  try {
    const generated = await generateVercelServer({ document: validation.document, tools, outDir, authMode });

    const files: Record<string, string> = {};
    for (const relativePath of generated.filesWritten) {
      files[relativePath] = await readFile(path.join(outDir, relativePath), "utf8");
    }

    const projectName = `${apiEnvSlug.toLowerCase().replace(/_/g, "-")}-mcp-${randomUUID().slice(0, 8)}`;
    const project = await ensureProject(projectName);

    if (binding.envVar && typeof credentialValue === "string") {
      await setProjectEnvVar(project.id, binding.envVar, credentialValue);
    }

    // Who may call the server: the owner's first access key, altship's own
    // (Agent Creator) key, and the owner signed in through OAuth.
    const accessKey = generateAccessKey();
    await setProjectEnvVar(
      project.id,
      "MCP_ACCESS_KEY_SHA256",
      [hashAccessKey(accessKey), hashAccessKey(internalAccessKey(project.id))].join(","),
    );
    await setProjectEnvVar(project.id, "MCP_OAUTH_ISSUER", oauthIssuer());
    await setProjectEnvVar(project.id, "MCP_OAUTH_ALLOWED_SUBJECTS", userIdOf(req));

    // Best-effort: gives the deployment a "<slug>.mcp.altship.io" URL
    // instead of a random *.vercel.app one. deployFiles() falls back
    // gracefully if this doesn't succeed (e.g. DNS not propagated yet).
    await assignMcpSubdomain(project);

    const deployment = await deployFiles(project, files);

    const record = {
      id: deployment.id,
      userId: userIdOf(req),
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
      authMode,
    };
    await recordDeployment(record);
    await insertServerKey({
      id: newKeyId(),
      deploymentId: record.id,
      userId: record.userId,
      name: "Default",
      prefix: displayPrefix(accessKey),
      keyHash: hashAccessKey(accessKey),
    });

    res.json({
      ...record,
      createdAt: new Date().toISOString(),
      mcpUrl: mcpEndpoint(record.url),
      accessKey,
      warnings: generated.warnings,
    });
  } catch (err) {
    if (err instanceof VercelConfigError || err instanceof AccessKeyConfigError) {
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
  res.json(await listServerKeys(deployment.id, deployment.userId));
});

// Creates a key and returns it in full -- the only time it's ever shown.
app.post("/api/deployments/:id/keys", async (req, res) => {
  const deployment = await getDeployment(String(req.params.id), userIdOf(req));
  if (!deployment) return res.status(404).json({ error: "MCP server not found." });
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

/** Pushes the deployment's current key hashes to its env and redeploys so they take effect. */
async function syncAccessKeys(deployment: DeploymentRecord) {
  const hashes = [...(await activeKeyHashes(deployment.id)), hashAccessKey(internalAccessKey(deployment.projectId))];
  await setProjectEnvVar(deployment.projectId, "MCP_ACCESS_KEY_SHA256", hashes.join(","));
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

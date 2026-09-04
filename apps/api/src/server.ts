import "dotenv/config";
import express from "express";
import cors from "cors";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer, generateVercelServer, deriveAuthBinding, envSlug } from "@altship/mcp-gen";
import { ensureProject, setProjectEnvVar, deployFiles, VercelConfigError } from "./vercel-client.js";
import { recordDeployment, listDeployments } from "./store.js";
import { requireAuth } from "./auth-middleware.js";

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

export const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

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

app.post("/api/generate", requireAuth, async (req, res) => {
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

app.get("/api/deployments", requireAuth, async (req, res) => {
  res.json(await listDeployments(req.userId!));
});

app.post("/api/deploy", requireAuth, async (req, res) => {
  const spec = req.body?.spec;
  const toolNames: unknown = req.body?.toolNames;
  const credentialValue: unknown = req.body?.credentialValue;
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

    const deployment = await deployFiles(project, files);

    const record = {
      id: deployment.id,
      userId: req.userId!,
      apiTitle,
      toolNames: tools.map((t) => t.name),
      projectName: project.name,
      projectId: project.id,
      url: deployment.url,
    };
    await recordDeployment(record);

    res.json({ ...record, createdAt: new Date().toISOString(), warnings: generated.warnings });
  } catch (err) {
    if (err instanceof VercelConfigError) {
      return res.status(500).json({ error: err.message });
    }
    console.error("Deploy failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Deployment failed." });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});


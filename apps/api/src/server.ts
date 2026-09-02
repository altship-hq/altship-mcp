import express from "express";
import os from "node:os";
import path from "node:path";
import { validateSpec } from "@altship/openapi";
import { designTools } from "@altship/tool-design";
import { generateServer, generateVercelServer } from "@altship/mcp-gen";

const app = express();
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
    return res.json({ valid: false, apiTitle: null, issues: validation.issues, tools: [] });
  }

  const tools = designTools(validation.document);

  res.json({
    valid: validation.valid,
    apiTitle: validation.document.info?.title ?? "Untitled API",
    issues: validation.issues,
    tools,
  });
});

app.post("/api/generate", async (req, res) => {
  const spec = req.body?.spec;
  const toolNames: unknown = req.body?.toolNames;
  const platform = req.body?.platform === "vercel" ? "vercel" : "node";

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
  const result = await generate({ document: validation.document, tools, outDir });

  res.json(result);
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`altship-mcp API listening on http://localhost:${port}`);
});

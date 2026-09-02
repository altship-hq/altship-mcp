// Wraps a generated Vercel project's api/*.ts handlers in a plain Node HTTP
// server so they can be exercised without an actual Vercel deployment.
// Only used by tests -- not part of any generated output.
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

const projectDir = process.env.MCP_PROJECT_DIR;
const port = Number(process.env.PORT ?? 0);

const { default: mcpHandler } = await import(pathToFileURL(path.join(projectDir, "api/mcp.ts")).href);
const { default: healthHandler } = await import(pathToFileURL(path.join(projectDir, "api/health.ts")).href);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };

    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/health") healthHandler(req, res);
    else mcpHandler(req, res);
  });
});

server.listen(port, () => {
  console.log(`VERCEL_HARNESS_READY ${server.address().port}`);
});

import { PlaygroundSession } from "@altship/playground";
import type { CatalogServer, CatalogTool, ToolCatalog } from "@altship/agent-design";
import { listDeployments, type DeploymentRecord } from "../store.js";
import { internalAccessKey } from "../access-keys.js";

export interface CatalogEntry extends CatalogServer {
  deploymentId: string;
  /** Hosting project, which altship's own access key for the server is derived from. */
  projectId: string;
}

export interface UnavailableServer {
  deploymentId: string;
  title: string;
  reason: string;
}

/**
 * The MCP servers agents can use: the user's MCP Creator deployments.
 * Tools come from what was stored at deploy time, or — for deployments
 * recorded before that — a live `tools/list` against the server.
 */
export async function loadCatalog(userId: string): Promise<{ servers: CatalogEntry[]; unavailable: UnavailableServer[] }> {
  const deployments = await listDeployments(userId);
  const servers: CatalogEntry[] = [];
  const unavailable: UnavailableServer[] = [];

  await Promise.all(
    deployments.map(async (d) => {
      if (d.authMode === "passthrough") {
        unavailable.push({
          deploymentId: d.id,
          title: d.apiTitle,
          reason: "Uses per-user auth; agents can't supply a caller token yet.",
        });
        return;
      }
      try {
        servers.push({
          deploymentId: d.id,
          projectId: d.projectId,
          name: d.projectName,
          title: d.apiTitle,
          url: mcpEndpoint(d),
          tools: d.tools?.map(toCatalogTool) ?? (await listLiveTools(d)),
        });
      } catch (err) {
        unavailable.push({
          deploymentId: d.id,
          title: d.apiTitle,
          reason: `Couldn't list its tools: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );

  servers.sort((a, b) => a.title.localeCompare(b.title));
  return { servers, unavailable };
}

export function toToolCatalog(servers: CatalogEntry[]): ToolCatalog {
  return servers.map(({ name, title, url, tools }) => ({ name, title, url, tools }));
}

/** Generated Vercel servers serve MCP at /api/mcp. */
function mcpEndpoint(d: DeploymentRecord): string {
  return `${d.url.replace(/\/$/, "")}/api/mcp`;
}

function toCatalogTool(t: NonNullable<DeploymentRecord["tools"]>[number]): CatalogTool {
  return { name: t.name, description: t.description, destructive: t.destructive, sensitive: t.sensitive };
}

async function listLiveTools(d: DeploymentRecord): Promise<CatalogTool[]> {
  const session = await withTimeout(
    PlaygroundSession.connect({ url: mcpEndpoint(d), headers: { authorization: `Bearer ${internalAccessKey(d.projectId)}` } }),
    10_000,
  );
  try {
    const tools = await withTimeout(session.listTools(), 10_000);
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      destructive: t.annotations?.destructiveHint === true,
      sensitive: false,
    }));
  } finally {
    await session.close().catch(() => {});
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms)),
  ]);
}

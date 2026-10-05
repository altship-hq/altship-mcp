import { PlaygroundSession } from "@altship/playground";
import type { AgentPlan, CatalogServer, CatalogTool, ToolCatalog } from "@altship/agent-design";
import { listDeployments, type DeploymentRecord } from "../store.js";
import { internalAccessKey } from "../access-keys.js";
import { deployedMemoryTools } from "../memory/tools.js";
import { AppsConfigError, ensureAgentSession, relayToken, relayUrl, sessionMcp } from "../apps/composio.js";

export interface CatalogEntry extends CatalogServer {
  /** The deployment's id, or "apps:<session id>" for the user's connected apps. */
  deploymentId: string;
  /** The bearer token agents present to the server: held in the agent's vault, never sent to the dashboard. */
  token: string;
}

/** A catalog entry as the dashboard sees it. */
export function publicEntry({ token: _token, ...entry }: CatalogEntry): Omit<CatalogEntry, "token"> {
  return entry;
}

/** What the connected-apps server is called in plans and to the agent runtime. */
export const APPS_SERVER_NAME = "connected-apps";

/**
 * The user's connected apps as one catalog server: the tools of the apps
 * chosen for an agent, served through altship's relay. Tools that aren't
 * marked read-only are flagged sensitive, and destructive ones always ask.
 */
export async function appsCatalogEntry(userId: string, toolkits: string[]): Promise<CatalogEntry> {
  const sessionId = await ensureAgentSession(userId, toolkits);
  const url = relayUrl(sessionId);
  if (!url) throw new AppsConfigError("Connected apps need API_PUBLIC_URL set, so agents can reach them.");

  // Listed straight from the provider; agents go through the relay.
  const mcp = await sessionMcp(sessionId);
  const session = await withTimeout(PlaygroundSession.connect({ url: mcp.url, headers: mcp.headers }), 20_000);
  try {
    const tools = await withTimeout(session.listTools(), 20_000);
    return {
      deploymentId: `apps:${sessionId}`,
      token: relayToken(sessionId),
      name: APPS_SERVER_NAME,
      title: "Connected apps",
      url,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        destructive: t.annotations?.destructiveHint === true,
        sensitive: t.annotations?.readOnlyHint !== true,
      })),
    };
  } finally {
    await session.close().catch(() => {});
  }
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
      if (d.audience === "customers") {
        unavailable.push({
          deploymentId: d.id,
          title: d.name,
          reason: "Offered to your customers; each person signs in with their own credential.",
        });
        return;
      }
      if (d.authMode === "passthrough") {
        unavailable.push({
          deploymentId: d.id,
          title: d.name,
          reason: "Uses per-user auth; agents can't supply a caller token yet.",
        });
        return;
      }
      try {
        servers.push({
          deploymentId: d.id,
          token: internalAccessKey(d.projectId),
          name: d.projectName,
          title: d.name,
          url: mcpEndpoint(d),
          // A memory's tools are altship's own, so they're read from the code, not from what was stored when it was created.
          tools: d.kind === "memory" ? deployedMemoryTools().map(toCatalogTool) : (d.tools?.map(toCatalogTool) ?? (await listLiveTools(d))),
        });
      } catch (err) {
        unavailable.push({
          deploymentId: d.id,
          title: d.name,
          reason: `Couldn't list its tools: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );

  servers.sort((a, b) => a.title.localeCompare(b.title));
  return { servers, unavailable };
}

/** The catalog servers whose tools a plan actually uses (an agent may use none). */
export function serversUsedBy(plan: AgentPlan, servers: CatalogEntry[]): CatalogEntry[] {
  const names = new Set(plan.agents.flatMap((a) => a.tools.map((t) => t.server)));
  return servers.filter((s) => names.has(s.name));
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

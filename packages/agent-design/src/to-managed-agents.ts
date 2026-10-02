import type { AgentPlan, PlannedAgent, ToolCatalog } from "./types.js";

// Translates an AgentPlan into Managed Agents `agents.create` bodies. Kept
// free of the Anthropic SDK so it stays testable; the API casts these to the
// SDK's param type. Shapes follow the Managed Agents docs: MCP servers are
// declared on the agent without auth, and an `mcp_toolset` allowlists the
// planned tools with a per-tool permission policy.

export interface ManagedAgentMcpServer {
  type: "url";
  name: string;
  url: string;
}

export interface ManagedAgentMcpToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config: { enabled: false };
  configs: { name: string; enabled: true; permission_policy: { type: "always_allow" | "always_ask" } }[];
}

export interface ManagedAgentParams {
  name: string;
  description: string;
  model: string;
  system: string;
  mcp_servers: ManagedAgentMcpServer[];
  tools: ManagedAgentMcpToolset[];
}

export interface ManagedAgentPlanParams {
  /** Created first; their IDs form the coordinator's roster. Empty for a single-agent plan. */
  specialists: { key: string; params: ManagedAgentParams }[];
  /** The session's primary agent: the coordinator of a team, or the only agent. */
  primary: { key: string; params: ManagedAgentParams };
}

export function toManagedAgentParams(plan: AgentPlan, catalog: ToolCatalog): ManagedAgentPlanParams {
  const primary = plan.agents.find((a) => a.role === "coordinator" || a.role === "solo") ?? plan.agents[0];
  const specialists = plan.agents.filter((a) => a !== primary);

  return {
    specialists: specialists.map((a) => ({ key: a.key, params: agentParams(a, catalog) })),
    primary: { key: primary.key, params: agentParams(primary, catalog) },
  };
}

/** The coordinator's roster, added after the specialists exist. */
export function coordinatorRoster(specialistIds: { id: string; version: number }[]) {
  return {
    type: "coordinator" as const,
    agents: specialistIds.map(({ id, version }) => ({ type: "agent" as const, id, version })),
  };
}

function agentParams(agent: PlannedAgent, catalog: ToolCatalog): ManagedAgentParams {
  const byServer = new Map<string, PlannedAgent["tools"]>();
  for (const tool of agent.tools) {
    byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool]);
  }

  const mcp_servers: ManagedAgentMcpServer[] = [];
  const tools: ManagedAgentMcpToolset[] = [];
  for (const [serverName, serverTools] of byServer) {
    const server = catalog.find((s) => s.name === serverName);
    if (!server) continue; // validatePlan already dropped tools on unknown servers
    mcp_servers.push({ type: "url", name: server.name, url: server.url });
    tools.push({
      type: "mcp_toolset",
      mcp_server_name: server.name,
      default_config: { enabled: false },
      configs: serverTools.map((t) => ({
        name: t.tool,
        enabled: true,
        permission_policy: { type: t.permission === "ask" ? "always_ask" : "always_allow" },
      })),
    });
  }

  return {
    name: agent.name,
    description: agent.description || agent.name,
    model: agent.model,
    system: agent.instructions,
    mcp_servers,
    tools,
  };
}

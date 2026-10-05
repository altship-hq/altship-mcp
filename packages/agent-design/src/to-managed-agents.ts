import type { AgentPlan, BuiltinTool, PlannedAgent, ToolCatalog } from "./types.js";

// Translates an AgentPlan into Managed Agents `agents.create` bodies. Kept
// free of the Anthropic SDK so it stays testable; the API casts these to the
// SDK's param type. Shapes follow the Managed Agents docs: MCP servers are
// declared on the agent without auth, and an `mcp_toolset` allowlists the
// planned tools with a per-tool permission policy. Built-in tools (web,
// sandbox) go in one `agent_toolset_20260401`, also allowlisted.

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

/** Built-in tools (web, sandbox): only the planned ones are enabled. */
export interface ManagedAgentBuiltinToolset {
  type: "agent_toolset_20260401";
  default_config: { enabled: false };
  configs: { name: BuiltinTool; enabled: true; permission_policy: { type: "always_allow" | "always_ask" } }[];
}

export interface ManagedAgentParams {
  name: string;
  description: string;
  model: string;
  system: string;
  mcp_servers: ManagedAgentMcpServer[];
  tools: (ManagedAgentMcpToolset | ManagedAgentBuiltinToolset)[];
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

/**
 * The agent's instructions plus how it should work with whoever it's talking
 * to, which every agent needs and plans shouldn't have to restate. Tools set
 * to "ask" are paused for approval by the platform, so an agent that also
 * asks in the conversation makes the user confirm the same thing twice.
 */
function withWorkingNotes(agent: PlannedAgent): string {
  const asks = [...agent.tools, ...(agent.builtinTools ?? [])].some((t) => t.permission === "ask");
  const notes = [
    "Do the work before you reply: use your tools as far as they'll take you, then answer once with the result. Skip running commentary on each step; whoever you're working for sees your tool calls already. Stop to ask only for something you can't find out or decide yourself.",
    ...(asks
      ? [
          "Some of your tools need approval before they run. The platform shows the request and waits for a yes or no when you call one, so don't ask for permission in the conversation first. If you were asked to do the thing, call the tool; if it's declined, say so and stop.",
        ]
      : []),
  ];
  return `${agent.instructions}\n\n## How you work\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

function agentParams(agent: PlannedAgent, catalog: ToolCatalog): ManagedAgentParams {
  const byServer = new Map<string, PlannedAgent["tools"]>();
  for (const tool of agent.tools) {
    byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool]);
  }

  const mcp_servers: ManagedAgentMcpServer[] = [];
  const tools: ManagedAgentParams["tools"] = [];

  const builtins = agent.builtinTools ?? [];
  if (builtins.length > 0) {
    tools.push({
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: builtins.map((t) => ({
        name: t.tool,
        enabled: true,
        permission_policy: { type: t.permission === "ask" ? "always_ask" : "always_allow" },
      })),
    });
  }
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
    system: withWorkingNotes(agent),
    mcp_servers,
    tools,
  };
}

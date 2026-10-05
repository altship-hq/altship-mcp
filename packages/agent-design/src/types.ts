/** Models an agent in a plan may run on. First entry is the default. */
export const AGENT_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** "auto" runs the tool without asking; "ask" pauses for a human to approve each call. */
export type ToolPermission = "auto" | "ask";

/**
 * Built-in tools every agent can be given, independent of any MCP server
 * (Managed Agents' agent_toolset_20260401). Web tools run on Anthropic's
 * servers; the rest act on the session's own sandboxed container.
 */
export const BUILTIN_TOOLS = ["web_search", "web_fetch", "bash", "read", "write", "edit", "glob", "grep"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** How the built-in tools are offered to users: switched on in these groups. */
export const BUILTIN_GROUPS = {
  web: ["web_search", "web_fetch"],
  sandbox: ["bash", "read", "write", "edit", "glob", "grep"],
} as const satisfies Record<string, readonly BuiltinTool[]>;
export type BuiltinGroup = keyof typeof BUILTIN_GROUPS;

/** One tool an MCP server offers, as the planner sees it. */
export interface CatalogTool {
  name: string;
  description: string;
  destructive: boolean;
  sensitive: boolean;
}

/** An MCP server the user can give their agents (today: their MCP Creator deployments). */
export interface CatalogServer {
  /** Unique slug; also the Managed Agents `mcp_server_name`. */
  name: string;
  /** Human-readable name, e.g. the API title. */
  title: string;
  /** Streamable HTTP MCP endpoint. */
  url: string;
  tools: CatalogTool[];
}

export type ToolCatalog = CatalogServer[];

export interface PlannedTool {
  /** CatalogServer.name */
  server: string;
  /** CatalogTool.name */
  tool: string;
  permission: ToolPermission;
  /** Why the agent needs it — shown to the user on review. */
  reason: string;
}

export interface PlannedBuiltinTool {
  tool: BuiltinTool;
  permission: ToolPermission;
  /** Why the agent needs it — shown to the user on review. */
  reason: string;
}

export interface PlannedAgent {
  /** Stable id within the plan (slug). */
  key: string;
  name: string;
  /** "solo" for a single-agent plan; a team has one "coordinator" and one or more "specialist"s. */
  role: "solo" | "coordinator" | "specialist";
  model: AgentModel;
  /** What this agent is good at — the coordinator reads it when deciding whom to delegate to. */
  description: string;
  /** System prompt. */
  instructions: string;
  /** Tools from MCP servers. */
  tools: PlannedTool[];
  /** Built-in tools (web, sandbox). Missing on plans saved before they existed. */
  builtinTools: PlannedBuiltinTool[];
}

export interface PlanGap {
  capability: string;
  suggestion: string;
}

export interface AgentPlan {
  name: string;
  description: string;
  flow: "single" | "team";
  agents: PlannedAgent[];
  /** Capabilities the description needs that no catalog tool provides. */
  gaps: PlanGap[];
  /** Things the planner assumed and the user should confirm. */
  assumptions: string[];
  /** Example messages to try in the playground. */
  testPrompts: string[];
}

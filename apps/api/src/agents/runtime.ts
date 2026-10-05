import type Anthropic from "@anthropic-ai/sdk";
import { coordinatorRoster, toManagedAgentParams, type AgentPlan, type ToolCatalog } from "@altship/agent-design";
import { environmentId, getAnthropic } from "./anthropic.js";
import { TurnTracker, toUiEvent, type AgentUiEvent } from "./events.js";
import type { AgentRecord } from "./store.js";

type AgentCreateParams = Parameters<Anthropic["beta"]["agents"]["create"]>[0];

/**
 * Creates the Managed Agents for an approved plan: specialists first, then the
 * primary agent (the coordinator, with the specialists as its roster). If a
 * create fails part-way, the agents already created are archived.
 */
export async function createManagedAgents(plan: AgentPlan, catalog: ToolCatalog) {
  const client = getAnthropic();
  const { primary, specialists } = toManagedAgentParams(plan, catalog);
  const created: { key: string; id: string; version: number }[] = [];

  try {
    for (const specialist of specialists) {
      const agent = await client.beta.agents.create(specialist.params as unknown as AgentCreateParams);
      created.push({ key: specialist.key, id: agent.id, version: agent.version });
    }

    const primaryParams = {
      ...primary.params,
      ...(created.length > 0 ? { multiagent: coordinatorRoster(created) } : {}),
    };
    const coordinator = await client.beta.agents.create(primaryParams as unknown as AgentCreateParams);
    return { coordinator: { id: coordinator.id, version: coordinator.version }, specialists: created };
  } catch (err) {
    await Promise.all(created.map((a) => client.beta.agents.archive(a.id).catch(() => {})));
    throw err;
  }
}

/** Anthropic vaults hold at most this many credentials. */
const MAX_VAULT_CREDENTIALS = 20;

/**
 * Creates a vault holding the bearer token for each MCP server (altship's
 * access key for a deployed server, the relay token for connected apps), so the
 * agent's calls to those (access-controlled) servers are authorized. The keys
 * are injected by Anthropic at egress and never enter the agent's sandbox.
 */
export async function createAgentVault(agentId: string, servers: { url: string; token: string }[]): Promise<string> {
  const client = getAnthropic();
  const vault = await client.beta.vaults.create({ display_name: `altship agent ${agentId}`, metadata: { altship_agent_id: agentId } });
  for (const server of servers.slice(0, MAX_VAULT_CREDENTIALS)) {
    await client.beta.vaults.credentials.create(vault.id, {
      display_name: server.url,
      auth: { type: "static_bearer", mcp_server_url: server.url, token: server.token },
    });
  }
  return vault.id;
}

export async function startSession(agent: AgentRecord, title: string): Promise<string> {
  const session = await getAnthropic().beta.sessions.create({
    agent: { type: "agent", id: agent.coordinatorAgentId, version: agent.coordinatorVersion },
    environment_id: environmentId(),
    title,
    ...(agent.vaultId ? { vault_ids: [agent.vaultId] } : {}),
  });
  return session.id;
}

export async function sendUserMessage(sessionId: string, text: string) {
  await getAnthropic().beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

export async function confirmToolCall(sessionId: string, toolCallId: string, result: "allow" | "deny", denyMessage?: string) {
  await getAnthropic().beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.tool_confirmation",
        tool_use_id: toolCallId,
        result,
        ...(result === "deny" && denyMessage ? { deny_message: denyMessage } : {}),
      },
    ],
  });
}

export interface FollowOptions {
  /** Stop following after this long even if the turn hasn't settled. */
  maxMs: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentUiEvent) => void;
  /** Runs after the live stream is open but before history is read (e.g. to send a message stream-first). */
  afterStreamOpen?: () => Promise<void>;
}

/**
 * Follows a session until its latest input settles (answered, failed, or
 * waiting on an approval) or `maxMs` passes. Opens the live stream first,
 * then replays history and dedupes by event ID, so nothing is missed
 * between the two.
 */
export async function followSession(sessionId: string, options: FollowOptions): Promise<TurnTracker> {
  const client = getAnthropic();
  const tracker = new TurnTracker();
  const seen = new Set<string>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.maxMs);
  options.signal?.addEventListener("abort", () => controller.abort());

  const handle = (raw: Parameters<typeof toUiEvent>[0]) => {
    const event = toUiEvent(raw);
    if (!event) return;
    // User events are echoed twice (queued, then processed); count each once.
    if (seen.has(event.id)) return;
    seen.add(event.id);
    tracker.observe(event);
    options.onEvent?.(event);
  };

  try {
    const stream = await client.beta.sessions.events.stream(sessionId, undefined, { signal: controller.signal });
    await options.afterStreamOpen?.();

    for await (const event of client.beta.sessions.events.list(sessionId)) handle(event);
    if (tracker.settled) {
      stream.controller.abort();
      return tracker;
    }

    for await (const event of stream) {
      handle(event);
      if (tracker.settled) break;
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return tracker;
}

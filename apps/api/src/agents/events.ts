import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

// Managed Agents session events, reduced to what the dashboard renders. Keeps
// the UI independent of the SDK's event shapes.

export type AgentUiEvent =
  | { kind: "user"; id: string; text: string; at: string | null }
  | { kind: "message"; id: string; text: string; at: string | null }
  | {
      kind: "tool_call";
      id: string;
      server: string;
      tool: string;
      input: Record<string, unknown>;
      /** "ask" = waiting for (or given) a human decision. */
      permission: "allow" | "ask" | "deny";
      threadId: string | null;
      at: string | null;
    }
  | { kind: "tool_result"; id: string; toolCallId: string; text: string; isError: boolean; at: string | null }
  | { kind: "confirmation"; id: string; toolCallId: string; result: "allow" | "deny"; at: string | null }
  | { kind: "thread"; id: string; threadId: string; agent: string; at: string | null }
  | { kind: "delegation"; id: string; direction: "sent" | "received"; agent: string; text: string; at: string | null }
  | { kind: "status"; id: string; status: "running" | "idle" | "terminated"; stopReason: string | null; at: string | null }
  | { kind: "error"; id: string; message: string; at: string | null };

type AnyEvent = BetaManagedAgentsSessionEvent | BetaManagedAgentsStreamSessionEvents;

/** What tool_call events from built-in tools show as their "server". */
export const BUILTIN_SERVER = "built-in";

function textOf(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  return (content ?? []).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
}

export function toUiEvent(event: AnyEvent): AgentUiEvent | null {
  const at = "processed_at" in event ? (event.processed_at ?? null) : null;

  switch (event.type) {
    case "user.message":
      return { kind: "user", id: event.id, text: textOf(event.content), at };
    case "agent.message":
      return { kind: "message", id: event.id, text: textOf(event.content), at };
    case "agent.mcp_tool_use":
      return {
        kind: "tool_call",
        id: event.id,
        server: event.mcp_server_name,
        tool: event.name,
        input: event.input,
        permission: event.evaluated_permission ?? "allow",
        threadId: event.session_thread_id ?? null,
        at,
      };
    case "agent.mcp_tool_result":
      return {
        kind: "tool_result",
        id: event.id,
        toolCallId: event.mcp_tool_use_id,
        text: textOf(event.content),
        isError: event.is_error === true,
        at,
      };
    // Built-in tools (web, sandbox), which need no MCP server.
    case "agent.tool_use":
      return {
        kind: "tool_call",
        id: event.id,
        server: BUILTIN_SERVER,
        tool: event.name,
        input: event.input,
        permission: event.evaluated_permission ?? "allow",
        threadId: event.session_thread_id ?? null,
        at,
      };
    case "agent.tool_result":
      return {
        kind: "tool_result",
        id: event.id,
        toolCallId: event.tool_use_id,
        text: textOf(event.content),
        isError: event.is_error === true,
        at,
      };
    case "user.tool_confirmation":
      return { kind: "confirmation", id: event.id, toolCallId: event.tool_use_id, result: event.result, at };
    case "session.thread_created":
      return { kind: "thread", id: event.id, threadId: event.session_thread_id, agent: event.agent_name, at };
    case "agent.thread_message_sent":
      return { kind: "delegation", id: event.id, direction: "sent", agent: event.to_agent_name ?? "agent", text: textOf(event.content), at };
    case "agent.thread_message_received":
      return {
        kind: "delegation",
        id: event.id,
        direction: "received",
        agent: event.from_agent_name ?? "agent",
        text: textOf(event.content),
        at,
      };
    case "session.status_running":
      return { kind: "status", id: event.id, status: "running", stopReason: null, at };
    case "session.status_idle":
      return { kind: "status", id: event.id, status: "idle", stopReason: event.stop_reason.type, at };
    case "session.status_terminated":
      return { kind: "status", id: event.id, status: "terminated", stopReason: null, at };
    case "session.error": {
      const error = event.error as { type?: string; message?: string };
      return { kind: "error", id: event.id, message: error.message ?? error.type ?? "Unknown error", at };
    }
    default:
      return null;
  }
}

/**
 * Tracks where the conversation is, from the events seen so far: whether the
 * latest user input has been answered, and which tool calls await approval.
 */
export class TurnTracker {
  private waitingSinceUserInput = false;
  private readonly asks = new Map<string, Extract<AgentUiEvent, { kind: "tool_call" }>>();
  private finalReply = "";
  status: "running" | "requires_action" | "completed" | "failed" = "running";

  observe(event: AgentUiEvent) {
    switch (event.kind) {
      case "user":
        this.waitingSinceUserInput = true;
        this.finalReply = "";
        this.status = "running";
        break;
      case "confirmation":
        this.asks.delete(event.toolCallId);
        this.waitingSinceUserInput = true;
        // The session stays idle until every pending approval is answered.
        this.status = this.asks.size > 0 ? "requires_action" : "running";
        break;
      case "tool_call":
        if (event.permission === "ask") this.asks.set(event.id, event);
        break;
      case "message":
        this.finalReply = this.finalReply ? `${this.finalReply}\n\n${event.text}` : event.text;
        break;
      case "status":
        if (event.status === "terminated") {
          this.status = "failed";
          this.waitingSinceUserInput = false;
        } else if (event.status === "idle" && this.waitingSinceUserInput) {
          if (event.stopReason === "requires_action") {
            this.status = "requires_action";
          } else {
            this.status = event.stopReason === "end_turn" ? "completed" : "failed";
            this.waitingSinceUserInput = false;
          }
        }
        break;
    }
  }

  /** The latest input has been fully handled, or is blocked on a human. */
  get settled(): boolean {
    return this.status !== "running";
  }

  get pendingApprovals() {
    return [...this.asks.values()];
  }

  get reply(): string {
    return this.finalReply;
  }
}

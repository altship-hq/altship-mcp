import { parseStepMessage, type FlowNode, type StepEvidence } from "@altship/agent-design";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

// Managed Agents session events, reduced to what the dashboard renders. Keeps
// the UI independent of the SDK's event shapes.

export type AgentUiEvent =
  | { kind: "user"; id: string; text: string; at: string | null }
  /**
   * A flow's step being handed to its coordinator (flows run one step at a
   * time, sent by altship). `request` is the user's message when this step
   * opens a new pass through the flow.
   */
  | { kind: "step"; id: string; node: string; name: string; stepKind: FlowNode["type"]; route: string | null; retry: boolean; request: string | null; at: string | null }
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
    case "user.message": {
      const text = textOf(event.content);
      const step = parseStepMessage(text);
      if (!step) return { kind: "user", id: event.id, text, at };
      const { node, name, kind, route, retry } = step.header;
      return { kind: "step", id: event.id, node, name, stepKind: kind, route: route ?? null, retry: retry === true, request: step.request, at };
    }
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
  /** Tool calls the agent has made in the session so far (its whole history is replayed on each follow). */
  toolCalls = 0;
  status: "running" | "requires_action" | "completed" | "failed" = "running";
  /** The flow step the latest input asked for; null when the latest input was an ordinary message. */
  lastStep: string | null = null;
  /** The latest ordinary message from the user. */
  lastUserText = "";
  private delegatedTo: string[] = [];
  private toolsCalled: string[] = [];
  private answers: { agent: string; text: string }[] = [];
  private lastMessage = "";

  observe(event: AgentUiEvent) {
    switch (event.kind) {
      case "user":
      case "step":
        this.waitingSinceUserInput = true;
        this.finalReply = "";
        this.status = "running";
        this.delegatedTo = [];
        this.toolsCalled = [];
        this.answers = [];
        this.lastMessage = "";
        this.lastStep = event.kind === "step" ? event.node : null;
        if (event.kind === "user") this.lastUserText = event.text;
        break;
      case "thread":
        this.delegatedTo.push(event.agent);
        break;
      case "delegation":
        if (event.direction === "sent") this.delegatedTo.push(event.agent);
        else this.answers.push({ agent: event.agent, text: event.text });
        break;
      case "confirmation":
        this.asks.delete(event.toolCallId);
        this.waitingSinceUserInput = true;
        // The session stays idle until every pending approval is answered.
        this.status = this.asks.size > 0 ? "requires_action" : "running";
        break;
      case "tool_call":
        this.toolCalls += 1;
        this.toolsCalled.push(event.tool);
        if (event.permission === "ask") this.asks.set(event.id, event);
        break;
      case "message":
        this.finalReply = this.finalReply ? `${this.finalReply}\n\n${event.text}` : event.text;
        if (event.text) this.lastMessage = event.text;
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

  /** What was done in answer to the latest input, for checking a flow step was carried out. */
  get evidence(): StepEvidence {
    return { delegatedTo: [...this.delegatedTo], toolsCalled: [...this.toolsCalled], answers: [...this.answers], reply: this.finalReply, lastMessage: this.lastMessage };
  }
}

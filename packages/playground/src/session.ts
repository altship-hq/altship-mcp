import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Spawn a local server over stdio, or connect to a deployed one over Streamable HTTP. */
export type ConnectOptions =
  | {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      url: string;
      headers?: Record<string, string>;
    };

export interface ToolCallOutcome {
  durationMs: number;
  isError: boolean;
  text: string;
}

/** Wraps an MCP client connection to a single generated server (local over stdio, or deployed over HTTP). */
export class PlaygroundSession {
  private constructor(private readonly client: Client) {}

  static async connect(options: ConnectOptions): Promise<PlaygroundSession> {
    const client = new Client({ name: "altship-playground", version: "0.0.1" });
    const transport =
      "url" in options
        ? new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers: options.headers } })
        : new StdioClientTransport({
            command: options.command,
            args: options.args,
            cwd: options.cwd,
            env: { ...(process.env as Record<string, string>), ...options.env },
          });
    await client.connect(transport);
    return new PlaygroundSession(client);
  }

  async listTools() {
    const { tools } = await this.client.listTools();
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const start = performance.now();
    const result = await this.client.callTool({ name, arguments: args });
    const durationMs = performance.now() - start;

    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text !== undefined)
      .map((c) => c.text)
      .join("\n");

    return { durationMs, isError: result.isError === true, text };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

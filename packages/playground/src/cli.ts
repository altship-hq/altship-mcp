#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { PlaygroundSession } from "./session.js";
import { coerceArgs } from "./coerce.js";

interface ParsedArgs {
  cwd?: string;
  env: Record<string, string>;
  command: string;
  args: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const sepIndex = argv.indexOf("--");
  if (sepIndex === -1 || sepIndex === argv.length - 1) {
    throw new Error(
      "Usage: altship-playground [--cwd <dir>] [--env KEY=VALUE ...] -- <command> [args...]\n" +
        "Example: altship-playground --cwd ./generated -- node dist/server.js",
    );
  }

  const flags = argv.slice(0, sepIndex);
  const command = argv[sepIndex + 1];
  const commandArgs = argv.slice(sepIndex + 2);

  const env: Record<string, string> = {};
  let cwd: string | undefined;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--cwd") cwd = flags[++i];
    else if (flags[i] === "--env") {
      const [key, ...rest] = flags[++i].split("=");
      env[key] = rest.join("=");
    }
  }

  return { cwd, env, command, args: commandArgs };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  console.log(`Connecting to: ${parsed.command} ${parsed.args.join(" ")}${parsed.cwd ? ` (cwd: ${parsed.cwd})` : ""}`);
  const session = await PlaygroundSession.connect(parsed);
  const tools = await session.listTools();
  console.log(`Connected. ${tools.length} tool(s) available.\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      printToolList(tools);
      const choice = (await rl.question("\nTool name (or \"exit\"): ")).trim();
      if (choice === "exit" || choice === "") break;

      const tool = tools.find((t) => t.name === choice);
      if (!tool) {
        console.log(`Unknown tool "${choice}".`);
        continue;
      }

      const schema = tool.inputSchema as { type: "object"; properties: Record<string, unknown> };
      const rawValues: Record<string, string> = {};
      for (const [propName, propSchema] of Object.entries(schema.properties ?? {})) {
        const hint = (propSchema as { type?: string; description?: string }).type ?? "string";
        const desc = (propSchema as { description?: string }).description;
        const answer = await rl.question(`  ${propName} (${hint}${desc ? ` — ${desc}` : ""}): `);
        rawValues[propName] = answer;
      }

      const args = coerceArgs(schema as never, rawValues);
      console.log(`\nCalling ${tool.name} with ${JSON.stringify(args)} ...`);

      const outcome = await session.callTool(tool.name, args);
      console.log(outcome.isError ? "✗ error" : "✓ success", `(${outcome.durationMs.toFixed(0)}ms)`);
      console.log(outcome.text);
    }
  } finally {
    rl.close();
    await session.close();
  }
}

function printToolList(tools: Array<{ name: string; description?: string }>) {
  console.log("Tools:");
  for (const t of tools) {
    console.log(`  ${t.name}${t.description ? ` — ${truncate(t.description, 70)}` : ""}`);
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;

/** Reads credentials the SDK's usual way (ANTHROPIC_API_KEY in apps/api/.env). */
export function getAnthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export class AgentConfigError extends Error {}

/** The shared Managed Agents environment every session runs in (created once by scripts/setup-agents.ts). */
export function environmentId(): string {
  const id = process.env.ANTHROPIC_ENVIRONMENT_ID;
  if (!id) {
    throw new AgentConfigError(
      "Missing ANTHROPIC_ENVIRONMENT_ID in apps/api/.env — run `npx tsx scripts/setup-agents.ts` in apps/api once and set it.",
    );
  }
  return id;
}

import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;

/**
 * Reads credentials the SDK's usual way (ANTHROPIC_API_KEY in apps/api/.env).
 * Keys that aren't scoped to one workspace (e.g. organization-wide keys) must
 * name the workspace on every request: set ANTHROPIC_WORKSPACE_ID for those.
 */
export function getAnthropic(): Anthropic {
  client ??= new Anthropic(anthropicOptions());
  return client;
}

export function anthropicOptions(): ConstructorParameters<typeof Anthropic>[0] {
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  return workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {};
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

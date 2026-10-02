// One-time setup for Agent Creator: creates the shared Managed Agents
// environment every agent session runs in, and prints its ID for
// ANTHROPIC_ENVIRONMENT_ID. Run from apps/api: npx tsx scripts/setup-agents.ts
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const NAME = "altship-agents";
const client = new Anthropic();

for await (const env of client.beta.environments.list()) {
  if (env.name === NAME) {
    console.log(`Environment "${NAME}" already exists.\nANTHROPIC_ENVIRONMENT_ID=${env.id}`);
    process.exit(0);
  }
}

const env = await client.beta.environments.create({
  name: NAME,
  config: { type: "cloud", networking: { type: "unrestricted" } },
});
console.log(`Created environment "${NAME}".\nANTHROPIC_ENVIRONMENT_ID=${env.id}`);

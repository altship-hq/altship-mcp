import { AGENT_MODELS } from "./types.js";

// JSON Schema for AgentPlan, in the subset structured outputs accept
// (every object closed with additionalProperties: false, every field required).
// Keep in sync with types.ts.

const str = { type: "string" } as const;

export const AGENT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "flow", "agents", "gaps", "assumptions", "testPrompts"],
  properties: {
    name: str,
    description: str,
    flow: { type: "string", enum: ["single", "team"] },
    agents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "name", "role", "model", "description", "instructions", "tools"],
        properties: {
          key: str,
          name: str,
          role: { type: "string", enum: ["solo", "coordinator", "specialist"] },
          model: { type: "string", enum: [...AGENT_MODELS] },
          description: str,
          instructions: str,
          tools: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["server", "tool", "permission", "reason"],
              properties: {
                server: str,
                tool: str,
                permission: { type: "string", enum: ["auto", "ask"] },
                reason: str,
              },
            },
          },
        },
      },
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capability", "suggestion"],
        properties: { capability: str, suggestion: str },
      },
    },
    assumptions: { type: "array", items: str },
    testPrompts: { type: "array", items: str },
  },
} as const;

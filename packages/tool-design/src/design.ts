import type { OpenAPIV3 } from "openapi-types";
import { deriveToolName } from "./naming.js";
import { isDestructive, isSensitive } from "./flags.js";
import { buildInputSchema } from "./schema.js";
import type { ToolDefinition } from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

/**
 * Turns every operation in a (dereferenced) OpenAPI document into a proposed
 * MCP tool definition. This is a proposal, not a final surface — the
 * customer reviews/excludes tools (especially ones flagged destructive or
 * sensitive) before generation.
 */
export function designTools(document: OpenAPIV3.Document): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const [pathKey, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, unknown>)[method] as
        | OpenAPIV3.OperationObject
        | undefined;
      if (!operation) continue;

      const description = (operation.description ?? operation.summary ?? "").trim();
      const { schema, issues } = buildInputSchema(operation);

      tools.push({
        name: deriveToolName(method, pathKey),
        description,
        inputSchema: schema,
        method: method.toUpperCase(),
        path: pathKey,
        operationId: operation.operationId,
        destructive: isDestructive(method, pathKey),
        sensitive: isSensitive(pathKey, description),
        issues,
      });
    }
  }

  return dedupeNames(tools);
}

/** Two operations can map to the same derived name (e.g. two nested actions
 * with the same resource + verb); disambiguate rather than silently collide. */
function dedupeNames(tools: ToolDefinition[]): ToolDefinition[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return tools.map((tool) => {
    const total = counts.get(tool.name) ?? 1;
    if (total <= 1) return tool;

    const index = (seen.get(tool.name) ?? 0) + 1;
    seen.set(tool.name, index);
    return {
      ...tool,
      name: `${tool.name}_${index}`,
      issues: [
        ...tool.issues,
        {
          code: "tool-name-collision",
          message: `Derived name "${tool.name}" was used by ${total} operations; disambiguated to "${tool.name}_${index}".`,
        },
      ],
    };
  });
}

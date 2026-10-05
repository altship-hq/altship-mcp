import type { OpenAPIV3 } from "openapi-types";
import { capToolName, deriveToolName, toSnakeCase } from "./naming.js";
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
      const { schema, parameterMap, issues } = buildInputSchema(operation);

      tools.push({
        name: deriveToolName(method, pathKey, { returnsList: returnsList(operation) }),
        description,
        inputSchema: schema,
        parameterMap,
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

/** Property names a list is commonly wrapped in, e.g. { "data": [...], "total": 12 }. */
const LIST_WRAPPERS = ["data", "items", "results", "records", "list", "rows", "entries", "values", "nodes", "edges"];

/**
 * Whether the operation's successful JSON response is a list: an array, or an
 * object wrapping one. Undefined when the spec doesn't say what it returns.
 */
function returnsList(operation: OpenAPIV3.OperationObject): boolean | undefined {
  const responses = (operation.responses ?? {}) as Record<string, OpenAPIV3.ResponseObject | undefined>;
  const status = Object.keys(responses).find((code) => /^2/.test(code));
  const content = status ? responses[status]?.content : undefined;
  const mediaType = content && (content["application/json"] ?? Object.entries(content).find(([type]) => type.includes("json"))?.[1]);
  const schema = mediaType?.schema as OpenAPIV3.SchemaObject | undefined;
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.type === "array") return true;
  const properties = (schema.properties ?? {}) as Record<string, OpenAPIV3.SchemaObject | undefined>;
  if (schema.type !== "object" && Object.keys(properties).length === 0) return undefined;
  return LIST_WRAPPERS.some((key) => properties[key]?.type === "array");
}

/** The path's parameter names, in order, as they'd appear in a tool name. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => toSnakeCase(match[1]).replace(/[^a-z0-9]+/g, "_")).filter(Boolean);
}

/**
 * Two operations can map to the same derived name (say GET /classes/public
 * and GET /classes/{id}/public). They're told apart by what actually differs
 * between them, in stages, each applied only to the names still clashing:
 * the path parameter ("_by_id"), then the HTTP method, and only as a last
 * resort a number, which is reported so the customer can see it on review.
 */
function dedupeNames(tools: ToolDefinition[]): ToolDefinition[] {
  const names = tools.map((tool) => tool.name);
  /** Indexes of tools sharing a name, one group per clashing name. */
  const clashes = () => {
    const groups = new Map<string, number[]>();
    for (const [index, name] of names.entries()) groups.set(name, [...(groups.get(name) ?? []), index]);
    return [...groups.values()].filter((group) => group.length > 1);
  };
  /** Renames each clashing group, but only where that tells at least some of its tools apart. */
  const refine = (rename: (index: number) => string | undefined) => {
    for (const group of clashes()) {
      const renamed = group.map((index) => capToolName(rename(index) ?? names[index]));
      if (new Set(renamed).size > 1) group.forEach((index, i) => (names[index] = renamed[i]));
    }
  };

  refine((i) => {
    const params = pathParams(tools[i].path);
    return params.length > 0 ? `${names[i]}_by_${params[params.length - 1]}` : undefined;
  });
  refine((i) => `${names[i]}_${tools[i].method.toLowerCase()}`);

  const stillClashing = new Set(clashes().flat());
  const seen = new Map<string, number>();
  return tools.map((tool, i) => {
    if (!stillClashing.has(i)) return names[i] === tool.name ? tool : { ...tool, name: names[i] };

    const index = (seen.get(names[i]) ?? 0) + 1;
    seen.set(names[i], index);
    const suffix = `_${index}`;
    const numbered = `${capToolName(names[i]).slice(0, 64 - suffix.length)}${suffix}`;
    return {
      ...tool,
      name: numbered,
      issues: [
        ...tool.issues,
        {
          code: "tool-name-collision",
          message: `Several operations share the name "${names[i]}"; this one was numbered "${numbered}".`,
        },
      ],
    };
  });
}

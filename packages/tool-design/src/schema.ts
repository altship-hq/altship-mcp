import type { OpenAPIV3 } from "openapi-types";
import { toSnakeCase } from "./naming.js";
import type { JsonSchema, JsonSchemaProperty, ToolDesignIssue } from "./types.js";

/**
 * Builds an agent-facing input schema from an operation's parameters and
 * request body. Path/query params become top-level properties (snake_cased);
 * a JSON request body's own properties are flattened into the same object
 * rather than nested under a "body" key, matching the flat, minimal shape
 * agents handle best — unless the body isn't an object, in which case it's
 * nested under "body" since there's nothing sensible to flatten.
 *
 * Header/cookie parameters are deliberately excluded: those are almost
 * always auth or transport concerns the credential layer should own, not
 * something an agent should be asked to supply per call.
 */
export function buildInputSchema(
  operation: OpenAPIV3.OperationObject,
): { schema: JsonSchema; issues: ToolDesignIssue[] } {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  const issues: ToolDesignIssue[] = [];

  for (const param of operation.parameters ?? []) {
    if ("$ref" in param) continue;
    if (param.in !== "path" && param.in !== "query") continue;

    const name = toSnakeCase(param.name);
    if (properties[name]) {
      issues.push({
        code: "parameter-name-collision",
        message: `Parameter "${param.name}" collides with another property named "${name}" after snake_case conversion; last one wins.`,
      });
    }

    properties[name] = schemaToProperty(param.schema, param.description);
    if (param.required) required.push(name);
  }

  const bodySchema = extractJsonBodySchema(operation.requestBody);
  if (bodySchema) {
    if (!("$ref" in bodySchema) && bodySchema.type === "object" && bodySchema.properties) {
      for (const [rawName, propSchema] of Object.entries(bodySchema.properties)) {
        const name = toSnakeCase(rawName);
        if (properties[name]) {
          issues.push({
            code: "parameter-name-collision",
            message: `Request body property "${rawName}" collides with an existing input property named "${name}"; body property wins.`,
          });
        }
        properties[name] = schemaToProperty(propSchema);
        if (bodySchema.required?.includes(rawName)) required.push(name);
      }
    } else {
      properties.body = schemaToProperty(bodySchema as OpenAPIV3.SchemaObject, "Request body.");
      if (operation.requestBody && !("$ref" in operation.requestBody) && operation.requestBody.required) {
        required.push("body");
      }
    }
  }

  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
    },
    issues,
  };
}

function extractJsonBodySchema(
  requestBody: OpenAPIV3.OperationObject["requestBody"],
): OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined {
  if (!requestBody || "$ref" in requestBody) return undefined;
  return requestBody.content?.["application/json"]?.schema;
}

function schemaToProperty(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
  descriptionOverride?: string,
): JsonSchemaProperty {
  if (!schema || "$ref" in schema) {
    return { description: descriptionOverride };
  }

  const property: JsonSchemaProperty = {
    type: schema.type,
    description: descriptionOverride ?? schema.description,
  };

  if (schema.format) property.format = schema.format;
  if (schema.enum) property.enum = schema.enum;
  if (schema.type === "array" && schema.items) {
    property.items = schemaToProperty(schema.items);
  }

  return property;
}

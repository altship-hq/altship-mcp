import type { OpenAPIV3 } from "openapi-types";
import type { ValidationIssue } from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

const MIN_DESCRIPTION_LENGTH = 10;
const LARGE_SCHEMA_PROPERTY_THRESHOLD = 30;
const INTERNAL_PATH_HINTS = ["/internal/", "/admin/", "/_"];

/**
 * Heuristic checks for whether a technically-valid spec will make a good
 * agent-facing tool surface. None of these fail validation on their own —
 * they're recommendations the customer reviews before generation.
 */
export function checkQuality(document: OpenAPIV3.Document): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenOperationIds = new Map<string, string>();

  for (const [pathKey, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;

    if (INTERNAL_PATH_HINTS.some((hint) => pathKey.includes(hint))) {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "possibly-internal-endpoint",
        message: `"${pathKey}" looks like an internal/admin endpoint. Consider excluding it from the tool surface.`,
        path: `paths.${pathKey}`,
      });
    }

    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, unknown>)[method] as
        | OpenAPIV3.OperationObject
        | undefined;
      if (!operation) continue;

      const opPath = `paths.${pathKey}.${method}`;
      checkOperationId(operation, opPath, method, pathKey, seenOperationIds, issues);
      checkDescription(operation, opPath, issues);
      checkParameterDescriptions(operation, opPath, issues);
      checkResponseSchemaSize(operation, opPath, issues);

      if ((operation as Record<string, unknown>)["x-internal"] === true) {
        issues.push({
          severity: "warning",
          category: "quality",
          code: "marked-internal",
          message: `${method.toUpperCase()} ${pathKey} is marked x-internal and should probably not become a tool.`,
          path: opPath,
        });
      }
    }
  }

  return issues;
}

function checkOperationId(
  operation: OpenAPIV3.OperationObject,
  opPath: string,
  method: HttpMethod,
  pathKey: string,
  seen: Map<string, string>,
  issues: ValidationIssue[],
) {
  if (!operation.operationId) {
    issues.push({
      severity: "warning",
      category: "quality",
      code: "missing-operation-id",
      message: `${method.toUpperCase()} ${pathKey} has no operationId. A generated name will be used, which may be a poor tool name.`,
      path: opPath,
    });
    return;
  }

  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(operation.operationId)) {
    issues.push({
      severity: "warning",
      category: "quality",
      code: "invalid-operation-id-format",
      message: `operationId "${operation.operationId}" on ${opPath} contains characters that won't survive as a tool name (spaces, etc). It will need to be slugified or overridden.`,
      path: opPath,
    });
  }

  const existing = seen.get(operation.operationId);
  if (existing) {
    issues.push({
      severity: "error",
      category: "quality",
      code: "duplicate-operation-id",
      message: `operationId "${operation.operationId}" is used by both ${existing} and ${opPath}.`,
      path: opPath,
    });
  } else {
    seen.set(operation.operationId, opPath);
  }
}

function checkDescription(operation: OpenAPIV3.OperationObject, opPath: string, issues: ValidationIssue[]) {
  const text = operation.description ?? operation.summary ?? "";
  if (text.trim().length < MIN_DESCRIPTION_LENGTH) {
    issues.push({
      severity: "warning",
      category: "quality",
      code: "weak-operation-description",
      message: `${opPath} has no meaningful description or summary. An agent will struggle to know when to use this tool.`,
      path: opPath,
    });
  }
}

function checkParameterDescriptions(
  operation: OpenAPIV3.OperationObject,
  opPath: string,
  issues: ValidationIssue[],
) {
  for (const param of operation.parameters ?? []) {
    if ("$ref" in param) continue;
    if (!param.description || param.description.trim().length === 0) {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "missing-parameter-description",
        message: `Parameter "${param.name}" on ${opPath} has no description.`,
        path: `${opPath}.parameters.${param.name}`,
      });
    }
  }
}

function checkResponseSchemaSize(
  operation: OpenAPIV3.OperationObject,
  opPath: string,
  issues: ValidationIssue[],
) {
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!response || "$ref" in response) continue;
    const schema = response.content?.["application/json"]?.schema;
    if (!schema || "$ref" in schema) continue;

    const propertyCount = countProperties(schema);
    if (propertyCount > LARGE_SCHEMA_PROPERTY_THRESHOLD) {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "large-response-schema",
        message: `${opPath} response ${status} has ${propertyCount} properties. Consider trimming the schema to what an agent actually needs.`,
        path: `${opPath}.responses.${status}`,
      });
    }
  }
}

function countProperties(schema: OpenAPIV3.SchemaObject, depth = 0): number {
  if (depth > 5 || !schema.properties) return 0;
  let count = Object.keys(schema.properties).length;
  for (const value of Object.values(schema.properties)) {
    if (!("$ref" in value) && value.type === "object") {
      count += countProperties(value, depth + 1);
    }
  }
  return count;
}

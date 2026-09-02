/** Minimal JSON Schema shape — enough to describe MCP tool inputs. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: JsonSchemaProperty;
  enum?: unknown[];
  format?: string;
  [key: string]: unknown;
}

export interface ToolDesignIssue {
  code: string;
  message: string;
}

export type ParameterSource = "path" | "query" | "body" | "body-raw";

/** Where a tool input property's value must go when building the HTTP request. */
export interface ParameterMapping {
  source: ParameterSource;
  /** The original OpenAPI name (path template var, query key, or body property key). */
  originalName: string;
}

export interface ToolDefinition {
  /** Dot-notation tool name, e.g. "customers.get" */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** snake_case input property name -> where/how it maps onto the HTTP request. */
  parameterMap: Record<string, ParameterMapping>;
  method: string;
  path: string;
  operationId?: string;
  destructive: boolean;
  sensitive: boolean;
  issues: ToolDesignIssue[];
}

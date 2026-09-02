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

export interface ToolDefinition {
  /** Dot-notation tool name, e.g. "customers.get" */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  method: string;
  path: string;
  operationId?: string;
  destructive: boolean;
  sensitive: boolean;
  issues: ToolDesignIssue[];
}

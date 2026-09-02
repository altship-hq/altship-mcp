export { designTools } from "./design.js";
export { deriveToolName, toSnakeCase } from "./naming.js";
export { buildInputSchema } from "./schema.js";
export { isDestructive, isSensitive } from "./flags.js";
export type {
  ToolDefinition,
  ToolDesignIssue,
  JsonSchema,
  JsonSchemaProperty,
  ParameterMapping,
  ParameterSource,
} from "./types.js";

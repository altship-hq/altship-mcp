interface SchemaProperty {
  type?: string;
  items?: SchemaProperty;
  [key: string]: unknown;
}

interface ObjectSchema {
  type: "object";
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

/**
 * Converts raw string input (as typed at a terminal prompt) into values
 * matching a tool's declared input schema, so the playground can accept
 * plain text for every field regardless of its JSON type. Empty strings are
 * treated as "not provided" — required-field validation is ajv's job on the
 * server side, not the playground's.
 */
export function coerceArgs(
  schema: ObjectSchema,
  rawValues: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(rawValues)) {
    if (raw.trim() === "") continue;
    const propSchema = schema.properties[name];
    result[name] = coerceValue(raw, propSchema);
  }

  return result;
}

function coerceValue(raw: string, schema: SchemaProperty | undefined): unknown {
  switch (schema?.type) {
    case "integer":
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case "boolean":
      return raw.trim().toLowerCase() === "true";
    case "array":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => coerceValue(s, schema.items));
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

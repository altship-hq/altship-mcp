const VERSION_SEGMENT = /^v[0-9]+(\.[0-9]+)?$/i;
const PARAM_SEGMENT = /^\{.+\}$/;

/**
 * Derives a dot-notation tool name from an HTTP method + path, e.g.:
 *   GET    /v1/customers            -> customers.list
 *   GET    /v1/customers/{id}       -> customers.get
 *   POST   /v1/customers            -> customers.create
 *   DELETE /v1/customers/{id}       -> customers.delete
 *   POST   /v1/payments/{id}/refund -> payments.refund
 *
 * We derive from path structure rather than operationId: operationIds are
 * often vendor-specific, inconsistently cased, or (per quality checks) just
 * bad — path shape is a more reliable signal of the resource + action an
 * agent actually needs to reason about.
 */
export function deriveToolName(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !VERSION_SEGMENT.test(segment));

  if (segments.length === 0) {
    return `root.${method.toLowerCase()}`;
  }

  const namespace = toSnakeCase(segments[0]);
  const lastSegment = segments[segments.length - 1];
  const endsInParam = PARAM_SEGMENT.test(lastSegment);

  // A trailing static segment after the resource (e.g. .../{id}/refund) names
  // a specific action directly — trust it over the generic method mapping.
  const trailingAction = !endsInParam && segments.length > 1 ? lastSegment : undefined;

  const action = trailingAction ? toSnakeCase(trailingAction) : actionFromMethod(method, endsInParam);

  return `${namespace}.${action}`;
}

function actionFromMethod(method: string, endsInParam: boolean): string {
  switch (method.toLowerCase()) {
    case "get":
      return endsInParam ? "get" : "list";
    case "post":
      return endsInParam ? "update" : "create";
    case "put":
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return method.toLowerCase();
  }
}

/** camelCase / PascalCase / kebab-case / space-separated -> snake_case */
export function toSnakeCase(input: string): string {
  return input
    .replace(/\{|\}/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

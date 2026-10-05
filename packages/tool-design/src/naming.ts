const VERSION_SEGMENT = /^v[0-9]+(\.[0-9]+)?$/i;
const PARAM_SEGMENT = /^\{.+\}$/;

/** Path prefixes that say nothing about the resource, e.g. the "api" in /api/v1/users. */
const GENERIC_PREFIXES = new Set(["api", "rest"]);

/** The longest tool name common MCP clients accept. */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Words that already say what a path segment does. A trailing segment that
 * starts with one ("findByStatus", "login", "uploadImage") is used as the
 * action as is, rather than getting the HTTP method's verb in front of it.
 */
const ACTION_VERBS = new Set([
  "accept", "activate", "add", "apply", "approve", "archive", "assign", "attach", "authorize", "block", "book", "cancel",
  "capture", "change", "check", "claim", "clear", "close", "complete", "confirm", "connect", "convert", "copy", "count",
  "create", "deactivate", "decline", "delete", "deny", "detach", "disable", "disconnect", "download", "duplicate", "enable",
  "execute", "export", "fetch", "find", "finish", "generate", "get", "import", "invite", "join", "leave", "link", "list",
  "lock", "login", "logout", "lookup", "mark", "merge", "move", "notify", "open", "pause", "pay", "preview", "publish",
  "refresh", "refund", "register", "reject", "remove", "rename", "reorder", "replace", "request", "resend", "reschedule",
  "reset", "resolve", "restore", "resume", "retry", "revoke", "run", "save", "scan", "search", "send", "set", "share", "sign",
  "start", "stop", "submit", "subscribe", "sync", "test", "toggle", "transfer", "trigger", "unassign", "unblock", "unlink",
  "unlock", "unsubscribe", "update", "upgrade", "upload", "validate", "verify", "void", "withdraw",
]);

/** What the caller knows about the operation beyond its method and path. */
export interface NameHints {
  /**
   * Whether a successful response is a list. Decides "list" vs "get" for a
   * GET that doesn't end in a path parameter; when unknown, a GET on a bare
   * collection path is assumed to list.
   */
  returnsList?: boolean;
}

/**
 * Derives a dot-notation tool name, "<resource>.<action>", from an HTTP
 * method + path, e.g.:
 *   GET    /v1/customers                       -> customers.list
 *   GET    /v1/customers/{id}                  -> customers.get
 *   POST   /v1/customers                       -> customers.create
 *   DELETE /v1/customers/{id}                  -> customers.delete
 *   POST   /v1/payments/{id}/refund            -> payments.refund
 *   GET    /api/v1/users/me                    -> users.get_me
 *   POST   /api/v1/auth/email-change/request   -> auth.email_change_request
 *   GET    /api/v1/admin/stripe/accounts/{ref} -> admin.get_stripe_accounts
 *   GET    /pet/findByStatus                   -> pet.find_by_status
 *
 * The resource is the first path segment that names something (version
 * segments and generic prefixes like "api" are skipped). The action is the
 * rest of the path, with the method's verb in front unless the path already
 * names an action.
 *
 * We derive from path structure rather than operationId: operationIds are
 * often vendor-specific, inconsistently cased, or (per quality checks) just
 * bad — path shape is a more reliable signal of the resource + action an
 * agent actually needs to reason about.
 */
export function deriveToolName(method: string, path: string, hints: NameHints = {}): string {
  let segments = path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !VERSION_SEGMENT.test(segment));
  // Generic prefixes go only while something that names a resource follows.
  while (GENERIC_PREFIXES.has(segments[0]?.toLowerCase()) && segments.slice(1).some((s) => !PARAM_SEGMENT.test(s))) {
    segments = segments.slice(1);
  }

  const verb = method.toLowerCase();
  const names = segments.filter((segment) => !PARAM_SEGMENT.test(segment)).map(segmentName).filter(Boolean);
  if (names.length === 0) {
    return `root.${verb}`;
  }

  const endsInParam = PARAM_SEGMENT.test(segments[segments.length - 1]);
  const [resource, ...rest] = names;
  if (rest.length === 0) {
    return capToolName(`${resource}.${actionFromMethod(verb, endsInParam, hints)}`);
  }

  const tail = rest.join("_");
  // The path already names the action: a POST to a static segment
  // (.../{id}/refund), or a trailing segment that starts with a verb.
  const namesAnAction = (verb === "post" && !endsInParam) || ACTION_VERBS.has(rest[rest.length - 1].split("_")[0]);
  if (namesAnAction) {
    return capToolName(`${resource}.${tail}`);
  }
  // Otherwise the rest of the path is a sub-resource: say what's done to it.
  const subAction = verb === "get" ? (hints.returnsList && !endsInParam ? "list" : "get") : actionFromMethod(verb, true, hints);
  return capToolName(`${resource}.${subAction}_${tail}`);
}

function actionFromMethod(method: string, endsInParam: boolean, hints: NameHints): string {
  switch (method) {
    case "get":
      return endsInParam || hints.returnsList === false ? "get" : "list";
    case "post":
      return endsInParam ? "update" : "create";
    case "put":
    case "patch":
      return "update";
    case "delete":
      return "delete";
    default:
      return method;
  }
}

/** Trims a name to the length MCP clients accept, without leaving it ending in a separator. */
export function capToolName(name: string): string {
  return name.length <= MAX_TOOL_NAME_LENGTH ? name : name.slice(0, MAX_TOOL_NAME_LENGTH).replace(/[._]+$/, "");
}

/** A path segment as part of a tool name: snake_case, letters, digits and underscores only. */
function segmentName(segment: string): string {
  return toSnakeCase(segment)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** camelCase / PascalCase / kebab-case / space-separated -> snake_case */
export function toSnakeCase(input: string): string {
  return input
    .replace(/\{|\}/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

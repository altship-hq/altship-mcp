const SENSITIVE_HINTS = ["payment", "refund", "charge", "password", "secret", "credential", "token", "admin", "billing"];

/** DELETE always is; PUT/PATCH/POST that overwrite or remove state are treated as destructive too. */
export function isDestructive(method: string, path: string): boolean {
  const m = method.toLowerCase();
  if (m === "delete") return true;
  if (m === "put") return true;
  return /delete|remove|cancel|revoke/i.test(path);
}

export function isSensitive(path: string, description: string): boolean {
  const haystack = `${path} ${description}`.toLowerCase();
  return SENSITIVE_HINTS.some((hint) => haystack.includes(hint));
}

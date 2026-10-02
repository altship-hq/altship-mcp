import type { ConnectSettings } from "../store.js";

// Server-rendered pages for end users connecting to a "for your customers"
// MCP server. Branded with the SaaS's name, not altship's. Every dynamic value
// goes through esc().

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-content: center; grid-template-columns: min(100%, 400px);
    padding: 24px 16px; background: #fafafa; color: #111; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; }
  .card { background: #fff; border: 1px solid #e6e6e6; border-radius: 6px; padding: 28px 24px; }
  h1 { margin: 0 0 8px; font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 16px; color: #555; font-size: 14px; line-height: 1.55; }
  label { display: grid; gap: 6px; margin: 0 0 14px; font-size: 13px; font-weight: 500; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #d0d0d0; border-radius: 4px; font: inherit; font-size: 14px; }
  input:focus { outline: 2px solid #111; outline-offset: -1px; border-color: #111; }
  .help { margin: -6px 0 16px; font-size: 12px; color: #777; }
  .error { margin: 0 0 16px; padding: 10px 12px; border-left: 2px solid #b42318; background: #fdeceb; color: #8a1c13; font-size: 13px; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
  button { padding: 11px 14px; border-radius: 4px; font: inherit; font-size: 14px; cursor: pointer; }
  .deny { background: #fff; border: 1px solid #d0d0d0; color: #111; }
  .allow { background: #111; border: 1px solid #111; color: #fff; }
  .fine { margin: 18px 0 0; font-size: 12px; color: #888; }
  .footer { margin-top: 14px; text-align: center; font-size: 11px; color: #9a9a9a; }
</style>
</head>
<body>
<main class="card">
${body}
</main>
<div class="footer">Secured by altship</div>
</body>
</html>`;
}

const CREDENTIAL_LABELS: Record<ConnectSettings["credentialKind"], string> = {
  "apiKey-header": "API key",
  "apiKey-query": "API key",
  bearer: "Access token",
  basic: "",
};

export function connectPage(options: {
  requestId: string;
  settings: ConnectSettings;
  clientName: string | null;
  redirectUri: string;
  error?: string;
}): string {
  const product = options.settings.displayName;
  const app = options.clientName || "An app";
  let returnHost = options.redirectUri;
  try {
    returnHost = new URL(options.redirectUri).host;
  } catch {
    // keep as is
  }

  const fields =
    options.settings.credentialKind === "basic"
      ? `<label>${esc(product)} username<input name="username" autocomplete="username" required></label>
<label>${esc(product)} password<input name="password" type="password" autocomplete="current-password" required></label>`
      : `<label>Your ${esc(product)} ${esc(CREDENTIAL_LABELS[options.settings.credentialKind])}<input name="credential" type="password" autocomplete="off" spellcheck="false" required></label>`;

  return layout(
    `Connect ${app} to ${product}`,
    `<h1>Connect ${esc(app)} to ${esc(product)}</h1>
<p>${esc(app)} will be able to use ${esc(product)} on your behalf, with your own account's access.</p>
${options.error ? `<div class="error" role="alert">${esc(options.error)}</div>` : ""}
<form method="post" action="authorize">
<input type="hidden" name="request_id" value="${esc(options.requestId)}">
${fields}
${options.settings.helpText ? `<div class="help">${esc(options.settings.helpText)}</div>` : ""}
<div class="actions">
<button class="deny" type="submit" name="action" value="deny" formnovalidate>Cancel</button>
<button class="allow" type="submit" name="action" value="allow">Connect</button>
</div>
</form>
<p class="fine">You'll be sent back to ${esc(returnHost)}. Your credential is encrypted and only used to call ${esc(product)} for you.</p>`,
  );
}

export function errorPage(message: string): string {
  return layout("Couldn't connect", `<h1>Couldn't connect</h1>\n<p>${esc(message)}</p>`);
}

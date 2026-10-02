import { createHash } from "node:crypto";
import { Router, type Response } from "express";
import cors from "cors";
import { findCustomerDeploymentByMcpUrl, getDeploymentById, type ConnectSettings } from "../store.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  endUserIssuer,
  publicJwks,
  randomToken,
  sealCredential,
  serverAudience,
  signAccessToken,
} from "./crypto.js";
import {
  approveRequest,
  consumeCode,
  consumeRefreshToken,
  getActiveConnection,
  getClient,
  getRequest,
  hashToken,
  insertClient,
  insertConnection,
  insertRefreshToken,
  insertRequest,
  touchConnection,
} from "./store.js";
import { connectPage, errorPage } from "./pages.js";

// The end-user sign-in server for "for your customers" MCP servers: an OAuth
// 2.1 authorization server (PKCE, dynamic client registration, rotating
// refresh tokens) at <API_PUBLIC_URL>/oauth. People connecting from Claude,
// ChatGPT etc. sign in on a connect page with their own credential for the
// SaaS -- no altship account. Discovery and token endpoints are public
// (CORS open), since MCP clients call them from anywhere.

export const endUsersRouter = Router();
endUsersRouter.use(["/oauth", "/.well-known"], cors());
endUsersRouter.use("/oauth", (_req, res, next) => {
  res.setHeader("cache-control", "no-store");
  next();
});

const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_REDIRECT_URIS = 10;

// ---- Discovery --------------------------------------------------------------

function metadata() {
  const issuer = endUserIssuer();
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

// RFC 8414 puts the issuer's path after the well-known segment; some clients
// look under the issuer instead, or for OpenID Connect discovery.
for (const path of [
  "/.well-known/oauth-authorization-server/oauth",
  "/oauth/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration/oauth",
  "/oauth/.well-known/openid-configuration",
]) {
  endUsersRouter.get(path, (_req, res) => {
    res.json(metadata());
  });
}

endUsersRouter.get("/oauth/.well-known/jwks.json", async (_req, res) => {
  res.json(await publicJwks());
});

// ---- Dynamic client registration (RFC 7591) ---------------------------------

endUsersRouter.post("/oauth/register", async (req, res) => {
  const body = req.body ?? {};
  const redirectUris: unknown = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    !redirectUris.every(isAllowedRedirectUri)
  ) {
    return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-10 https (or localhost) URLs." });
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return res.status(400).json({ error: "invalid_client_metadata", error_description: "Only public clients (token_endpoint_auth_method none) are supported." });
  }

  const client = {
    clientId: `cli_${randomToken(16)}`,
    clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : null,
    clientUri: typeof body.client_uri === "string" && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 300) : null,
    redirectUris: redirectUris as string[],
  };
  await insertClient(client);
  res.status(201).json({
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName ?? undefined,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

function isAllowedRedirectUri(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

// ---- Authorization: the connect page ---------------------------------------

endUsersRouter.get("/oauth/authorize", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const client = q.client_id ? await getClient(q.client_id) : null;
  // Until the client and redirect URI check out, errors are shown here rather
  // than redirected (never redirect to an unverified URI).
  if (!client) return sendPage(res, 400, errorPage("This app isn't registered. Remove the connector and add it again."));
  if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
    return sendPage(res, 400, errorPage("This app's redirect address doesn't match its registration."));
  }

  const fail = (error: string, description: string) => redirectWith(res, q.redirect_uri!, { error, error_description: description, state: q.state });
  if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with S256 is required.");

  const deployment = q.resource ? await findCustomerDeploymentByMcpUrl(q.resource) : null;
  if (!deployment || !deployment.connectSettings) {
    return fail("invalid_target", "The resource parameter must be the MCP server's URL.");
  }

  const request = {
    id: `req_${randomToken(18)}`,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    clientId: client.clientId,
    deploymentId: deployment.id,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    state: q.state ?? null,
    scope: q.scope ?? null,
  };
  await insertRequest(request);
  sendPage(res, 200, connectPage({ requestId: request.id, settings: deployment.connectSettings, clientName: client.clientName, redirectUri: q.redirect_uri }));
});

// The connect page's form. The single-use, short-lived request id doubles as
// the CSRF token: it's only ever shown on the page served for this request.
endUsersRouter.post("/oauth/authorize", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const request = body.request_id ? await getRequest(body.request_id) : null;
  if (!request || request.connectionId || Date.parse(request.expiresAt) < Date.now()) {
    return sendPage(res, 400, errorPage("This sign-in link has expired. Go back to the app and connect again."));
  }

  if (body.action === "deny") {
    return redirectWith(res, request.redirectUri, { error: "access_denied", error_description: "The user declined.", state: request.state ?? undefined });
  }

  const deployment = await getDeploymentById(request.deploymentId);
  if (!deployment?.connectSettings) return sendPage(res, 400, errorPage("This MCP server is no longer available."));

  const credential = readCredential(deployment.connectSettings, body);
  if (!credential) {
    const client = await getClient(request.clientId);
    return sendPage(
      res,
      400,
      connectPage({
        requestId: request.id,
        settings: deployment.connectSettings,
        clientName: client?.clientName ?? null,
        redirectUri: request.redirectUri,
        error: "Enter your credential to continue.",
      }),
    );
  }

  const connectionId = `con_${randomToken(16)}`;
  await insertConnection({
    id: connectionId,
    deploymentId: deployment.id,
    clientId: request.clientId,
    credentialHint: credentialHint(credential),
    credentialSealed: sealCredential(deployment.projectId, credential),
  });
  const code = randomToken(32);
  if (!(await approveRequest(request.id, connectionId, hashToken(code)))) {
    return sendPage(res, 400, errorPage("This sign-in link was already used. Go back to the app and connect again."));
  }
  redirectWith(res, request.redirectUri, { code, state: request.state ?? undefined, iss: endUserIssuer() });
});

/** The credential from the connect form, in the shape the generated server applies upstream. */
function readCredential(settings: ConnectSettings, body: Record<string, string | undefined>): string | null {
  if (settings.credentialKind === "basic") {
    const username = body.username?.trim();
    const password = body.password ?? "";
    return username && password ? `${username}:${password}` : null;
  }
  const value = body.credential?.trim();
  return value && value.length <= 4096 ? value : null;
}

/** What the SaaS owner sees in their connections list: never the credential itself. */
function credentialHint(credential: string): string {
  const shown = credential.includes(":") ? credential.split(":")[0] : `…${credential.slice(-4)}`;
  return shown.slice(0, 80);
}

// ---- Token endpoint -------------------------------------------------------

endUsersRouter.post("/oauth/token", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  const error = (status: number, code: string, description: string) => res.status(status).json({ error: code, error_description: description });

  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier || !body.client_id) return error(400, "invalid_request", "code, code_verifier and client_id are required.");
    const request = await consumeCode(hashToken(body.code));
    if (!request || !request.connectionId) return error(400, "invalid_grant", "The authorization code is invalid or was already used.");
    if (Date.parse(request.expiresAt) < Date.now()) return error(400, "invalid_grant", "The authorization code has expired.");
    if (request.clientId !== body.client_id) return error(400, "invalid_grant", "The code was issued to a different client.");
    if (body.redirect_uri && body.redirect_uri !== request.redirectUri) return error(400, "invalid_grant", "redirect_uri doesn't match.");
    if (pkceChallenge(body.code_verifier) !== request.codeChallenge) return error(400, "invalid_grant", "PKCE verification failed.");
    return issueTokens(res, request.connectionId, request.clientId);
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return error(400, "invalid_request", "refresh_token is required.");
    const token = await consumeRefreshToken(hashToken(body.refresh_token));
    if (!token || Date.parse(token.expiresAt) < Date.now()) return error(400, "invalid_grant", "The refresh token is invalid or expired.");
    if (body.client_id && body.client_id !== token.clientId) return error(400, "invalid_grant", "The token was issued to a different client.");
    return issueTokens(res, token.connectionId, token.clientId);
  }

  error(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
});

async function issueTokens(res: Response, connectionId: string, clientId: string) {
  const connection = await getActiveConnection(connectionId);
  const deployment = connection ? await getDeploymentById(connection.deploymentId) : null;
  if (!connection || !deployment) {
    return res.status(400).json({ error: "invalid_grant", error_description: "This connection was revoked. Connect again." });
  }

  const accessToken = await signAccessToken({
    sub: connection.id,
    audience: serverAudience(deployment.projectId),
    clientId,
    sealedCredential: connection.credentialSealed,
  });
  const refreshToken = randomToken(32);
  await insertRefreshToken({ hash: hashToken(refreshToken), connectionId: connection.id, clientId });
  await touchConnection(connection.id);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: "mcp",
  });
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---- Helpers ------------------------------------------------------------------

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  res.redirect(302, url.toString());
}

function sendPage(res: Response, status: number, html: string) {
  res
    .status(status)
    .set({
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:*; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
    })
    .send(html);
}

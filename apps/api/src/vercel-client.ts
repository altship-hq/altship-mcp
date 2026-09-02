const VERCEL_API = "https://api.vercel.com";

export class VercelConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new VercelConfigError(
      `Missing ${name}. Set it in apps/api/.env before deploying (see README for how to create it).`,
    );
  }
  return value;
}

async function vercelFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = requireEnv("VERCEL_API_TOKEN");
  const teamId = requireEnv("VERCEL_TEAM_ID");
  const url = new URL(`${VERCEL_API}${path}`);
  url.searchParams.set("teamId", teamId);

  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

  return res;
}

export interface VercelProject {
  id: string;
  name: string;
}

/** Looks up a project by name, creating it if it doesn't exist yet. */
export async function ensureProject(name: string): Promise<VercelProject> {
  const existing = await vercelFetch(`/v10/projects/${encodeURIComponent(name)}`);
  if (existing.ok) {
    const data = (await existing.json()) as VercelProject;
    return { id: data.id, name: data.name };
  }
  if (existing.status !== 404) {
    throw new Error(`Failed to look up Vercel project "${name}": ${existing.status} ${await existing.text()}`);
  }

  const created = await vercelFetch(`/v11/projects`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    throw new Error(`Failed to create Vercel project "${name}": ${created.status} ${await created.text()}`);
  }
  const data = (await created.json()) as VercelProject;
  return { id: data.id, name: data.name };
}

/** Sets (or updates) a single encrypted production env var on a project. Never logs the value. */
export async function setProjectEnvVar(projectId: string, key: string, value: string): Promise<void> {
  const res = await vercelFetch(`/v10/projects/${projectId}/env?upsert=true`, {
    method: "POST",
    body: JSON.stringify({ key, value, type: "encrypted", target: ["production"] }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set env var "${key}" on project ${projectId}: ${res.status} ${await res.text()}`);
  }
}

export interface DeployResult {
  id: string;
  url: string;
  readyState: string;
}

/** Deploys a flat map of relative file paths -> UTF-8 file contents as a production deployment. */
export async function deployFiles(
  project: VercelProject,
  files: Record<string, string>,
): Promise<DeployResult> {
  const filePayload = Object.entries(files).map(([file, content]) => ({
    file,
    data: Buffer.from(content, "utf8").toString("base64"),
    encoding: "base64" as const,
  }));

  const created = await vercelFetch(`/v13/deployments`, {
    method: "POST",
    body: JSON.stringify({
      name: project.name,
      project: project.id,
      target: "production",
      files: filePayload,
      projectSettings: { framework: null },
    }),
  });

  if (!created.ok) {
    throw new Error(`Failed to create deployment for "${project.name}": ${created.status} ${await created.text()}`);
  }

  const deployment = (await created.json()) as { id: string; url: string; readyState: string };
  const finalState = await pollUntilReady(deployment.id);
  const url = await getProductionDomain(project.id);

  // deployment.url is the per-deployment hash URL, which sits behind Vercel's
  // team-level Deployment Protection (SSO) even for production deploys --
  // the assigned project domain doesn't, and is what a customer should
  // actually be given. Fall back to the deployment URL only if for some
  // reason no domain has been assigned yet.
  return { id: deployment.id, url: url ?? `https://${deployment.url}`, readyState: finalState };
}

async function getProductionDomain(projectId: string): Promise<string | undefined> {
  const res = await vercelFetch(`/v9/projects/${projectId}/domains`);
  if (!res.ok) return undefined;
  const data = (await res.json()) as { domains: Array<{ name: string }> };
  const domain = data.domains[0]?.name;
  return domain ? `https://${domain}` : undefined;
}

async function pollUntilReady(deploymentId: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await vercelFetch(`/v13/deployments/${deploymentId}`);
    if (!res.ok) {
      throw new Error(`Failed to poll deployment ${deploymentId}: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { readyState: string };
    if (data.readyState === "READY" || data.readyState === "ERROR" || data.readyState === "CANCELED") {
      if (data.readyState !== "READY") {
        throw new Error(`Deployment ${deploymentId} finished with state ${data.readyState}`);
      }
      return data.readyState;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error(`Deployment ${deploymentId} did not become ready within ${timeoutMs}ms`);
}

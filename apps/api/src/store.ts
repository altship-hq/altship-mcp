import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const DEPLOYMENTS_FILE = path.join(DATA_DIR, "deployments.json");

export interface DeploymentRecord {
  id: string;
  createdAt: string;
  apiTitle: string;
  toolNames: string[];
  projectName: string;
  projectId: string;
  url: string;
}

async function readAll(): Promise<DeploymentRecord[]> {
  try {
    return JSON.parse(await readFile(DEPLOYMENTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export async function listDeployments(): Promise<DeploymentRecord[]> {
  return readAll();
}

export async function recordDeployment(record: DeploymentRecord): Promise<void> {
  const all = await readAll();
  all.unshift(record);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DEPLOYMENTS_FILE, JSON.stringify(all, null, 2), "utf8");
}

import { accessToken, signOut } from "./auth.js";

// Fetch helpers shared by every product's API client.

// Empty by default so local dev keeps using Vite's proxy (relative "/api/..."
// paths); production sets this since the dashboard and the API are deployed
// as separate Vercel projects on different subdomains.
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

/** fetch() against the API with the signed-in user's token; a 401 signs the user out (back to /login). */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) await signOut();
  return res;
}

async function readJson<T>(path: string, res: Response): Promise<T> {
  const text = await res.text();
  let data: { error?: string } | undefined;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Request to ${path} failed with ${res.status} (the API didn't return JSON).`);
  }
  if (!res.ok) {
    throw new Error(data?.error ?? `Request to ${path} failed with ${res.status}`);
  }
  return data as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<T>(path, res);
}

export async function getJson<T>(path: string): Promise<T> {
  return readJson<T>(path, await apiFetch(path));
}

export async function deleteJson<T>(path: string): Promise<T> {
  return readJson<T>(path, await apiFetch(path, { method: "DELETE" }));
}

// Fetch helpers shared by every product's API client.

// Empty by default so local dev keeps using Vite's proxy (relative "/api/..."
// paths); production sets this since the dashboard and the API are deployed
// as separate Vercel projects on different subdomains.
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? `Request to ${url} failed with ${res.status}`);
  }
  return data as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? `Request to ${url} failed with ${res.status}`);
  }
  return data as T;
}

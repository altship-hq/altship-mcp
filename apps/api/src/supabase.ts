import { createClient } from "@supabase/supabase-js";

// No generated Database types yet (would need `supabase gen types` against
// the shared altship project) -- typing the client as `any` here rather
// than fighting strict-by-default table inference until that exists.
let client: ReturnType<typeof createClient<any>> | undefined;

/**
 * Server-side Supabase client using the service_role key: bypasses row-level
 * security, so every query we write must filter by user_id ourselves. This
 * is the shared `altship` identity project -- auth.users here is intended
 * to be common across every altship product, not just this one, so this
 * app's own tables (deployments) reference auth.users.id but otherwise stay
 * self-contained.
 */
export function getSupabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in apps/api/.env");
    }
    client = createClient<any>(url, key, { auth: { persistSession: false } });
  }
  return client;
}

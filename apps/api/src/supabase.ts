import { createClient } from "@supabase/supabase-js";

// No generated Database types yet (would need `supabase gen types` against
// the shared altship project) -- typing the client as `any` here rather
// than fighting strict-by-default table inference until that exists.
let client: ReturnType<typeof createClient<any>> | undefined;

/**
 * Server-side Supabase client using the service_role key (bypasses row-level
 * security). Used only as storage for the deployments table.
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

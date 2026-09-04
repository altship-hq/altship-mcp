import { createSharedSupabaseClient } from "@altship/shared";

export const supabase = createSharedSupabaseClient({
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  cookieDomain: import.meta.env.VITE_AUTH_COOKIE_DOMAIN,
});

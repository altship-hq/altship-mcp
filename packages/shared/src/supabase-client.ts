import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createCookieStorage } from "./cookie-storage.js";

export interface SharedAuthConfig {
  url: string;
  anonKey: string;
  /** The cookie domain sessions are shared under, e.g. ".altship.io" in production or "localhost" in dev. */
  cookieDomain: string;
}

/**
 * A Supabase client configured to share its session across every altship
 * subdomain via a cookie, instead of the default origin-scoped localStorage.
 * Every altship product should construct its client through this function
 * with the same cookieDomain, so signing in on one is visible on all of them.
 */
export function createSharedSupabaseClient(config: SharedAuthConfig): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: {
      storage: createCookieStorage(config.cookieDomain),
    },
  });
}

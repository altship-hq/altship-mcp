import { useEffect, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

// Sign-in for the dashboard: GitHub, Google, or email and password through
// Supabase Auth. The session lives in this origin's localStorage; API requests
// send its access token as a bearer token (see http.ts).

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { flowType: "pkce" },
});

export type Provider = "github" | "google";

/** Sends the browser to the provider; it comes back to `next` (a dashboard path) signed in. */
export async function signIn(provider: Provider, next: string) {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: new URL(next, window.location.origin).toString() },
  });
  if (error) throw error;
}

/** Signs in with email and password. */
export async function signInWithPassword(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/**
 * Creates an email-and-password account. Returns true when the user must
 * confirm their email first (Supabase's default); the link brings them back
 * to `next` signed in.
 */
export async function signUp(email: string, password: string, next: string): Promise<boolean> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: new URL(next, window.location.origin).toString() },
  });
  if (error) throw error;
  return data.session === null;
}

/** Emails a link to /reset-password, where the user (signed in by the link) picks a new password. */
export async function sendPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: new URL("/reset-password", window.location.origin).toString(),
  });
  if (error) throw error;
}

export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/** The current session, or null when signed out; undefined until Supabase has checked. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

export async function accessToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

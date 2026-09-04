import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthFormProps {
  supabase: SupabaseClient;
  title?: string;
  subtitle?: string;
  /** Called after a successful sign-in (not sign-up, which requires email confirmation first). */
  onSignedIn?: () => void;
}

/** A minimal email/password sign-in and sign-up form, shared by every altship product's auth entry point. */
export function AuthForm({ supabase, title = "AltShip", subtitle, onSignedIn }: AuthFormProps) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit() {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "sign-in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onSignedIn?.();
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setInfo("Account created. Check your email to confirm, then sign in.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h1>{title}</h1>
      {subtitle && <p className="subtitle">{subtitle}</p>}

      <label htmlFor="email">Email</label>
      <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !loading && submit()}
      />

      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner warning">{info}</div>}

      <div className="actions">
        <button className="secondary" onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}>
          {mode === "sign-in" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
        <button disabled={loading || !email || !password} onClick={submit}>
          {loading ? "Working…" : mode === "sign-in" ? "Sign in" : "Sign up"}
        </button>
      </div>
    </div>
  );
}

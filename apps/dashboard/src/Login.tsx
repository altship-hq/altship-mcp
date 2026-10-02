import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { sendPasswordReset, signIn, signInWithPassword, signUp, updatePassword, type Provider } from "./auth.js";
import { navigate } from "./router.js";
import logoMark from "./assets/logo-mark.png";

/** Where to go after signing in: the ?next= path, if it's a dashboard path. */
export function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const MIN_PASSWORD_LENGTH = 8;

type Mode = "signin" | "signup" | "forgot";

const TITLES: Record<Mode, { title: string; copy: string }> = {
  signin: { title: "Sign in", copy: "Build, deploy and run MCP servers and agents." },
  signup: { title: "Create your account", copy: "Build, deploy and run MCP servers and agents." },
  forgot: { title: "Reset your password", copy: "We'll email you a link to choose a new password." },
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Card layout shared by the sign-in and reset-password pages. */
function LoginCard({ title, copy, children }: { title: string; copy: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — altship. pilot`;
  }, [title]);

  return (
    <div className="login">
      <div className="login-card">
        <a className="login-brand" href="https://altship.io" aria-label="altship home">
          <img src={logoMark} alt="" width="28" height="28" />
          <span>altship.</span>
          <span className="side-brand-product">pilot</span>
        </a>
        <h1>{title}</h1>
        <p className="login-intro">{copy}</p>
        {children}
      </div>
      <p className="login-legal">
        By continuing you agree to the <a href="https://altship.io/terms/">Terms</a> and{" "}
        <a href="https://altship.io/privacy/">Privacy Policy</a>.
      </p>
    </div>
  );
}

export default function Login() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<Provider | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function startOAuth(provider: Provider) {
    setPending(provider);
    setError(null);
    try {
      await signIn(provider, nextPath());
    } catch (err) {
      setError(errorText(err, "Couldn't start sign-in."));
      setPending(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending("email");
    setError(null);
    setNotice(null);
    try {
      if (mode === "signin") {
        // On success the session listener in main.tsx moves on to ?next=.
        await signInWithPassword(email.trim(), password);
      } else if (mode === "signup") {
        const mustConfirm = await signUp(email.trim(), password, nextPath());
        if (mustConfirm) {
          setNotice(`We've sent a confirmation link to ${email.trim()}. Open it to finish creating your account.`);
          setPassword("");
        }
      } else {
        await sendPasswordReset(email.trim());
        setNotice(`If an account exists for ${email.trim()}, we've emailed it a link to reset the password.`);
      }
    } catch (err) {
      setError(errorText(err, "Something went wrong. Try again."));
    }
    setPending(null);
  }

  const { title, copy } = TITLES[mode];
  const busy = pending !== null;

  return (
    <LoginCard title={title} copy={copy}>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="login-notice" role="status">
          {notice}
        </p>
      )}

      {mode !== "forgot" && (
        <>
          <div className="login-actions">
            <button type="button" className="login-provider" disabled={busy} onClick={() => startOAuth("github")}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                />
              </svg>
              {pending === "github" ? "Redirecting…" : "Continue with GitHub"}
            </button>
            <button type="button" className="login-provider" disabled={busy} onClick={() => startOAuth("google")}>
              <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
              </svg>
              {pending === "google" ? "Redirecting…" : "Continue with Google"}
            </button>
          </div>
          <div className="login-divider" role="separator">
            <span>or</span>
          </div>
        </>
      )}

      <form className="login-form" onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </label>
        {mode !== "forgot" && (
          <label>
            <span className="login-label-row">
              Password
              {mode === "signin" && (
                <button type="button" className="login-link" onClick={() => switchMode("forgot")}>
                  Forgot password?
                </button>
              )}
            </span>
            <input
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? MIN_PASSWORD_LENGTH : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            {mode === "signup" && <span className="login-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>}
          </label>
        )}
        <button type="submit" className="login-submit" disabled={busy}>
          {pending === "email"
            ? "Please wait…"
            : mode === "signin"
              ? "Sign in"
              : mode === "signup"
                ? "Create account"
                : "Email me a reset link"}
        </button>
      </form>

      <p className="login-switch">
        {mode === "signin" ? (
          <>
            New to altship?{" "}
            <button type="button" className="login-link" onClick={() => switchMode("signup")}>
              Create an account
            </button>
          </>
        ) : (
          <>
            {mode === "signup" ? "Already have an account? " : "Remembered it? "}
            <button type="button" className="login-link" onClick={() => switchMode("signin")}>
              Sign in
            </button>
          </>
        )}
      </p>
    </LoginCard>
  );
}

/** /reset-password: the emailed reset link signs the user in here to choose a new password. */
export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await updatePassword(password);
      navigate("");
    } catch (err) {
      setError(errorText(err, "Couldn't update your password. Try again."));
      setPending(false);
    }
  }

  return (
    <LoginCard title="Choose a new password" copy="You'll use it to sign in from now on.">
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <form className="login-form" onSubmit={submit}>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending}
          />
          <span className="login-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
        </label>
        <label>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={pending}
          />
        </label>
        <button type="submit" className="login-submit" disabled={pending}>
          {pending ? "Saving…" : "Save password"}
        </button>
      </form>
    </LoginCard>
  );
}

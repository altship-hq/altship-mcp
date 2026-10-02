import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import Shell from "./Shell.js";
import Login, { OAuthConsent, ResetPassword, nextPath } from "./Login.js";
import { useSession } from "./auth.js";
import { navigate, usePath } from "./router.js";
import "./products/mcp/builder.css";
import "./dashboard.css";
import "./products/agents/agents.css";

// Every page needs a signed-in user except /login, which sends signed-in
// users on to where they were going. /reset-password is where an emailed
// reset link (which signs the user in) lets them choose a new password, and
// /oauth/consent is where MCP clients (claude.ai, ChatGPT) ask for access.
function Root() {
  const path = usePath();
  const session = useSession();
  const onLogin = path === "login";

  useEffect(() => {
    if (session === null && !onLogin) {
      navigate(`login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    } else if (session && onLogin) {
      navigate(nextPath().slice(1));
    }
  }, [session, onLogin]);

  if (session === undefined) return null;
  if (onLogin) return session ? null : <Login />;
  if (path === "reset-password") return session ? <ResetPassword /> : null;
  if (path === "oauth/consent") return session ? <OAuthConsent /> : null;
  return session ? <Shell path={path} session={session} /> : null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

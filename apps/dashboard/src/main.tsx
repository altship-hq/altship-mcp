import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Shell from "./Shell.js";
import { usePath } from "./router.js";
import "./products/mcp/builder.css";
import "./dashboard.css";
import "./products/agents/agents.css";

function Root() {
  return <Shell path={usePath()} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

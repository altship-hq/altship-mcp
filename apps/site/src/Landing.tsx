import { useEffect, useRef, useState } from "react";
import logoMark from "./assets/logo-mark.png";

// Marketing page for altship.io/mcp, styled to match the altship.io landing
// page. "Start building" goes to MCP Creator in the dashboard (pilot.altship.io).

const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL ?? (import.meta.env.DEV ? "http://localhost:5173" : "https://pilot.altship.io");
const START_BUILDING_URL = `${DASHBOARD_URL}/mcp`;

const STEPS = [
  {
    title: "Import your spec",
    copy: "Point us at an OpenAPI 3.x spec by URL or path. We parse and validate it, and flag anything an agent would trip over.",
  },
  {
    title: "Review the tools",
    copy: "Every operation becomes a tool, grouped by namespace. Destructive and sensitive operations are flagged and start unselected.",
  },
  {
    title: "Generate the server",
    copy: "Get an agent-friendly MCP server for the tools you picked — source, tests and deployment docs included.",
  },
  {
    title: "Deploy it",
    copy: "Ship to a managed endpoint on Vercel, or take the code and run it on your own infrastructure.",
  },
];

const OPTIONS = [
  {
    title: "Self-hosted",
    copy: "Export the source with a Dockerfile, environment variable docs and generated tests. Run it anywhere.",
  },
  {
    title: "Managed",
    copy: "Deploy to Vercel in one step and get a live MCP endpoint, listed under Your MCPs.",
  },
  {
    title: "Your auth, kept",
    copy: "Use a static API key, or pass each caller's bearer token straight through to your API.",
  },
];

const SPEC_LINES = [
  ["GET", "/orders/{id}"],
  ["POST", "/orders"],
  ["PATCH", "/orders/{id}"],
  ["DELETE", "/orders/{id}"],
];

const TOOL_LINES: [string, string][] = [
  ["orders.get", "ready"],
  ["orders.create", "ready"],
  ["orders.update", "ready"],
  ["orders.delete", "destructive"],
];

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);

  // Swap the wordmark for the logo mark once the hero scrolls away, as on altship.io.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [menuOpen]);

  const navClass = ["nav", scrolled && "is-scrolled", menuOpen && "menu-open"].filter(Boolean).join(" ");

  return (
    <div className="mx">
      <header className={navClass} ref={navRef}>
        <a className="brand" href="/" aria-label="altship home">
          <img className="brand-mark" src={logoMark} alt="" width="30" height="30" />
          <span className="brand-text">altship.</span>
          <span className="brand-product">MCP Creator</span>
        </a>
        <button
          className="nav-toggle"
          type="button"
          aria-expanded={menuOpen}
          aria-controls="mx-nav-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className="nav-right" id="mx-nav-menu" onClick={(e) => (e.target as HTMLElement).closest("a") && setMenuOpen(false)}>
          <nav className="links" aria-label="MCP Creator">
            <a href="#how">How it works</a>
            <a href="#deploy">Deployment</a>
            <a href="/">altship ↗</a>
          </nav>
          <a className="nav-cta" href={START_BUILDING_URL}>
            Start building
          </a>
        </div>
      </header>

      <section className="hero" ref={heroRef}>
        <div>
          <p className="eyebrow">01 — MCP Creator</p>
          <h1>
            Your API,
            <br />
            ready for
            <br />
            <em>every agent.</em>
          </h1>
          <p className="description">
            Give us an OpenAPI spec. We validate it, turn it into an agent-friendly MCP server, test it, and deploy it.
          </p>
          <div className="hero-actions">
            <a className="primary" href={START_BUILDING_URL}>
              Start building <span aria-hidden="true">↗</span>
            </a>
            <a className="secondary" href="#how">
              How it works
            </a>
          </div>
        </div>
        <figure className="spec-panel" aria-label="An OpenAPI spec's operations becoming MCP tools">
          <div className="panel-block">
            <div className="panel-label">openapi.yaml</div>
            {SPEC_LINES.map(([method, path]) => (
              <div className="panel-row" key={method + path}>
                <span className="method">{method}</span>
                <span>{path}</span>
              </div>
            ))}
          </div>
          <div className="panel-arrow" aria-hidden="true">
            ↓
          </div>
          <div className="panel-block">
            <div className="panel-label">mcp tools</div>
            {TOOL_LINES.map(([name, status]) => (
              <div className="panel-row" key={name}>
                <span>{name}</span>
                <span className={`status ${status}`}>{status}</span>
              </div>
            ))}
          </div>
          <figcaption>Validated · Tested · Deployed</figcaption>
        </figure>
      </section>

      <section className="section" id="how" aria-labelledby="mx-how-title">
        <div className="section-head">
          <h2 className="section-title" id="mx-how-title">
            From spec to server in four steps.
          </h2>
          <span className="placeholder">How it works</span>
        </div>
        <ol className="steps">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <span className="number">{String(i + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" id="deploy" aria-labelledby="mx-deploy-title">
        <div className="section-head">
          <h2 className="section-title" id="mx-deploy-title">
            Run it your way.
          </h2>
          <span className="placeholder">Deployment</span>
        </div>
        <div className="outline">
          {OPTIONS.map((option) => (
            <div key={option.title}>
              <strong>{option.title}</strong>
              <p>{option.copy}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer">
        <span>altship.</span>
        <nav className="footer-links" aria-label="altship">
          <a href="/">Home</a>
          <a href="#how">How it works</a>
          <a href={START_BUILDING_URL}>Start building</a>
        </nav>
        <span>Build what's next. Run it your way.</span>
      </footer>
    </div>
  );
}

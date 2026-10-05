import { useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import Profile from "./Profile.js";
import { Icon, PRODUCTS } from "./products.js";
import { Link } from "./router.js";
import Home from "./Home.js";
import McpProduct from "./products/mcp/McpProduct.js";
import AgentsProduct from "./products/agents/AgentsProduct.js";
import ObservabilityProduct from "./products/observability/ObservabilityProduct.js";
import logoMark from "./assets/logo-mark.png";

// pilot.altship.io: one dashboard for every altship product. Sidebar + top
// bar here; each live product renders its own pages under /<product id>.

function resolve(path: string) {
  const [first = "", ...rest] = path.split("/");
  const product = PRODUCTS.find((p) => p.id === first && p.status === "live");
  const subpath = rest.join("/");
  const page = product?.pages.find((p) => p.path === subpath) ?? product?.dynamicPage?.(subpath) ?? undefined;
  return { product, subpath, page, isHome: path === "" };
}

export default function Shell({ path, session }: { path: string; session: Session }) {
  const { product, subpath, page, isHome } = resolve(path);
  const title = isHome ? "Home" : product && page ? `${page.label} · ${product.name}` : "Not found";

  useEffect(() => {
    document.title = `${title} — altship. pilot`;
  }, [title]);

  return (
    <div className="dash">
      <aside className="sidebar">
        <Link className="side-brand" to="" aria-label="altship pilot home">
          <img src={logoMark} alt="" width="24" height="24" />
          <span>altship.</span>
          <span className="side-brand-product">pilot</span>
        </Link>

        <nav className="side-nav" aria-label="Dashboard">
          <div className="side-label">Personal</div>
          <Link to="" aria-current={isHome ? "page" : undefined}>
            <Icon>
              <path d="M3 8.5 10 3l7 5.5V17H12.5v-4.5h-5V17H3z" />
            </Icon>
            Home
          </Link>

          <div className="side-label">Products</div>
          {PRODUCTS.map((p) =>
            p.status === "live" ? (
              <div key={p.id} className="side-product">
                <Link to={p.id} aria-current={product?.id === p.id && subpath === "" ? "page" : undefined} className={product?.id === p.id ? "in-product" : undefined}>
                  <Icon>{p.icon}</Icon>
                  {p.name}
                </Link>
                <div className="side-sub">
                  {p.pages
                    .filter((pg) => pg.path !== "")
                    .map((pg) => (
                      <Link key={pg.path} to={`${p.id}/${pg.path}`} aria-current={product?.id === p.id && subpath === pg.path ? "page" : undefined}>
                        {pg.label}
                      </Link>
                    ))}
                </div>
              </div>
            ) : (
              <span key={p.id} className="side-soon" aria-disabled="true" title={p.description}>
                <Icon>{p.icon}</Icon>
                {p.name}
                <span className="soon-tag">Soon</span>
              </span>
            ),
          )}
        </nav>

        <div className="side-foot">
          <a className="side-site" href="https://altship.io">
            altship.io ↗
          </a>
          <Profile user={session.user} />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>Personal</span>
            {product && (
              <>
                <span aria-hidden="true">/</span>
                {page && subpath !== "" ? <Link to={product.id}>{product.name}</Link> : <strong>{product.name}</strong>}
              </>
            )}
            {(isHome || (page && subpath !== "")) && (
              <>
                <span aria-hidden="true">/</span>
                <strong>{isHome ? "Home" : page!.label}</strong>
              </>
            )}
          </div>
        </header>

        <main className="content">
          {isHome ? (
            <Home />
          ) : product?.id === "mcp" && page ? (
            <McpProduct subpath={subpath} />
          ) : product?.id === "agents" && page ? (
            <AgentsProduct subpath={subpath} />
          ) : product?.id === "observability" && page ? (
            <ObservabilityProduct />
          ) : (
            <div className="empty">
              <p>This page doesn't exist.</p>
              <Link className="btn" to="">
                Back to Home
              </Link>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

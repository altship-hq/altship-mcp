import { Icon, PRODUCTS } from "./products.js";
import { Link } from "./router.js";
import { PageHead } from "./ui.js";

export default function Home() {
  return (
    <>
      <PageHead title="Welcome to altship" description="Every altship product in one place. Pick one to get started." />
      <ul className="product-grid">
        {PRODUCTS.map((p) => (
          <li key={p.id} className={p.status === "soon" ? "product-card soon" : "product-card"}>
            <div className="product-card-head">
              <Icon>{p.icon}</Icon>
              <h2>{p.name}</h2>
              {p.status === "soon" && <span className="soon-tag">Coming soon</span>}
            </div>
            <p>{p.description}</p>
            {p.status === "live" && (
              <Link className="btn" to={p.id}>
                Open {p.name} →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

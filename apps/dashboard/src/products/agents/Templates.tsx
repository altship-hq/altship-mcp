import { useState } from "react";
import { Link } from "../../router.js";
import { PageHead } from "../../ui.js";
import { CATEGORIES, TEMPLATES, templateNeeds, type AgentTemplate } from "./agentTemplates.js";

// /agents/templates: ready-made agents to start from. Picking one opens the
// New agent form filled in; nothing is created until the plan is approved.

export function TemplateCard({ template }: { template: AgentTemplate }) {
  const needs = templateNeeds(template);
  return (
    <Link className="template-card" to={`agents/new?template=${template.id}`}>
      <span className="template-category">{template.category}</span>
      <strong>{template.name}</strong>
      <p>{template.summary}</p>
      <span className="template-needs">
        {needs.length === 0 ? "Nothing to set up" : `Needs: ${needs.join(", ")}`}
        {template.schedulable ? " · Can run on a schedule" : ""}
      </span>
      <span className="template-use">Use this template →</span>
    </Link>
  );
}

export default function Templates() {
  const [category, setCategory] = useState<AgentTemplate["category"] | null>(null);
  const shown = category ? TEMPLATES.filter((t) => t.category === category) : TEMPLATES;

  return (
    <>
      <PageHead
        title="Templates"
        description="Ready-made agents to start from. Pick one, connect what it needs, and review the plan before anything is created. It uses your own apps, servers and memory."
        action={
          <Link className="btn" to="agents/new">
            + Start from scratch
          </Link>
        }
      />
      <div className="template-filters" role="group" aria-label="Category">
        <button type="button" className={category === null ? "is-on" : ""} aria-pressed={category === null} onClick={() => setCategory(null)}>
          All
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} type="button" className={category === c ? "is-on" : ""} aria-pressed={category === c} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="template-grid">
        {shown.map((t) => (
          <TemplateCard key={t.id} template={t} />
        ))}
      </div>
    </>
  );
}

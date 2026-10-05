import type { ReactNode } from "react";

// Every altship product the dashboard knows about. A live product owns the
// routes under /<id> and lists its pages here so the shell can build the
// sidebar and breadcrumbs; the product's own component renders them.

export interface ProductPage {
  /** Path under the product, "" for its overview. */
  path: string;
  label: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  status: "live" | "soon";
  icon: ReactNode;
  /** Fixed pages; those with a non-empty path appear under the product in the sidebar. */
  pages: ProductPage[];
  /** Pages with a variable path (e.g. /agents/<id>), for breadcrumbs and routing. */
  dynamicPage?: (subpath: string) => ProductPage | null;
}

export const PRODUCTS: Product[] = [
  {
    id: "mcp",
    name: "MCP Creator",
    description: "Turn an OpenAPI spec into a production-ready, agent-friendly MCP server.",
    status: "live",
    icon: (
      <>
        <rect x="3" y="3.5" width="14" height="5" />
        <rect x="3" y="11.5" width="14" height="5" />
        <path d="M6 6h.01M6 14h.01" />
      </>
    ),
    pages: [
      { path: "", label: "Overview" },
      { path: "servers", label: "MCP servers" },
      { path: "new", label: "New server" },
      { path: "memory/new", label: "New memory" },
    ],
    dynamicPage: (subpath) => (/^servers\/[^/]+$/.test(subpath) ? { path: subpath, label: "Server" } : null),
  },
  {
    id: "agents",
    name: "Agent Creator",
    description: "Build standalone agents, orchestrate them together, and give them the MCP servers you've created.",
    status: "live",
    icon: (
      <>
        <rect x="4" y="6" width="12" height="10" rx="2" />
        <path d="M10 3v3M7.5 10.5h.01M12.5 10.5h.01M8 13.5h4" />
      </>
    ),
    pages: [
      { path: "", label: "Overview" },
      { path: "new", label: "New agent" },
    ],
    dynamicPage: (subpath) => {
      const match = subpath.match(/^agt_[a-z0-9]+(?:\/(flow|deploy|runs))?$/);
      if (!match) return null;
      return { path: subpath, label: match[1] === "deploy" ? "Deploy" : match[1] === "runs" ? "Runs" : match[1] === "flow" ? "Flow" : "Playground" };
    },
  },
  {
    id: "observability",
    name: "Observability",
    description: "Logs for your MCP servers and agents: every tool call and agent run, how it went and how long it took.",
    status: "live",
    icon: <path d="M3 16h14M5 13l3-4 3 2 4-6" />,
    pages: [
      { path: "", label: "Tool calls" },
      { path: "agents", label: "Agent runs" },
    ],
  },
  {
    id: "gateway",
    name: "Agent Gateway",
    description: "One entry point for agent traffic, with rate limits and routing.",
    status: "soon",
    icon: <path d="M4 10h12M12 6l4 4-4 4M4 4v12" />,
    pages: [],
  },
  {
    id: "identity",
    name: "Agent Identity",
    description: "Give agents identities and control what each one may do.",
    status: "soon",
    icon: (
      <>
        <circle cx="10" cy="7.5" r="3" />
        <path d="M4.5 16.5c1-3 3-4.5 5.5-4.5s4.5 1.5 5.5 4.5" />
      </>
    ),
    pages: [],
  },
  {
    id: "runtime",
    name: "Agent Runtime",
    description: "Run long-lived agents with managed state and scheduling.",
    status: "soon",
    icon: (
      <>
        <circle cx="10" cy="10" r="6.5" />
        <path d="M8.5 7.5v5l4-2.5z" />
      </>
    ),
    pages: [],
  },
  {
    id: "sandbox",
    name: "Agent Sandbox",
    description: "Isolated environments for agents to execute code safely.",
    status: "soon",
    icon: <path d="M10 3 16.5 6.5v7L10 17l-6.5-3.5v-7zM3.5 6.5 10 10l6.5-3.5M10 10v7" />,
    pages: [],
  },
];

export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

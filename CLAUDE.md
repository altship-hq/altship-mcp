# AltShip MCP — Project Brief

> Give this file to Claude Code at the start of every session.
> Full product vision lives below; source spec was `mcp-server-platform.md`.

---

## What We're Building

A developer infrastructure platform that turns any company's OpenAPI specification into a **production-ready, agent-friendly MCP server** — without the company needing to learn or maintain the Model Context Protocol.

Promise: **Give us your OpenAPI spec. We validate it, turn it into an agent-friendly MCP server, test it, deploy it, and help you operate it.**

Not just a generator — the long-term value is the full lifecycle: design, validation, testing, security, deployment, observability, versioning.

---

## V1 Scope (build this first, nothing more)

```
1. Import OpenAPI 3.x (URL or uploaded yaml/json)
        ↓
2. Validate + normalize specification
        ↓
3. Generate agent-friendly MCP tools
        ↓
4. Generate MCP server
        ↓
5. Test tools through an MCP client (playground)
        ↓
6. Deploy and return an MCP endpoint
```

### V1 Requirements
- OpenAPI URL import + YAML/JSON file import
- OpenAPI structural + quality validation
- Endpoint discovery → tool design (e.g. `GET /v1/customers/{id}` → `customers.get`)
- Tool selection UI (approve/exclude endpoints, flag destructive/sensitive ops)
- Tool name/description generation
- API key / bearer-token authentication (credentials resolved from env vars, never embedded in generated code)
- MCP server generation (`tools/list`, `tools/call`, input validation, API request execution)
- Basic MCP playground (connect, list tools, call tools, inspect schemas/responses/timing)
- Automated smoke tests (spec tests, MCP protocol tests, API connectivity tests)
- Docker packaging
- Managed deployment + health status + request/error logs + basic latency metrics

### Explicitly Out of Scope for V1
General agent runtime, full agent gateway, agent identity/authz policy, multi-agent orchestration, agent memory/sandboxing, GraphQL/DB/SDK import, repo-wide API discovery, multi-region deploy, advanced RBAC, full observability platform, large-scale eval infra.

---

## Core User Flow

```
OpenAPI Spec → Import → Validate → Normalize/Suggest Fixes → Discover Operations
  → Design Agent-Friendly Tools → Customer Reviews/Selects Tools → Configure Auth
  → Generate MCP Server → Test → Agent Evaluation → Deploy → Observe + Version
```

## Tool Design Principles

Don't blindly convert every HTTP endpoint into a tool. `GET /v1/customers/{customerId}` becomes `customers.get` with a clear description and a clean input schema (e.g. `customer_id` instead of raw path param). The design layer should improve names/descriptions, group related operations, hide internal endpoints, flag destructive/sensitive ops, and recommend which operations to expose. The customer always reviews/modifies the proposed surface before generation.

## Security Rules (non-negotiable)

- Credentials never embedded in generated source — resolved from env vars / secret manager at runtime
- Secrets must never appear in logs, model prompts, tool descriptions, generated repos, error messages, or telemetry
- Validate all tool inputs against JSON schema before executing
- Rate limiting, timeouts, request size limits, SSRF protections, restricted outbound networking
- Audit log every tool call
- Flag destructive/sensitive operations explicitly in the tool surface

## Deployment Models

- **Managed**: we host at `https://mcp.example.com/<customer>`, handle containers/TLS/scaling/secrets/logging
- **Self-hosted**: export source + Dockerfile + env var docs + deployment instructions + generated tests

## Observability

Every hosted server captures: MCP requests, tool calls (name/duration/status), API latency, HTTP status, errors, auth failures, request volume. Use OpenTelemetry-compatible instrumentation — no proprietary lock-in.

## Versioning

MCP servers are tied to a specific API spec version. When the spec changes, detect new/removed endpoints, changed params/schemas/auth, and show the effect on the generated tools before the customer redeploys.

## Positioning

Not "AI that generates MCP servers" (generation is commoditizing). Position around production readiness: **"Turn your API into a production-ready MCP server."** / **"The fastest path from API to production MCP."**

---

## Future Direction (do not build yet)

- Additional inputs: GraphQL, SDKs, databases, GitHub repos, manual tool authoring
- Broader suite: MCP Build+Deploy → Observability → Agent Gateway → Agent Identity/Policy → Agent Runtime → Agent Sandbox — each usable independently, no forced coupling

---

## Key Rules for Claude Code

- Generated MCP servers must be understandable and portable — no proprietary runtime behavior required to run them
- Never write credentials into generated repositories
- Every generated tool must validate its inputs against a JSON schema before calling the underlying API
- Keep V1 scope tight — resist adding items from "Future Direction" until the six V1 steps work end-to-end
- Full spec detail: see `docs/mcp-server-platform.md`

# AltShip MCP

Turn an OpenAPI 3.x specification into a production-ready, agent-friendly MCP server — validated, tested, and deployable.

See [CLAUDE.md](./CLAUDE.md) for the full product brief and [docs/mcp-server-platform.md](./docs/mcp-server-platform.md) for the original spec.

## Planned layout

```
altship-mcp/
├── apps/
│   ├── api/          → import, validation, tool-design, generation orchestration
│   ├── web/           → tool selection UI + playground
│   └── worker/         → spec parsing, MCP server generation, deploy jobs
├── packages/
│   ├── openapi/        → OpenAPI parsing + structural/quality validation
│   ├── tool-design/     → endpoint → MCP tool mapping heuristics
│   ├── mcp-gen/         → MCP server code generation (templates)
│   └── shared/          → shared types
├── docs/
└── CLAUDE.md
```

## Status

Project scaffold only — nothing implemented yet. Start with V1 requirements in `CLAUDE.md`.

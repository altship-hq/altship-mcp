# MCP Server Platform

## Product Vision

Build a developer infrastructure platform that allows any company with an API to turn that API into a **production-ready, agent-friendly MCP server** without having to learn or maintain the Model Context Protocol themselves.

The initial product should focus on a simple promise:

> **Give us your OpenAPI specification. We will validate it, turn it into an agent-friendly MCP server, test it, deploy it, and help you operate it.**

The product is not just an MCP code generator. The long-term value is the full lifecycle around MCP servers: **design, validation, testing, security, deployment, observability, and versioning**.

---

## 1. Initial Customer

The initial customer is a company or developer that already has a REST API and wants AI agents, assistants, IDEs, or other MCP-compatible clients to interact with their product.

Examples include:

- SaaS platforms
- Developer tools
- Fintech APIs
- Booking platforms
- E-commerce platforms
- Internal enterprise APIs
- Infrastructure APIs

The customer should not need to redesign or rebuild their API.

Their existing API remains the source of truth. We create an MCP layer in front of it.

```text
AI Agent / MCP Client
        │
        │ MCP
        ▼
Generated MCP Server
        │
        │ REST API
        ▼
Customer's Existing API
```

---

## 2. V1 Input

For the first version, support **OpenAPI 3.x** APIs.

The customer can provide either:

1. An OpenAPI specification URL
2. An uploaded `openapi.yaml` file
3. An uploaded `openapi.json` file

Example:

```text
https://api.acme.com/openapi.json
```

We should not initially attempt to discover an API from only its base URL.

For example, this is not sufficient for V1:

```text
https://api.acme.com
```

The OpenAPI specification gives us structured information about:

- API name
- Base URLs
- Endpoints
- HTTP methods
- Parameters
- Request bodies
- Response schemas
- Authentication schemes
- Operation descriptions
- Operation IDs

---

## 3. Core User Flow

```text
OpenAPI Spec
     │
     ▼
Import
     │
     ▼
Validate Specification
     │
     ▼
Normalize / Suggest Fixes
     │
     ▼
Discover API Operations
     │
     ▼
Design Agent-Friendly Tools
     │
     ▼
Customer Reviews / Selects Tools
     │
     ▼
Configure Authentication
     │
     ▼
Generate MCP Server
     │
     ▼
Test MCP Server
     │
     ▼
Agent Evaluation
     │
     ▼
Deploy
     │
     ▼
Observe + Version
```

---

## 4. OpenAPI Validation

Before generating an MCP server, validate the customer's specification.

### Structural Validation

Check for issues such as:

- Invalid OpenAPI syntax
- Invalid references
- Circular references
- Missing schemas
- Invalid parameter definitions
- Incorrect required fields
- Unsupported schema constructs
- Invalid security definitions
- Duplicate operation IDs

### Quality Validation

A technically valid OpenAPI specification may still be poor for agents.

Identify issues such as:

- Missing operation IDs
- Weak operation descriptions
- Ambiguous endpoint descriptions
- Poor parameter descriptions
- Extremely large response schemas
- Inconsistent naming
- Duplicate or overlapping operations
- Internal endpoints that should probably not become tools

The platform should show recommendations and allow the developer to approve fixes before generation.

---

## 5. Tool Design Layer

Do not blindly convert every HTTP endpoint into an MCP tool.

The platform should create an **agent-friendly tool surface**.

For example:

```text
GET /v1/customers/{customerId}
```

might become:

```text
customers.get
```

with a clear description:

> Retrieve a customer using their customer ID.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "customer_id": {
      "type": "string",
      "description": "The unique identifier of the customer."
    }
  },
  "required": ["customer_id"]
}
```

The tool-design layer should eventually be able to:

- Improve tool names
- Improve descriptions
- Improve parameter descriptions
- Group related operations
- Hide internal endpoints
- Flag destructive operations
- Flag sensitive operations
- Reduce unnecessarily complicated schemas
- Detect tools with overlapping purposes
- Recommend which operations should be exposed

The customer should always be able to review and modify the proposed tool surface.

---

## 6. Tool Selection UI

After importing the API, show discovered operations grouped logically.

Example:

```text
Customers

[x] GET  /customers
    → customers.list

[x] GET  /customers/{id}
    → customers.get

[ ] DELETE /customers/{id}
    → customers.delete
    ⚠ Destructive operation

Payments

[x] GET /payments/{id}
    → payments.get

[ ] POST /payments/{id}/refund
    → payments.refund
    ⚠ Sensitive financial operation
```

Users choose which capabilities their MCP server exposes.

---

## 7. Authentication

The platform should inspect the OpenAPI specification for authentication requirements.

Initial supported authentication methods can include:

- API keys
- Bearer tokens
- Basic authentication

OAuth can follow as the product matures.

Credentials must never be embedded directly into generated source code.

Instead, the MCP server should resolve credentials from environment variables or a secret-management layer.

Example:

```text
ACME_API_TOKEN
```

Hosted deployments should store credentials securely and expose only references internally.

```text
Agent
  ↓
MCP Server
  ↓
Resolve credential
  ↓
Customer API
```

Secrets must not appear in:

- Logs
- Model prompts
- Tool descriptions
- Generated repositories
- Error messages
- Telemetry

---

## 8. MCP Server Generation

Once the API and tools are configured, generate a real MCP server implementation.

The generated server acts as an adapter between MCP and the customer's existing API.

```text
MCP request
    ↓
Tool handler
    ↓
API client
    ↓
Customer API
    ↓
API response
    ↓
Normalize result
    ↓
MCP response
```

A generated project might look like:

```text
acme-mcp/
│
├── cmd/
│   └── server/
│       └── main.go
│
├── internal/
│   ├── tools/
│   │   ├── customers_get.go
│   │   ├── customers_list.go
│   │   └── bookings_create.go
│   │
│   ├── client/
│   │   └── acme_api.go
│   │
│   ├── auth/
│   │   └── auth.go
│   │
│   └── config/
│       └── config.go
│
├── tests/
│   ├── tools_test.go
│   └── integration_test.go
│
├── Dockerfile
├── go.mod
└── README.md
```

The exact generated implementation can evolve, but generated servers should be understandable and portable rather than requiring proprietary runtime behavior.

---

## 9. Testing

Testing is a core part of the product.

The platform should test at multiple levels.

### Specification Tests

Verify that the imported specification can reliably produce tools.

### MCP Protocol Tests

Verify that the generated server:

- Starts successfully
- Responds correctly
- Lists tools
- Accepts tool calls
- Validates inputs
- Returns valid MCP responses
- Handles API failures correctly

### API Connectivity Tests

Using developer-provided test credentials, verify that the generated tools can communicate with the underlying API.

Check:

- Authentication
- Connectivity
- Status codes
- Request serialization
- Response parsing
- Error handling

### Agent Usability Tests

A tool can be technically correct while still being difficult for an LLM to use.

Run agent evaluations that test whether an agent can:

- Select the correct tool
- Supply valid arguments
- Distinguish similar tools
- Understand tool descriptions
- Interpret responses
- Recover from errors

Example test:

```text
Task:
"Find the customer whose email is john@example.com."

Expected tool:
customers.search

Result:
✓ Correct tool selected
✓ Correct arguments
✓ Successful execution
✓ Response understood
```

Provide an agent-readiness score and actionable recommendations.

---

## 10. MCP Playground / Test Client

Build a lightweight MCP client into the platform.

This is not initially a separate commercial product. It exists to test and demonstrate generated MCP servers.

The client should support:

- Connecting to a generated MCP server
- Listing available tools
- Calling tools
- Inspecting schemas
- Handling authentication
- Displaying responses
- Displaying errors
- Showing execution timing

Example UI:

```text
MCP Playground

Server: Acme MCP
Status: Connected

Tools
────────────────────────
customers.get
customers.search
bookings.create
availability.get

Selected: customers.get

customer_id
[ cus_123                  ]

[ Run Tool ]

Result
────────────────────────
Status: Success
Duration: 142 ms

{
  "id": "cus_123",
  "name": "John Doe"
}
```

This client can also power automated testing internally.

---

## 11. Deployment

Support two deployment models.

### Managed Deployment

We host and operate the MCP server.

The customer receives an endpoint such as:

```text
https://mcp.example.com/acme
```

The platform handles:

- Containers
- Deployment
- TLS
- Scaling
- Health checks
- Configuration
- Secrets
- Updates
- Logging

### Self-Hosted Deployment

Customers can export the generated server and run it themselves.

Provide:

- Source code
- Dockerfile
- Environment variable documentation
- Deployment instructions
- Generated tests

Possible future exports:

- GitHub repository
- Docker image
- Kubernetes manifests
- Terraform
- Cloud-specific deployment configurations

---

## 12. Observability

Every hosted MCP server should have basic observability from day one.

Capture:

- MCP requests
- Tool calls
- Tool name
- Duration
- Success/failure
- API latency
- HTTP status
- Errors
- Authentication failures
- Request volume

Example dashboard:

```text
Acme MCP

Requests        18,429
Success Rate     99.4%
P95 Latency      284 ms
Tools               14

Top Tools
────────────────────────────
customers.search      6,240
customers.get         4,821
bookings.create       3,109
availability.get      2,944

Recent Errors
────────────────────────────
bookings.create       401
payments.refund       429
customers.search      500
```

Use OpenTelemetry-compatible instrumentation wherever practical so customers are not locked into proprietary telemetry.

---

## 13. Versioning

An MCP server should be tied to a specific version of the customer's API specification.

When the OpenAPI specification changes, the platform should eventually detect:

- New endpoints
- Removed endpoints
- Changed parameters
- Changed schemas
- Authentication changes
- Breaking changes

Then show the effect on the MCP server.

Example:

```text
API change detected

+ GET /customers/search
- GET /customers/find
~ POST /bookings

MCP impact

+ customers.search
- customers.find
⚠ bookings.create input schema changed
```

The customer can review the changes, rerun tests, and deploy a new MCP version.

---

## 14. Security

Security should be designed into the product rather than added later.

Important controls include:

- Secret isolation
- Input validation
- Output validation
- Request size limits
- Rate limiting
- Timeouts
- Audit logs
- Sensitive operation warnings
- Destructive operation warnings
- Credential redaction
- SSRF protections
- Restricted outbound networking where appropriate

Later versions can introduce policy controls such as:

```text
customers.get       ALLOW
customers.list      ALLOW
customers.delete    DENY
payments.refund     REQUIRE_APPROVAL
```

These capabilities can eventually evolve into a standalone Agent Gateway / Policy product.

---

## 15. What V1 Should Actually Build

Avoid trying to implement the entire long-term platform immediately.

The first usable version should do six things extremely well:

```text
1. Import OpenAPI 3.x
        ↓
2. Validate + normalize specification
        ↓
3. Generate agent-friendly MCP tools
        ↓
4. Generate MCP server
        ↓
5. Test tools through an MCP client
        ↓
6. Deploy and return an MCP endpoint
```

### V1 Requirements

- OpenAPI URL import
- YAML/JSON file import
- OpenAPI validation
- Endpoint discovery
- Tool selection
- Tool name/description generation
- API key/bearer-token authentication
- MCP server generation
- `tools/list`
- `tools/call`
- Tool input validation
- API request execution
- Basic MCP playground
- Automated smoke tests
- Docker packaging
- Managed deployment
- Health status
- Request/error logs
- Basic latency metrics

---

## 16. Explicitly Out of Scope for V1

Do not initially build:

- A general agent runtime
- A full agent gateway
- Agent identity infrastructure
- Complex authorization policies
- Multi-agent orchestration
- Agent memory
- Agent sandboxing
- Every MCP capability
- GraphQL import
- Database import
- Repository-wide API discovery
- SDK-to-MCP generation
- Multi-region deployment
- Advanced enterprise RBAC
- Full observability platform
- Large-scale AI evaluation infrastructure

These can be added based on customer demand.

---

## 17. Future Inputs

After OpenAPI works well, expand the ways developers can create MCP servers.

```text
                Create MCP Server
                       │
       ┌───────────────┼────────────────┐
       │               │                │
    OpenAPI         GraphQL          GitHub Repo
       │               │                │
       ├───────────────┼────────────────┤
       │               │                │
      SDK           Database       Manual Tools
       │               │                │
       └───────────────┼────────────────┘
                       ▼
                Tool Design Engine
                       ↓
                 MCP Generation
                       ↓
                      Test
                       ↓
                     Deploy
```

---

## 18. Future Infrastructure Products

The MCP platform can become the first product in a broader modular agent-infrastructure suite.

Suggested evolution:

```text
MCP Build + Deploy
        ↓
MCP / Agent Observability
        ↓
Agent Gateway
        ↓
Agent Identity + Policy
        ↓
Agent Runtime
        ↓
Agent Sandbox
```

Each product should remain usable independently.

Customers should be able to use:

- Our MCP server with their runtime
- Our observability with their MCP server
- Our gateway with their agents
- Our runtime with their gateway
- The entire stack together

Avoid creating unnecessary internal dependencies between products.

---

## 19. Product Positioning

Avoid positioning the product as:

> "AI that generates MCP servers."

Generation will increasingly become a commodity feature.

Position it around production readiness:

> **Turn your API into a production-ready MCP server.**

Or:

> **The fastest path from API to production MCP.**

The complete value proposition is:

```text
CONNECT
API → MCP

DESIGN
Agent-friendly tools

VALIDATE
Fix specification problems

TEST
Verify API + MCP + agent behavior

SECURE
Credentials and safe tool exposure

DEPLOY
Managed or self-hosted

OBSERVE
Requests, tools, errors and latency

VERSION
Keep MCP aligned with API changes
```

---

## 20. Core Product Principle

The product should abstract away MCP infrastructure without locking developers into our platform.

A developer should be able to think:

> "I already have an API. I want agents to use it."

And our platform should make the rest straightforward:

```text
Your API
   ↓
Our Platform
   ↓
Production MCP Server
   ↓
Any Compatible MCP Client / Agent
```

That is the initial product.

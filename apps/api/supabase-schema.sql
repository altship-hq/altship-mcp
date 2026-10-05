-- Run this once in the Supabase SQL Editor for the shared "altship" project.
-- Users sign in to the dashboard with GitHub or Google (Supabase Auth), and
-- every deployment and agent belongs to one auth.users row.

create table if not exists deployments (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Who the server is for: 'private' (the owner, their team and their keys)
  -- or 'customers' (the owner's own users, signing in with the owner's login).
  audience text not null default 'private' check (audience in ('private', 'customers')),
  created_at timestamptz not null default now(),
  api_title text not null,
  tool_names text[] not null,
  project_name text not null,
  project_id text not null,
  url text not null,
  -- Tool surface as deployed (name, description, destructive, sensitive,
  -- inputSchema) -- lets Agent Creator build its tool catalog.
  tools jsonb,
  auth_mode text
);

create index if not exists deployments_user_id_idx on deployments (user_id, created_at desc);

alter table deployments add column if not exists audience text not null default 'private'
  check (audience in ('private', 'customers'));

-- The owner's own name for the server. Null means "use the spec's title" (api_title).
alter table deployments add column if not exists name text;

alter table deployments enable row level security;

-- Only the API server (service_role key, bypasses RLS) reads or writes these
-- tables, filtering by user_id itself; with no policies, anon/user-scoped
-- keys can't see anything.

-- Migrating existing tables from the schema without sign-in (rows created
-- before then have no owner, so delete them or set user_id to your own
-- auth.users id before adding the not-null constraint):
--   alter table deployments add column if not exists user_id uuid references auth.users(id) on delete cascade;
--   alter table agents add column if not exists user_id uuid references auth.users(id) on delete cascade;
--   delete from deployments where user_id is null;
--   delete from agents where user_id is null;
--   alter table deployments alter column user_id set not null;
--   alter table agents alter column user_id set not null;
--   create index if not exists deployments_user_id_idx on deployments (user_id, created_at desc);
--   create index if not exists agents_user_id_idx on agents (user_id, created_at desc);

-- Access keys for a deployed MCP server. Only the SHA-256 hash is kept (the
-- server itself gets the same hashes as MCP_ACCESS_KEY_SHA256); the full key
-- is shown to the user once, when it's created.
create table if not exists server_keys (
  id text primary key,
  deployment_id text not null references deployments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  name text not null,
  prefix text not null,
  key_hash text not null,
  revoked_at timestamptz
);

create index if not exists server_keys_deployment_id_idx on server_keys (deployment_id, created_at desc);

alter table server_keys enable row level security;

-- Agent Creator. `plan` (altship's own AgentPlan) is the source of truth; the
-- Managed Agents IDs are the runtime copy created from it on approve.
create table if not exists agents (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  name text not null,
  description text not null,
  plan jsonb not null,
  coordinator_agent_id text not null,
  coordinator_version integer not null,
  specialist_agent_ids jsonb not null default '[]'::jsonb,
  -- Anthropic vault holding this agent's access keys for its MCP servers.
  vault_id text
);

alter table agents add column if not exists vault_id text;

create index if not exists agents_user_id_idx on agents (user_id, created_at desc);

alter table agents enable row level security;

-- One row per Managed Agents session, from the playground or the deployed endpoint.
create table if not exists agent_runs (
  session_id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  created_at timestamptz not null default now(),
  source text not null check (source in ('playground', 'endpoint')),
  status text not null,
  input_preview text,
  output_preview text
);

create index if not exists agent_runs_agent_id_idx on agent_runs (agent_id, created_at desc);

alter table agent_runs enable row level security;

-- ---- End users of "for your customers" MCP servers --------------------------
-- People who connect to a SaaS's MCP server (from Claude, ChatGPT, ...) and
-- sign in with their own credential for the SaaS. They are not altship
-- users: each connection is its own lightweight identity.

alter table deployments add column if not exists connect_settings jsonb;

-- OAuth clients that registered themselves (dynamic client registration).
create table if not exists oauth_clients (
  client_id text primary key,
  created_at timestamptz not null default now(),
  client_name text,
  client_uri text,
  redirect_uris text[] not null
);

alter table oauth_clients enable row level security;

-- One end user's connection to one MCP server. `credential_sealed` is their
-- upstream credential encrypted with that server's key (never stored in plain text).
create table if not exists end_user_connections (
  id text primary key,
  deployment_id text not null references deployments(id) on delete cascade,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  credential_hint text not null,
  credential_sealed text not null
);

create index if not exists end_user_connections_deployment_idx on end_user_connections (deployment_id, created_at desc);

alter table end_user_connections enable row level security;

-- Authorization requests: created at /oauth/authorize, approved on the connect
-- page (which sets the code), then exchanged once at /oauth/token.
create table if not exists oauth_requests (
  id text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  deployment_id text not null references deployments(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  scope text,
  code_hash text unique,
  connection_id text references end_user_connections(id) on delete cascade,
  used_at timestamptz
);

alter table oauth_requests enable row level security;

create table if not exists oauth_refresh_tokens (
  token_hash text primary key,
  connection_id text not null references end_user_connections(id) on delete cascade,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists oauth_refresh_tokens_connection_idx on oauth_refresh_tokens (connection_id);

alter table oauth_refresh_tokens enable row level security;

-- ---- People invited to a private MCP server ---------------------------------
-- Other altship users who accepted the owner's invite to a private server and
-- can connect by signing in with their own altship account. Their ids go into
-- the server's MCP_OAUTH_ALLOWED_SUBJECTS next to the owner's. They can't see
-- or manage the server in the dashboard.
create table if not exists deployment_members (
  deployment_id text not null references deployments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The address the owner invited, as shown back to them.
  email text not null,
  created_at timestamptz not null default now(),
  primary key (deployment_id, user_id)
);

alter table deployment_members enable row level security;

-- Invites to a private server. `id` is the unguessable token in the invite
-- link (<dashboard>/invite/<id>). An invite is pending until someone signed in
-- with a confirmed `email` opens the link, which makes them a member; the link
-- alone grants nothing.
create table if not exists deployment_invites (
  id text primary key,
  deployment_id text not null references deployments(id) on delete cascade,
  -- Lowercased.
  email text not null,
  created_at timestamptz not null default now(),
  -- Null while pending.
  accepted_by uuid references auth.users(id) on delete cascade,
  unique (deployment_id, email)
);

alter table deployment_invites enable row level security;

-- From an earlier version that looked accounts up by email; no longer used.
drop function if exists altship_user_id_by_email(text);

-- ---- Observability: tool calls on managed MCP servers -----------------------
-- One row per tool call, exported by the server as an OpenTelemetry span and
-- ingested at /api/otel/v1/traces. Records who called which tool, how it went
-- and how long it took -- never arguments, responses or credentials.
create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  deployment_id text not null references deployments(id) on delete cascade,
  started_at timestamptz not null,
  tool text not null,
  ok boolean not null,
  -- unknown_tool | invalid_input | upstream_error | request_failed
  error_type text,
  -- The upstream API's HTTP status, when a request was made.
  http_status integer,
  duration_ms integer not null,
  -- key | user | end-user | anonymous | local
  caller_kind text not null,
  -- key: first 12 hex characters of the access key's SHA-256 hash;
  -- user: altship user id; end-user: end_user_connections.id.
  caller_id text,
  trace_id text,
  span_id text
);

create index if not exists tool_calls_deployment_idx on tool_calls (deployment_id, started_at desc);

alter table tool_calls enable row level security;

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

-- Which generation of the generated code the server runs (packages/mcp-gen
-- GENERATOR_VERSION); null for servers deployed before this was recorded.
-- Servers behind the current one can be upgraded in place.
alter table deployments add column if not exists generator_version integer;
-- The hosting deployment that holds the server's current code, when it isn't
-- the one it was first deployed as (`id`): set by an in-place upgrade, and
-- what later redeploys start from.
alter table deployments add column if not exists source_deployment_id text;

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

-- For Observability: when the run last settled (answered, failed or waiting
-- on an approval) and how many tool calls the agent has made in it.
alter table agent_runs add column if not exists ended_at timestamptz;
alter table agent_runs add column if not exists tool_calls integer;

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

-- ---- Plans -------------------------------------------------------------------
-- An account's plan, which decides how long Observability history is kept
-- (apps/api/src/plans.ts). No row means the free plan. There's no billing
-- yet, so to move someone to a plan by hand:
--   insert into accounts (user_id, plan) values ('<auth.users id>', 'pro')
--     on conflict (user_id) do update set plan = excluded.plan;
create table if not exists accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

alter table accounts enable row level security;

-- ---- Connected apps ------------------------------------------------------------
-- Sessions with the app provider (Composio; apps/api/src/apps/composio.ts). A
-- user has one for browsing and signing in to apps (toolkits_key '*') and one
-- per set of apps their agents use. Only ids are kept: no credentials and no
-- provider addresses.
create table if not exists app_sessions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  toolkits text[] not null default '{}',
  -- The sorted toolkit slugs joined by commas, or '*' for the browse session.
  toolkits_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, toolkits_key)
);

alter table app_sessions enable row level security;

-- ---- Memory stores -------------------------------------------------------------
-- An MCP server altship serves itself (apps/api/src/memory): notes in
-- collections that an LLM, or an agent, can search and write. A store is a
-- `deployments` row with kind 'memory', so access keys, people, renaming and
-- call logs all work for it as they do for a server generated from an API.
alter table deployments add column if not exists kind text not null default 'api' check (kind in ('api', 'memory'));
-- A memory store's starter collections: [{ "name": ..., "description": ... }].
alter table deployments add column if not exists collections jsonb;

-- array_to_string isn't marked immutable, which a generated column requires.
create or replace function memory_tags_text(tags text[])
returns text
language sql
immutable
set search_path = ''
as $$ select array_to_string(tags, ' ') $$;

create table if not exists memory_records (
  id uuid primary key default gen_random_uuid(),
  deployment_id text not null references deployments(id) on delete cascade,
  collection text not null,
  title text not null,
  body text not null default '',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- What keyword search matches: the title counts most, then tags, then the text.
  search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', memory_tags_text(tags)), 'B') ||
    setweight(to_tsvector('english', body), 'C')
  ) stored
);

create index if not exists memory_records_store_idx on memory_records (deployment_id, collection, updated_at desc);
create index if not exists memory_records_search_idx on memory_records using gin (search);

alter table memory_records enable row level security;

-- Keyword search within one store, best matches first. Words are matched as
-- typed ("quoted phrases" and -exclusions work); a plain substring of the
-- title also counts, so short or unusual words still find things.
create or replace function search_memory_records(p_deployment_id text, p_query text, p_collection text default null, p_limit integer default 20)
returns setof memory_records
language sql
stable
set search_path = public
as $$
  select r.*
  from memory_records r
  where r.deployment_id = p_deployment_id
    and (p_collection is null or r.collection = p_collection)
    and (r.search @@ websearch_to_tsquery('english', p_query) or r.title ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%')
  order by ts_rank(r.search, websearch_to_tsquery('english', p_query)) desc, r.updated_at desc
  limit least(greatest(p_limit, 1), 50);
$$;

revoke execute on function search_memory_records(text, text, text, integer) from public, anon, authenticated;
grant execute on function search_memory_records(text, text, text, integer) to service_role;

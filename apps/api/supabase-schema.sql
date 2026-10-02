-- Run this once in the Supabase SQL Editor for the shared "altship" project.
-- Users sign in to the dashboard with GitHub or Google (Supabase Auth), and
-- every deployment and agent belongs to one auth.users row.

create table if not exists deployments (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
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

-- Run this once in the Supabase SQL Editor for the shared "altship" project.
-- deployments belongs to altship-mcp specifically. There is no user login,
-- so deployments are not scoped to a user.

create table if not exists deployments (
  id text primary key,
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

alter table deployments enable row level security;

-- Only the API server (service_role key, bypasses RLS) reads or writes this
-- table; with no policies, anon/user-scoped keys can't see anything.

-- Migrating an existing table from the user-scoped schema:
--   drop policy if exists "Users can only see their own deployments" on deployments;
--   alter table deployments drop column if exists user_id;
--   alter table deployments add column if not exists tools jsonb;
--   alter table deployments add column if not exists auth_mode text;

-- Agent Creator. `plan` (altship's own AgentPlan) is the source of truth; the
-- Managed Agents IDs are the runtime copy created from it on approve.
create table if not exists agents (
  id text primary key,
  created_at timestamptz not null default now(),
  name text not null,
  description text not null,
  plan jsonb not null,
  coordinator_agent_id text not null,
  coordinator_version integer not null,
  specialist_agent_ids jsonb not null default '[]'::jsonb
);

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

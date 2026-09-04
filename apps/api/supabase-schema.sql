-- Run this once in the Supabase SQL Editor for the shared "altship" project.
-- deployments belongs to altship-mcp specifically; other future altship
-- products would add their own tables here, all referencing the same
-- shared auth.users.

create table if not exists deployments (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  api_title text not null,
  tool_names text[] not null,
  project_name text not null,
  project_id text not null,
  url text not null
);

alter table deployments enable row level security;

-- The API server uses the service_role key (which bypasses RLS) and filters
-- by user_id itself, so this policy is defense-in-depth in case anything
-- ever queries this table with an anon/user-scoped key instead.
create policy "Users can only see their own deployments"
  on deployments for select
  using (auth.uid() = user_id);

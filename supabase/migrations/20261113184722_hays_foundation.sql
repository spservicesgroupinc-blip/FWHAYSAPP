-- Foundation only. Do not deploy to production until workflow parity and
-- authorization tests have been run against a disposable Supabase project.
create table public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'staff')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.staff_members enable row level security;
revoke all on public.staff_members from public, anon, authenticated;
grant select on public.staff_members to authenticated;
create policy staff_can_read_own_membership on public.staff_members
  for select to authenticated using (user_id = (select auth.uid()));

-- Legacy IDs remain stable. The complete snapshots are retained while screen
-- specific constraints and relationships are migrated incrementally.
do $$
declare t text;
begin
  foreach t in array array['requests','jobs','workspaces','job_documents',
      'customers','customer_activities','tasks','customer_reference'] loop
    execute format('create table public.%I (
      id text primary key check (length(id) between 1 and 200),
      payload jsonb not null check (jsonb_typeof(payload) = ''object''),
      revision integer not null default 0 check (revision >= 0),
      updated_at timestamptz not null default now()
    )', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy active_staff_read on public.%I for select to authenticated using (
      exists (select 1 from public.staff_members m where m.user_id = (select auth.uid()) and m.active)
    )', t);
  end loop;
end $$;

create index job_documents_workspace_idx on public.job_documents ((payload->>'workspaceId'));
create index activities_customer_idx on public.customer_activities ((payload->>'customerId'));
create index tasks_customer_idx on public.tasks ((payload->>'customerId'));
create index workspaces_customer_idx on public.workspaces ((payload->>'customerId'));
create index requests_workspace_idx on public.requests ((payload->>'workspaceId'));

-- This table is not exposed through the Data API. Receipts make retries across
-- browser restarts idempotent and reject mutation IDs reused with other data.
create schema if not exists hays_private;
revoke all on schema hays_private from public, anon, authenticated;
create table hays_private.mutation_receipts (
  entity_table text not null,
  entity_id text not null,
  mutation_id text not null,
  user_id uuid not null,
  expected_revision integer not null,
  input_payload jsonb not null,
  result_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (entity_table, entity_id, mutation_id)
);

-- Explicit membership check is required because this definer function must
-- write tables that are deliberately not directly writable by clients.
-- Its fixed whitelist does not include requests: request state transitions and
-- attachment validation must first be ported from Apps Script.
create function public.save_record(
  p_table text,
  p_id text,
  p_payload jsonb,
  p_expected_revision integer,
  p_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  previous hays_private.mutation_receipts%rowtype;
  current_revision integer;
  saved jsonb;
  saved_at timestamptz := now();
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_table not in ('workspaces', 'customers', 'tasks') or p_table is null
    or p_id is null or length(p_id) not between 1 and 200
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 200
    or p_expected_revision is null or p_expected_revision < 0
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'id' is distinct from p_id then
    raise exception 'Invalid save arguments' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_table || ':' || p_id, 0));
  select * into previous from hays_private.mutation_receipts
    where entity_table = p_table and entity_id = p_id and mutation_id = p_mutation_id;
  if found then
    if previous.user_id <> actor or previous.expected_revision <> p_expected_revision
      or previous.input_payload <> p_payload then
      raise exception 'Mutation identifier already used with different data' using errcode = '22023';
    end if;
    return previous.result_payload;
  end if;
  execute format('select revision from public.%I where id = $1 for update', p_table)
    into current_revision using p_id;
  current_revision := coalesce(current_revision, 0);
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;
  saved := p_payload || jsonb_build_object('revision', current_revision + 1, 'updatedAt', saved_at);
  execute format('insert into public.%I (id, payload, revision, updated_at) values ($1, $2, $3, $4)
    on conflict (id) do update set payload = excluded.payload,
      revision = excluded.revision, updated_at = excluded.updated_at', p_table)
    using p_id, saved, current_revision + 1, saved_at;
  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values (p_table, p_id, p_mutation_id, actor, p_expected_revision, p_payload, saved);
  return saved;
end $$;
revoke all on function public.save_record(text,text,jsonb,integer,text) from public, anon;
grant execute on function public.save_record(text,text,jsonb,integer,text) to authenticated;

-- Private bucket is provisioned without client object policies. Upload and
-- download remain disabled until parent-linked authorization is implemented.
insert into storage.buckets (id, name, public)
values ('hays-private', 'hays-private', false)
on conflict (id) do nothing;

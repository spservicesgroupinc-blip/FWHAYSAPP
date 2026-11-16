-- Make CRM activity writes available in the hosted project and correct the
-- customer-link checks used by direct table writes.
create table if not exists hays_private.activity_receipts (
  mutation_id text primary key check (length(mutation_id) between 1 and 200),
  actor uuid not null,
  activity_id text not null,
  activity jsonb not null,
  created_at timestamptz not null default now()
);
revoke all on hays_private.activity_receipts from public, anon, authenticated;

create or replace function hays_private.append_customer_activity(
  p_activity jsonb,
  p_mutation_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  item_id text;
  customer_id text;
  receipt hays_private.activity_receipts%rowtype;
begin
  if actor is null or not exists (
    select 1 from public.staff_members m where m.user_id = actor and m.active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_activity is null or jsonb_typeof(p_activity) <> 'object'
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 200
    or jsonb_typeof(p_activity->'id') is distinct from 'string'
    or jsonb_typeof(p_activity->'customerId') is distinct from 'string'
    or jsonb_typeof(p_activity->'kind') is distinct from 'string'
    or jsonb_typeof(p_activity->'direction') is distinct from 'string'
    or jsonb_typeof(p_activity->'body') is distinct from 'string'
    or jsonb_typeof(p_activity->'at') is distinct from 'string'
    or (p_activity ? 'workspaceId' and jsonb_typeof(p_activity->'workspaceId') is distinct from 'string')
    or (p_activity ? 'by' and jsonb_typeof(p_activity->'by') is distinct from 'string')
    or (p_activity - array['id','customerId','workspaceId','kind','direction','body','at','by']) <> '{}'::jsonb
    or length(p_activity->>'id') not between 1 and 100
    or length(p_activity->>'customerId') not between 1 and 100
    or length(trim(p_activity->>'kind')) not between 1 and 100
    or p_activity->>'direction' not in ('inbound','outbound','system')
    or length(p_activity->>'body') > 100000
    or length(p_activity->>'at') not between 1 and 300
    or (p_activity ? 'workspaceId' and length(p_activity->>'workspaceId') not between 1 and 100)
    or (p_activity ? 'by' and length(p_activity->>'by') > 300)
  then
    raise exception 'Invalid activity' using errcode = '22023';
  end if;

  item_id := p_activity->>'id';
  customer_id := p_activity->>'customerId';
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('activity-mutation:' || p_mutation_id, 0));
  select * into receipt from hays_private.activity_receipts where mutation_id = p_mutation_id;
  if found then
    if receipt.actor <> actor or receipt.activity_id <> item_id or receipt.activity <> p_activity then
      raise exception 'Mutation identifier already used with different data' using errcode = '22023';
    end if;
    return receipt.activity;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('activity-id:' || item_id, 0));
  if exists (select 1 from public.customer_activities where id = item_id) then
    raise exception 'Activity identifier already exists' using errcode = '22023';
  end if;
  perform 1 from public.customers where id = customer_id for key share;
  if not found then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if p_activity ? 'workspaceId' then
    perform 1 from public.workspaces
      where id = p_activity->>'workspaceId' and payload->>'customerId' = customer_id
      for key share;
    if not found then
      raise exception 'Workspace is not linked to this customer' using errcode = 'P0002';
    end if;
  end if;
  insert into public.customer_activities (id, payload, revision)
    values (item_id, p_activity, 0);
  insert into hays_private.activity_receipts (mutation_id, actor, activity_id, activity)
    values (p_mutation_id, actor, item_id, p_activity);
  return p_activity;
end;
$$;

revoke all on function hays_private.append_customer_activity(jsonb,text) from public, anon;
grant execute on function hays_private.append_customer_activity(jsonb,text) to authenticated;

create or replace function public.append_customer_activity(p_activity jsonb, p_mutation_id text)
returns jsonb language sql security invoker set search_path = '' as $$
  select hays_private.append_customer_activity(p_activity, p_mutation_id);
$$;
revoke all on function public.append_customer_activity(jsonb,text) from public, anon;
grant execute on function public.append_customer_activity(jsonb,text) to authenticated;

drop policy if exists customer_activities_insert_active_staff on public.customer_activities;
create policy customer_activities_insert_active_staff on public.customer_activities
  for insert to authenticated
  with check (
    exists (select 1 from public.staff_members m where m.user_id = (select auth.uid()) and m.active)
    and exists (select 1 from public.customers c where c.id = (public.customer_activities.payload->>'customerId'))
  );

drop policy if exists tasks_write_active_staff on public.tasks;
create policy tasks_write_active_staff on public.tasks
  for all to authenticated
  using (
    exists (select 1 from public.staff_members m where m.user_id = (select auth.uid()) and m.active)
    and exists (select 1 from public.customers c where c.id = (public.tasks.payload->>'customerId'))
  )
  with check (
    exists (select 1 from public.staff_members m where m.user_id = (select auth.uid()) and m.active)
    and exists (select 1 from public.customers c where c.id = (public.tasks.payload->>'customerId'))
  );

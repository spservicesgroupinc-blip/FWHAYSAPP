-- CRM records may arrive in different sync batches. Do not reject an activity
-- or task just because its customer/workspace snapshot has not arrived yet.
alter table public.customer_activities
  drop constraint if exists customer_activities_customer_id_fkey,
  drop constraint if exists customer_activities_workspace_id_fkey;
alter table public.tasks
  drop constraint if exists tasks_customer_id_fkey,
  drop constraint if exists tasks_workspace_id_fkey;

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
  insert into public.customer_activities (id, payload, revision)
    values (item_id, p_activity, 0);
  insert into hays_private.activity_receipts (mutation_id, actor, activity_id, activity)
    values (p_mutation_id, actor, item_id, p_activity);
  return p_activity;
end;
$$;

drop view if exists public.customer_summaries;
create view public.customer_summaries
with (security_invoker = true)
as
select
  c.id,
  c.revision,
  c.updated_at,
  c.payload->>'createdAt' as created_at,
  c.payload->>'name' as name,
  c.payload->>'phone' as phone,
  c.payload->>'email' as email,
  c.payload->>'address' as address,
  c.payload->>'cityStateZip' as city_state_zip,
  c.payload->'tags' as tags,
  c.payload->'mergedFromIds' as merged_from_ids,
  coalesce((select count(*) from public.workspaces w where w.payload->>'customerId' = c.id), 0)::integer as job_count,
  coalesce((select count(*) from public.tasks t where t.payload->>'customerId' = c.id and t.payload->>'status' = 'open'), 0)::integer as open_task_count
from public.customers c;
revoke all on public.customer_summaries from public, anon;
grant select on public.customer_summaries to authenticated;

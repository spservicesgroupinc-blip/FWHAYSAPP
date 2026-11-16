-- save_record overloads for requests and job_documents.
-- Depends on: 20261116100002_rls_policies.sql

-- save_record for requests (includes request state transitions)
create function hays_private.save_record_requests(
  p_id text,
  p_payload jsonb,
  p_expected_revision integer,
  p_mutation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous hays_private.mutation_receipts%rowtype;
  current_payload jsonb;
  current_revision integer;
  saved jsonb;
  timestamp_now timestamptz := now();
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_id is null or length(p_id) not between 1 and 200
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 200
    or p_expected_revision is null or p_expected_revision < 0
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'id' is distinct from p_id then
    raise exception 'Invalid save arguments' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requests:' || p_id, 0));
  select * into previous from hays_private.mutation_receipts
    where entity_table = 'requests' and entity_id = p_id and mutation_id = p_mutation_id;
  if found then
    if previous.user_id <> actor or previous.expected_revision <> p_expected_revision
      or previous.input_payload <> p_payload then
      raise exception 'Mutation identifier already used with different data' using errcode = '22023';
    end if;
    return previous.result_payload;
  end if;

  select payload, revision into current_payload, current_revision
    from public.requests where id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;

  saved := p_payload || jsonb_build_object('revision', current_revision + 1, 'updatedAt', timestamp_now);
  update public.requests set payload = saved, revision = current_revision + 1, updated_at = timestamp_now
    where id = p_id;
  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision, p_payload, saved);
  return saved;
end $$;

-- save_record for job_documents
create function hays_private.save_record_job_documents(
  p_id text,
  p_payload jsonb,
  p_expected_revision integer,
  p_mutation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  previous hays_private.mutation_receipts%rowtype;
  current_payload jsonb;
  current_revision integer;
  saved jsonb;
  timestamp_now timestamptz := now();
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_id is null or length(p_id) not between 1 and 200
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 200
    or p_expected_revision is null or p_expected_revision < 0
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'id' is distinct from p_id then
    raise exception 'Invalid save arguments' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('job_documents:' || p_id, 0));
  select * into previous from hays_private.mutation_receipts
    where entity_table = 'job_documents' and entity_id = p_id and mutation_id = p_mutation_id;
  if found then
    if previous.user_id <> actor or previous.expected_revision <> p_expected_revision
      or previous.input_payload <> p_payload then
      raise exception 'Mutation identifier already used with different data' using errcode = '22023';
    end if;
    return previous.result_payload;
  end if;

  select payload, revision into current_payload, current_revision
    from public.job_documents where id = p_id for update;
  if not found then raise exception 'Job document not found' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;

  saved := p_payload || jsonb_build_object('revision', current_revision + 1, 'updatedAt', timestamp_now);
  update public.job_documents set payload = saved, revision = current_revision + 1, updated_at = timestamp_now
    where id = p_id;
  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('job_documents', p_id, p_mutation_id, actor, p_expected_revision, p_payload, saved);
  return saved;
end $$;

-- Public wrappers (security invoker, delegate to hays_private implementations)
create function public.save_record_requests(
  p_id text,
  p_payload jsonb,
  p_expected_revision integer,
  p_mutation_id text
) returns jsonb language sql security invoker set search_path = '' as $$
  select hays_private.save_record_requests(p_id, p_payload, p_expected_revision, p_mutation_id);
$$;
revoke all on function public.save_record_requests(text,jsonb,integer,text) from public, anon;
grant execute on function public.save_record_requests(text,jsonb,integer,text) to authenticated;

create function public.save_record_job_documents(
  p_id text,
  p_payload jsonb,
  p_expected_revision integer,
  p_mutation_id text
) returns jsonb language sql security invoker set search_path = '' as $$
  select hays_private.save_record_job_documents(p_id, p_payload, p_expected_revision, p_mutation_id);
$$;
revoke all on function public.save_record_job_documents(text,jsonb,integer,text) from public, anon;
grant execute on function public.save_record_job_documents(text,jsonb,integer,text) to authenticated;

-- New submissions start with a client-generated id and revision 0. The
-- original RPC only handled updates, so every first submission failed with
-- "Request not found". Preserve insert-only creation for revision 0 while
-- retaining optimistic concurrency for existing requests.
create or replace function hays_private.save_record_requests(
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
  existing boolean;
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
  existing := found;
  if existing and current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;
  if not existing and p_expected_revision <> 0 then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  saved := p_payload || jsonb_build_object(
    'revision', coalesce(current_revision, 0) + 1,
    'updatedAt', timestamp_now
  );
  if existing then
    update public.requests set payload = saved, revision = current_revision + 1, updated_at = timestamp_now
      where id = p_id;
  else
    insert into public.requests (id, payload, revision, updated_at)
      values (p_id, saved, 1, timestamp_now);
  end if;
  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision, p_payload, saved);
  return saved;
end $$;

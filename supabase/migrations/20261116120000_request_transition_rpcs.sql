-- Request state transition RPC functions: claim_request and transition_request.
-- Depends on: 20261116100003_save_record_overloads.sql
-- These functions implement the request workflow rules that the held
-- request_state_draft draft attempted, but with proper security invoker
-- wrappers and no direct client table access.

-- claim_request: assigns an estimator and moves a submitted request to in_review.
create function hays_private.claim_request(
  p_id text,
  p_expected_revision integer,
  p_estimator_name text,
  p_mutation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  prior hays_private.mutation_receipts%rowtype;
  current_payload jsonb;
  current_revision integer;
  saved jsonb;
  timestamp_now timestamptz := clock_timestamp();
  estimator text;
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_id is null or length(p_id) not between 1 and 100
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 100
    or p_expected_revision is null or p_expected_revision < 0
    or p_estimator_name is null or trim(p_estimator_name) = '' then
    raise exception 'Invalid claim arguments' using errcode = '22023';
  end if;

  estimator := trim(p_estimator_name);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requests:' || p_id, 0));
  select * into prior from hays_private.mutation_receipts
    where entity_table = 'requests' and entity_id = p_id and mutation_id = p_mutation_id;
  if found then
    if prior.user_id <> actor or prior.expected_revision <> p_expected_revision
      or prior.input_payload <> jsonb_build_object('action','claim','estimatorName',p_estimator_name) then
      raise exception 'Mutation identifier already used with different data' using errcode = '22023';
    end if;
    return prior.result_payload;
  end if;

  select payload, revision into current_payload, current_revision
    from public.requests where id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;
  if coalesce(current_payload->>'estimatorName','') <> ''
    and current_payload->>'estimatorName' <> estimator then
    raise exception 'Request is already assigned' using errcode = '22023';
  end if;
  if current_payload->>'status' is distinct from 'submitted' then
    raise exception 'Only a submitted request can be claimed' using errcode = '22023';
  end if;

  saved := current_payload || jsonb_build_object(
    'estimatorName', estimator,
    'status', 'in_review',
    'revision', current_revision + 1,
    'updatedAt', timestamp_now
  );
  update public.requests set payload = saved, revision = current_revision + 1, updated_at = timestamp_now
    where id = p_id;
  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision,
      jsonb_build_object('action','claim','estimatorName',p_estimator_name), saved);
  return saved;
end $$;

create function public.claim_request(
  p_id text,
  p_expected_revision integer,
  p_estimator_name text,
  p_mutation_id text
) returns jsonb language sql security invoker set search_path = '' as $$
  select hays_private.claim_request(p_id, p_expected_revision, p_estimator_name, p_mutation_id);
$$;
revoke all on function public.claim_request(text,integer,text,text) from public, anon;
grant execute on function public.claim_request(text,integer,text,text) to authenticated;

-- transition_request: moves a request between submitted, in_review, needs_information, completed.
create function hays_private.transition_request(
  p_id text,
  p_expected_revision integer,
  p_status text,
  p_question text,
  p_mutation_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  prior hays_private.mutation_receipts%rowtype;
  current_payload jsonb;
  current_revision integer;
  saved jsonb;
  timestamp_now timestamptz := clock_timestamp();
  answer text;
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_id is null or length(p_id) not between 1 and 100
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 100
    or p_expected_revision is null or p_expected_revision < 0
    or p_status is null or p_status not in ('submitted','needs_information','completed') then
    raise exception 'Invalid transition arguments' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requests:' || p_id, 0));
  select * into prior from hays_private.mutation_receipts
    where entity_table = 'requests' and entity_id = p_id and mutation_id = p_mutation_id;
  if found then
    if prior.user_id <> actor or prior.expected_revision <> p_expected_revision
      or prior.input_payload <> jsonb_build_object('action',p_status,'status',p_status,'question',p_question) then
      raise exception 'Mutation identifier already used with different data' using errcode = '22023';
    end if;
    return prior.result_payload;
  end if;

  select payload, revision into current_payload, current_revision
    from public.requests where id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;

  saved := current_payload;
  if p_status = 'submitted' and current_payload->>'status' = 'needs_information' then
    saved := saved || jsonb_build_object(
      'submittedAt', timestamp_now, 'informationQuestion', '',
      'status', case when coalesce(current_payload->>'estimatorName','') <> '' then 'in_review' else 'submitted' end
    );
  elsif p_status = 'needs_information' and current_payload->>'status' = 'in_review' then
    answer := trim(coalesce(p_question,''));
    if answer = '' then
      raise exception 'Describe the information needed' using errcode = '22023';
    end if;
    saved := saved || jsonb_build_object('status', p_status, 'informationQuestion', answer);
  elsif p_status = 'completed' and current_payload->>'status' = 'in_review' then
    saved := saved || jsonb_build_object('status', p_status);
  else
    raise exception 'That status change is not permitted' using errcode = '22023';
  end if;
  saved := saved || jsonb_build_object('revision', current_revision + 1, 'updatedAt', timestamp_now);
  update public.requests set payload = saved, revision = current_revision + 1, updated_at = timestamp_now
    where id = p_id;
  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision,
      jsonb_build_object('action',p_status,'status',p_status,'question',p_question), saved);
  return saved;
end $$;

create function public.transition_request(
  p_id text,
  p_expected_revision integer,
  p_status text,
  p_question text,
  p_mutation_id text
) returns jsonb language sql security invoker set search_path = '' as $$
  select hays_private.transition_request(p_id, p_expected_revision, p_status, p_question, p_mutation_id);
$$;
revoke all on function public.transition_request(text,integer,text,text,text) from public, anon;
grant execute on function public.transition_request(text,integer,text,text,text) to authenticated;

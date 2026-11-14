-- Disabled draft: no public wrapper or client EXECUTE grants. Request creation
-- and editing require attachment ownership verification and customer-PDF
-- fingerprint/invalidation parity before this can be made available to users.
-- The earlier SECURITY HOLD migrations also block normal migration replay.
-- This internal function is for isolated tests and review only.
create function hays_private.request_state_draft(
  p_action text, p_id text, p_expected_revision integer, p_mutation_id text,
  p_estimator_name text default null, p_status text default null, p_question text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  prior hays_private.mutation_receipts%rowtype;
  current_payload jsonb;
  current_revision integer;
  input_data jsonb;
  saved jsonb;
  timestamp_now timestamptz := clock_timestamp();
  estimator text;
  answer text;
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('claim', 'transition')
    or p_id is null or length(p_id) not between 1 and 100
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 100
    or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid request operation' using errcode = '22023';
  end if;
  if p_action = 'claim' then
    estimator := trim(coalesce(p_estimator_name, ''));
    if estimator = '' then
      raise exception 'Enter the estimator name' using errcode = '22023';
    end if;
    input_data := jsonb_build_object('action',p_action,'estimatorName',p_estimator_name);
  else
    if p_status is null or p_status not in ('submitted','needs_information','completed') then
      raise exception 'That status change is not permitted' using errcode = '22023';
    end if;
    input_data := jsonb_build_object('action',p_action,'status',p_status,'question',p_question);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requests:' || p_id, 0));
  select * into prior from hays_private.mutation_receipts
    where entity_table = 'requests' and entity_id = p_id and mutation_id = p_mutation_id;
  if found then
    if prior.user_id <> actor or prior.expected_revision <> p_expected_revision
      or prior.input_payload <> input_data then
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
  if p_action = 'claim' then
    if coalesce(current_payload->>'estimatorName','') <> ''
      and current_payload->>'estimatorName' <> estimator then
      raise exception 'Request is already assigned' using errcode = '22023';
    end if;
    if current_payload->>'status' is distinct from 'submitted' then
      raise exception 'Only a submitted request can be claimed' using errcode = '22023';
    end if;
    saved := saved || jsonb_build_object('estimatorName', estimator, 'status', 'in_review');
  elsif p_status = 'submitted' and current_payload->>'status' = 'needs_information' then
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
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision, input_data, saved);
  return saved;
end $$;
revoke all on function hays_private.request_state_draft(text,text,integer,text,text,text,text) from public, anon, authenticated;

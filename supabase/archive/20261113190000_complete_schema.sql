-- Complete schema for FWHAYSAPP migration from Apps Script
-- Extends the foundation migration with all entity tables, RLS policies, and functions

-- SECURITY HOLD: This draft must not run. Its views, grants and privileged
-- write functions have not passed authorization or workflow-parity review.
-- In particular, owner-executed views plus broad grants can expose data, and
-- the generic definer write function bypasses the intended business rules.
-- Replace this draft with reviewed, tested migrations before removing the hold.
do $$ begin
  raise exception 'Blocked: complete_schema is an unsafe draft; see security hold';
end $$;

-- ============================================================================
-- EXTENDED STAFF MEMBERS WITH ROLES
-- ============================================================================

-- Add role column if not exists (already in foundation)
-- role: 'admin' | 'staff' | 'estimator' | 'project_manager'

-- ============================================================================
-- REQUESTS TABLE (Change Orders)
-- ============================================================================

-- The foundation migration created a generic table. Now add specific constraints and indexes.
-- Note: The generic table already exists from the DO loop. We add specific indexes and policies.

-- Additional indexes for requests
create index if not exists requests_status_idx on public.requests ((payload->>'status'));
create index if not exists requests_estimator_idx on public.requests ((payload->>'estimatorName'));
create index if not exists requests_customer_idx on public.requests ((payload->>'customerId'));
create index if not exists requests_job_number_idx on public.requests ((payload->>'jobNumber'));
create index if not exists requests_created_at_idx on public.requests ((payload->>'createdAt'));
create index if not exists requests_updated_at_idx on public.requests ((payload->>'updatedAt'));

-- RLS policies for requests (extend the generic active_staff_read)
-- Staff can read all requests
-- Estimators can only read/write their own requests
-- Project managers can read all, write assigned

create policy estimator_write_own_requests on public.requests
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'estimator')
      and (payload->>'estimatorName') = (select raw_user_meta_data->>'full_name' from auth.users where id = auth.uid())
    )
  );

create policy estimator_update_own_requests on public.requests
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'estimator')
      and (payload->>'estimatorName') = (select raw_user_meta_data->>'full_name' from auth.users where id = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'estimator')
      and (payload->>'estimatorName') = (select raw_user_meta_data->>'full_name' from auth.users where id = auth.uid())
    )
  );

-- Project managers can read all requests, update status
create policy pm_read_all_requests on public.requests
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'project_manager')
    )
  );

create policy pm_update_request_status on public.requests
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'project_manager')
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'project_manager')
    )
  );

-- ============================================================================
-- JOBS TABLE (CSV Job Directory - Replaceable)
-- ============================================================================

create index if not exists jobs_job_number_idx on public.jobs ((payload->>'jobNumber'));
create index if not exists jobs_customer_idx on public.jobs ((payload->>'customer'));
create index if not exists jobs_status_idx on public.jobs ((payload->>'status'));
create index if not exists jobs_active_idx on public.jobs ((payload->>'active'));

-- Jobs are replaceable CSV data - only admins can write
create policy admin_write_jobs on public.jobs
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role = 'admin'
    )
  );

-- ============================================================================
-- WORKSPACES TABLE (Permanent Job Records)
-- ============================================================================

create index if not exists workspaces_stage_idx on public.workspaces ((payload->>'stage'));
create index if not exists workspaces_source_record_idx on public.workspaces ((payload->>'sourceRecordId'));

-- Workspace policies: staff can read all, estimators/PMs can write their jobs
create policy staff_write_workspaces on public.workspaces
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'estimator', 'project_manager')
    )
  );

create policy staff_update_workspaces on public.workspaces
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'estimator', 'project_manager')
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role in ('admin', 'estimator', 'project_manager')
    )
  );

-- ============================================================================
-- JOB_DOCUMENTS TABLE (Generated Documents)
-- ============================================================================

create index if not exists job_documents_kind_idx on public.job_documents ((payload->>'kind'));
create index if not exists job_documents_created_at_idx on public.job_documents ((payload->>'createdAt'));

-- Document policies: staff can read all, creators can write
create policy staff_write_job_documents on public.job_documents
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

create policy staff_update_job_documents on public.job_documents
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

-- ============================================================================
-- CUSTOMERS TABLE (CRM)
-- ============================================================================

create index if not exists customers_name_idx on public.customers ((payload->>'name'));
create index if not exists customers_email_idx on public.customers ((payload->>'email'));
create index if not exists customers_phone_idx on public.customers ((payload->>'phone'));

-- Customer policies: all staff can read/write
create policy staff_write_customers on public.customers
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

create policy staff_update_customers on public.customers
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

-- ============================================================================
-- CUSTOMER_ACTIVITIES TABLE (CRM Timeline)
-- ============================================================================

create index if not exists customer_activities_kind_idx on public.customer_activities ((payload->>'kind'));
create index if not exists customer_activities_at_idx on public.customer_activities ((payload->>'at'));

-- Activities are append-only, all staff can write
create policy staff_write_customer_activities on public.customer_activities
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

-- No update/delete for activities (append-only)

-- ============================================================================
-- TASKS TABLE (CRM Follow-ups)
-- ============================================================================

create index if not exists tasks_status_idx on public.tasks ((payload->>'status'));
create index if not exists tasks_due_date_idx on public.tasks ((payload->>'dueDate'));
create index if not exists tasks_assignee_idx on public.tasks ((payload->>'assignee'));

-- Task policies: staff can read/write their tasks
create policy staff_write_tasks on public.tasks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

create policy staff_update_tasks on public.tasks
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
    )
  );

-- ============================================================================
-- CUSTOMER_REFERENCE TABLE (Replaceable Reference Data)
-- ============================================================================

create index if not exists customer_reference_version_idx on public.customer_reference ((payload->>'version'));

-- Customer reference: only admins can write (replaceable CSV)
create policy admin_write_customer_reference on public.customer_reference
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid())
      and m.active
      and m.role = 'admin'
    )
  );

-- ============================================================================
-- EXTENDED SAVE_RECORD FUNCTION FOR ALL TABLES
-- ============================================================================

-- Drop and recreate with all tables
drop function if exists public.save_record(text,text,jsonb,integer,text);

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
  allowed_tables text[] := array['requests','workspaces','job_documents','customers','customer_activities','tasks','customer_reference'];
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;
  if p_table is null or p_table not in (select unnest(allowed_tables))
    or p_id is null or length(p_id) not between 1 and 200
    or p_mutation_id is null or length(p_mutation_id) not between 1 and 200
    or p_expected_revision is null or p_expected_revision < 0
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'id' is distinct from p_id then
    raise exception 'Invalid save arguments' using errcode = '22023';
  end if;

  -- Additional validation per table
  if p_table = 'requests' then
    -- Validate request status transitions
    if p_payload->>'status' not in ('submitted','in_review','needs_information','completed') then
      raise exception 'Invalid request status' using errcode = '22023';
    end if;
  elsif p_table = 'workspaces' then
    -- Validate workspace stage
    if p_payload->>'stage' is not null and p_payload->>'stage' not in ('lead','in_progress','complete','closed') then
      raise exception 'Invalid workspace stage' using errcode = '22023';
    end if;
  elsif p_table = 'tasks' then
    if p_payload->>'status' not in ('open','done') then
      raise exception 'Invalid task status' using errcode = '22023';
    end if;
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

-- ============================================================================
-- REQUEST STATE TRANSITION FUNCTION
-- ============================================================================

create function public.transition_request(
  p_id text,
  p_expected_revision integer,
  p_status text,
  p_question text,
  p_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  current jsonb;
  current_revision integer;
  saved jsonb;
  saved_at timestamptz := now();
  valid_transitions jsonb := '{
    "submitted": ["in_review", "needs_information"],
    "in_review": ["completed", "needs_information", "submitted"],
    "needs_information": ["submitted", "in_review"],
    "completed": []
  }';
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;

  -- Validate status
  if p_status not in ('submitted','in_review','needs_information','completed') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requests:' || p_id, 0));
  
  select payload, revision into current, current_revision
  from public.requests where id = p_id for update;
  
  if not found then
    raise exception 'Request not found' using errcode = '404';
  end if;
  
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;

  -- Check valid transition
  if not (valid_transitions->(current->>'status') ?| array[p_status]) then
    raise exception 'Invalid status transition' using errcode = '22023';
  end if;

  saved := current || jsonb_build_object(
    'status', p_status,
    'revision', current_revision + 1,
    'updatedAt', saved_at
  );
  
  if p_question is not null and p_question <> '' then
    saved := saved || jsonb_build_object('informationQuestion', p_question);
  end if;

  -- If transitioning to in_review, set estimator
  if p_status = 'in_review' and (current->>'estimatorName') is null then
    saved := saved || jsonb_build_object('estimatorName', (select raw_user_meta_data->>'full_name' from auth.users where id = actor));
  end if;

  update public.requests
  set payload = saved, revision = current_revision + 1, updated_at = saved_at
  where id = p_id;

  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision, 
            jsonb_build_object('status', p_status, 'question', p_question), saved);
  
  return saved;
end $$;

revoke all on function public.transition_request(text,integer,text,text,text) from public, anon;
grant execute on function public.transition_request(text,integer,text,text,text) to authenticated;

-- ============================================================================
-- CLAIM REQUEST FUNCTION
-- ============================================================================

create function public.claim_request(
  p_id text,
  p_expected_revision integer,
  p_estimator_name text,
  p_mutation_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  current jsonb;
  current_revision integer;
  saved jsonb;
  saved_at timestamptz := now();
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('requests:' || p_id, 0));
  
  select payload, revision into current, current_revision
  from public.requests where id = p_id for update;
  
  if not found then
    raise exception 'Request not found' using errcode = '404';
  end if;
  
  if current_revision <> p_expected_revision then
    raise exception 'Record changed since it was opened' using errcode = '40001';
  end if;

  if (current->>'status') <> 'submitted' then
    raise exception 'Request cannot be claimed in current status' using errcode = '22023';
  end if;

  saved := current || jsonb_build_object(
    'status', 'in_review',
    'estimatorName', p_estimator_name,
    'revision', current_revision + 1,
    'updatedAt', saved_at
  );

  update public.requests
  set payload = saved, revision = current_revision + 1, updated_at = saved_at
  where id = p_id;

  insert into hays_private.mutation_receipts
    (entity_table, entity_id, mutation_id, user_id, expected_revision, input_payload, result_payload)
    values ('requests', p_id, p_mutation_id, actor, p_expected_revision,
            jsonb_build_object('estimatorName', p_estimator_name), saved);
  
  return saved;
end $$;

revoke all on function public.claim_request(text,integer,text,text) from public, anon;
grant execute on function public.claim_request(text,integer,text,text) to authenticated;

-- ============================================================================
-- MERGE CUSTOMERS FUNCTION
-- ============================================================================

create function public.merge_customers(
  p_target_id text,
  p_source_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target jsonb;
  source jsonb;
  target_revision integer;
  source_revision integer;
  merged jsonb;
  saved_at timestamptz := now();
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;

  if p_target_id = p_source_id then
    raise exception 'Cannot merge customer into itself' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customers:' || p_target_id, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('customers:' || p_source_id, 0));

  select payload, revision into target, target_revision
  from public.customers where id = p_target_id for update;
  
  if not found then
    raise exception 'Target customer not found' using errcode = '404';
  end if;

  select payload, revision into source, source_revision
  from public.customers where id = p_source_id for update;
  
  if not found then
    raise exception 'Source customer not found' using errcode = '404';
  end if;

  -- Merge source into target
  merged := target || jsonb_build_object(
    'mergedFromIds', 
    coalesce(target->'mergedFromIds', '[]'::jsonb) || jsonb_build_array(p_source_id),
    'revision', target_revision + 1,
    'updatedAt', saved_at
  );

  -- Update target
  update public.customers
  set payload = merged, revision = target_revision + 1, updated_at = saved_at
  where id = p_target_id;

  -- Reassign activities
  update public.customer_activities
  set payload = payload || jsonb_build_object('customerId', p_target_id)
  where payload->>'customerId' = p_source_id;

  -- Reassign tasks
  update public.tasks
  set payload = payload || jsonb_build_object('customerId', p_target_id)
  where payload->>'customerId' = p_source_id;

  -- Reassign workspaces
  update public.workspaces
  set payload = payload || jsonb_build_object('customerId', p_target_id)
  where payload->>'customerId' = p_source_id;

  -- Delete source
  delete from public.customers where id = p_source_id;

  return merged;
end $$;

revoke all on function public.merge_customers(text,text) from public, anon;
grant execute on function public.merge_customers(text,text) to authenticated;

-- ============================================================================
-- STORAGE BUCKETS AND POLICIES
-- ============================================================================

-- Private bucket for all app files (already created in foundation)
-- insert into storage.buckets (id, name, public) values ('hays-private', 'hays-private', false) on conflict (id) do nothing;

-- Additional buckets for organization
insert into storage.buckets (id, name, public) values 
  ('hays-requests', 'hays-requests', false),
  ('hays-workspaces', 'hays-workspaces', false),
  ('hays-documents', 'hays-documents', false),
  ('hays-attachments', 'hays-attachments', false)
on conflict (id) do nothing;

-- Storage policies: object paths follow pattern {parentType}/{parentId}/{fileId}
-- These policies check parent record access via RLS

-- Request attachments: requests/{requestId}/{attachmentId}
create policy "request_attachments_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hays-attachments'
    and (storage.foldername(name))[1] = 'requests'
    and exists (
      select 1 from public.requests r
      where r.id = (storage.foldername(name))[2]
      and exists (select 1 from public.staff_members m where m.user_id = auth.uid() and m.active)
    )
  );

create policy "request_attachments_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'hays-attachments'
    and (storage.foldername(name))[1] = 'requests'
    and exists (
      select 1 from public.requests r
      where r.id = (storage.foldername(name))[2]
      and exists (select 1 from public.staff_members m where m.user_id = auth.uid() and m.active)
    )
  );

-- Workspace documents: workspaces/{workspaceId}/{documentId}
create policy "workspace_documents_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hays-documents'
    and (storage.foldername(name))[1] = 'workspaces'
    and exists (
      select 1 from public.workspaces w
      where w.id = (storage.foldername(name))[2]
      and exists (select 1 from public.staff_members m where m.user_id = auth.uid() and m.active)
    )
  );

create policy "workspace_documents_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'hays-documents'
    and (storage.foldername(name))[1] = 'workspaces'
    and exists (
      select 1 from public.workspaces w
      where w.id = (storage.foldername(name))[2]
      and exists (select 1 from public.staff_members m where m.user_id = auth.uid() and m.active)
    )
  );

-- ============================================================================
-- HELPER VIEWS FOR COMMON QUERIES
-- ============================================================================

-- Request summaries with workspace/customer info
create or replace view public.request_summaries as
select
  r.id,
  r.revision,
  r.payload->>'createdAt' as created_at,
  r.payload->>'updatedAt' as updated_at,
  r.payload->>'status' as status,
  r.payload->>'estimatorName' as estimator_name,
  r.payload->>'workspaceId' as workspace_id,
  r.payload->>'customerId' as customer_id,
  r.payload->'job'->>'customer' as job_customer,
  r.payload->'job'->>'jobNumber' as job_number,
  r.payload->'job'->>'projectManager' as project_manager,
  r.payload->'job'->>'orderNumber' as order_number,
  r.payload->'job'->>'address' as address,
  jsonb_array_length(r.payload->'requestedChanges') as changes_count,
  jsonb_array_length(r.payload->'attachments') as attachments_count
from public.requests r;

-- Workspace summaries
create or replace view public.workspace_summaries as
select
  w.id,
  w.revision,
  w.payload->>'updatedAt' as updated_at,
  w.payload->>'stage' as stage,
  w.payload->>'customerId' as customer_id,
  w.payload->'record'->'customer'->>'customerName' as customer_name,
  w.payload->'record'->'customer'->>'jobNumber' as job_number,
  w.payload->'record'->'financials'->>'totalApprovedRcv' as total_approved_rcv,
  w.payload->'record'->'changeOrder'->>'originalContractSum' as original_contract,
  w.payload->'record'->'changeOrder'->>'netPreviousChanges' as previous_changes
from public.workspaces w;

-- Customer summaries with job/task counts
create or replace view public.customer_summaries as
select
  c.id,
  c.revision,
  c.payload->>'createdAt' as created_at,
  c.payload->>'updatedAt' as updated_at,
  c.payload->>'name' as name,
  c.payload->>'phone' as phone,
  c.payload->>'email' as email,
  c.payload->>'address' as address,
  c.payload->>'cityStateZip' as city_state_zip,
  c.payload->'mergedFromIds' as merged_from_ids,
  (
    select count(*) from public.workspaces w
    where w.payload->>'customerId' = c.id
  ) as job_count,
  (
    select count(*) from public.tasks t
    where t.payload->>'customerId' = c.id and t.payload->>'status' = 'open'
  ) as open_task_count
from public.customers c;

grant select on public.request_summaries to authenticated;
grant select on public.workspace_summaries to authenticated;
grant select on public.customer_summaries to authenticated;

-- ============================================================================
-- GRANTS FOR DATA API EXPOSURE
-- ============================================================================

-- Ensure all tables are exposed to Data API (PostgREST)
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;

-- Note: RLS policies control row-level access, these grants control table-level access

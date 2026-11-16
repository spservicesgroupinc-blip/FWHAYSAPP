-- Add foreign keys and check constraints to foundation tables.
-- Depends on: 20261113184722_hays_foundation.sql
-- Uses generated columns for JSONB foreign key references.

-- Add generated columns for FK references
alter table public.customer_activities
  add column customer_id text generated always as (payload->>'customerId') stored;
alter table public.customer_activities
  add column workspace_id text generated always as (payload->>'workspaceId') stored;

alter table public.tasks
  add column customer_id text generated always as (payload->>'customerId') stored;
alter table public.tasks
  add column workspace_id text generated always as (payload->>'workspaceId') stored;

alter table public.workspaces
  add column customer_id text generated always as (payload->>'customerId') stored;

alter table public.requests
  add column customer_id text generated always as (payload->>'customerId') stored;
alter table public.requests
  add column workspace_id text generated always as (payload->>'workspaceId') stored;

alter table public.job_documents
  add column workspace_id text generated always as (payload->>'workspaceId') stored;

-- Create foreign keys on generated columns
alter table public.customer_activities
  add constraint customer_activities_customer_id_fkey
  foreign key (customer_id) references public.customers(id);

alter table public.customer_activities
  add constraint customer_activities_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id);

alter table public.tasks
  add constraint tasks_customer_id_fkey
  foreign key (customer_id) references public.customers(id);

alter table public.tasks
  add constraint tasks_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id);

alter table public.workspaces
  add constraint workspaces_customer_id_fkey
  foreign key (customer_id) references public.customers(id);

alter table public.requests
  add constraint requests_customer_id_fkey
  foreign key (customer_id) references public.customers(id);

alter table public.requests
  add constraint requests_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id);

alter table public.job_documents
  add constraint job_documents_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id);

-- Check constraints for payload structure
alter table public.customers
  add constraint customers_payload_name_check
  check (payload->>'name' is not null and length(trim(payload->>'name')) between 1 and 200);

alter table public.tasks
  add constraint tasks_payload_title_check
  check (payload->>'title' is not null and length(trim(payload->>'title')) between 1 and 200);

alter table public.tasks
  add constraint tasks_payload_status_check
  check (payload->>'status' in ('open', 'done'));

alter table public.workspaces
  add constraint workspaces_payload_stage_check
  check (payload->>'stage' is null or payload->>'stage' in ('lead', 'in_progress', 'complete', 'closed'));

alter table public.requests
  add constraint requests_payload_status_check
  check (payload->>'status' in ('submitted', 'in_review', 'needs_information', 'completed'));

-- Ensure revision is non-negative on all payload tables
alter table public.customers add constraint customers_revision_nonneg check (revision >= 0);
alter table public.tasks add constraint tasks_revision_nonneg check (revision >= 0);
alter table public.workspaces add constraint workspaces_revision_nonneg check (revision >= 0);
alter table public.requests add constraint requests_revision_nonneg check (revision >= 0);
alter table public.job_documents add constraint job_documents_revision_nonneg check (revision >= 0);
alter table public.customer_activities add constraint customer_activities_revision_nonneg check (revision >= 0);

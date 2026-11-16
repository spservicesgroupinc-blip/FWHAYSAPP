-- Add indexes for query patterns on all payload tables.
-- Depends on: 20261116100000_add_foreign_keys_and_constraints.sql

-- Customer access patterns
create index idx_customers_name on public.customers ((payload->>'name'));
create index idx_customers_updated_at on public.customers (updated_at desc);

-- Activity access patterns
create index idx_customer_activities_customer_id on public.customer_activities ((payload->>'customerId'));
create index idx_customer_activities_workspace_id on public.customer_activities ((payload->>'workspaceId'));
create index idx_customer_activities_at on public.customer_activities ((payload->>'at') desc);

-- Task access patterns
create index idx_tasks_customer_id on public.tasks ((payload->>'customerId'));
create index idx_tasks_workspace_id on public.tasks ((payload->>'workspaceId'));
create index idx_tasks_status on public.tasks ((payload->>'status'));
create index idx_tasks_due_date on public.tasks ((payload->>'dueDate'));

-- Workspace access patterns
create index idx_workspaces_customer_id on public.workspaces ((payload->>'customerId'));
create index idx_workspaces_stage on public.workspaces ((payload->>'stage'));
create index idx_workspaces_updated_at on public.workspaces (updated_at desc);

-- Request access patterns
create index idx_requests_customer_id on public.requests ((payload->>'customerId'));
create index idx_requests_workspace_id on public.requests ((payload->>'workspaceId'));
create index idx_requests_status on public.requests ((payload->>'status'));
create index idx_requests_updated_at on public.requests (updated_at desc);

-- Job document access patterns
create index idx_job_documents_workspace_id on public.job_documents ((payload->>'workspaceId'));

-- Job directory access patterns
create index idx_jobs_job_number on public.jobs ((payload->>'jobNumber'));
create index idx_jobs_customer on public.jobs ((payload->>'customer'));
create index idx_jobs_active on public.jobs ((payload->>'active'));

-- Customer reference access patterns
create index idx_customer_reference_updated_at on public.customer_reference (updated_at desc);

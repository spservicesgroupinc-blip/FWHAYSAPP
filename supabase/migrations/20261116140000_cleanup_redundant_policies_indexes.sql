-- Remove redundant foundation read policies and duplicate indexes introduced
-- by the consolidated RLS/index migration. The scoped policies remain.
do $$
declare
  t text;
begin
  foreach t in array array['customer_activities','customer_reference','customers','job_documents','jobs','requests','tasks','workspaces'] loop
    execute format('drop policy if exists active_staff_read on public.%I', t);
  end loop;
end $$;

drop index if exists public.activities_customer_idx;
drop index if exists public.tasks_customer_idx;
drop index if exists public.workspaces_customer_idx;
drop index if exists public.job_documents_workspace_idx;
drop index if exists public.requests_workspace_idx;


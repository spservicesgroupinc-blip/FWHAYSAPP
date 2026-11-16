-- Comprehensive RLS policies for all application tables.
-- Depends on: 20261116100000_add_foreign_keys_and_constraints.sql

-- Helper: active staff membership check
-- All policies require active staff membership; read policies also allow
-- staff to read records related to their customers/workspaces.

-- staff_members: staff can read their own membership; admins can manage all
create policy staff_members_read_own on public.staff_members
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy staff_members_manage_all on public.staff_members
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  );

-- customers: active staff can read all; active staff can insert/update/delete
create policy customers_read_active_staff on public.customers
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy customers_write_active_staff on public.customers
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

-- customer_activities: active staff can read all; insert requires customer access
create policy customer_activities_read_active_staff on public.customer_activities
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy customer_activities_insert_active_staff on public.customer_activities
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.customers c
      where c.id = (payload->>'customerId')
    )
  );

create policy customer_activities_update_active_staff on public.customer_activities
  for update to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy customer_activities_delete_active_staff on public.customer_activities
  for delete to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  );

-- tasks: active staff can read all; write requires customer access
create policy tasks_read_active_staff on public.tasks
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy tasks_write_active_staff on public.tasks
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.customers c
      where c.id = (payload->>'customerId')
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.customers c
      where c.id = (payload->>'customerId')
    )
  );

-- workspaces: active staff can read all; write requires customer access
create policy workspaces_read_active_staff on public.workspaces
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy workspaces_write_active_staff on public.workspaces
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.customers c
      where c.id = coalesce((payload->>'customerId'), (payload->'record'->'customer'->>'id'))
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.customers c
      where c.id = coalesce((payload->>'customerId'), (payload->'record'->'customer'->>'id'))
    )
  );

-- requests: active staff can read all; write requires customer/workspace access
create policy requests_read_active_staff on public.requests
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy requests_write_active_staff on public.requests
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and (
      (payload->>'customerId') is null
      or exists (
        select 1 from public.customers c
        where c.id = (payload->>'customerId')
      )
    )
    and (
      (payload->>'workspaceId') is null
      or exists (
        select 1 from public.workspaces w
        where w.id = (payload->>'workspaceId')
      )
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and (
      (payload->>'customerId') is null
      or exists (
        select 1 from public.customers c
        where c.id = (payload->>'customerId')
      )
    )
    and (
      (payload->>'workspaceId') is null
      or exists (
        select 1 from public.workspaces w
        where w.id = (payload->>'workspaceId')
      )
    )
  );

-- job_documents: active staff can read all; write requires workspace access
create policy job_documents_read_active_staff on public.job_documents
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy job_documents_write_active_staff on public.job_documents
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.workspaces w
      where w.id = (payload->>'workspaceId')
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.workspaces w
      where w.id = (payload->>'workspaceId')
    )
  );

-- jobs: replaceable directory, active staff can read all; write for admins/staff
create policy jobs_read_active_staff on public.jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy jobs_write_active_staff on public.jobs
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

-- customer_reference: replaceable reference, active staff can read all; write for admins
create policy customer_reference_read_active_staff on public.customer_reference
  for select to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
  );

create policy customer_reference_write_admin on public.customer_reference
  for all to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  );

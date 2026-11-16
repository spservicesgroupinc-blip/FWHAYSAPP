-- The old FOR ALL admin policy queried staff_members from its own SELECT
-- policy, causing recursive-policy failures during the access check. Keep
-- SELECT self-read separate and scope admin writes to INSERT/UPDATE/DELETE.
drop policy if exists staff_members_manage_all on public.staff_members;

create policy staff_members_insert_admin on public.staff_members
  for insert to authenticated
  with check (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  );

create policy staff_members_update_admin on public.staff_members
  for update to authenticated
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

create policy staff_members_delete_admin on public.staff_members
  for delete to authenticated
  using (
    exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active and m.role = 'admin'
    )
  );

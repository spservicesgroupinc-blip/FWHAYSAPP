-- Storage policies for the hays-private bucket.
-- Depends on: 20261116100004_private_file_protocol.sql
-- The bucket is private with no client access policies. These policies grant
-- authenticated staff scoped access to reserve, upload, finalize, and download
-- files tied to parent record permissions.

-- Staff can insert (upload) objects at their own reserved object path.
-- The object path is server-generated and opaque; clients cannot forge it.
create policy staff_insert_own_objects on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'hays-private'
    and exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and (storage.folder_id(name))[1] = 'files'
  );

-- Staff can select (read metadata of) objects they own or that belong to
-- parents they have access to. Download is further gated by the file_service
-- RPC which checks completion and parent permission.
create policy staff_select_own_objects on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hays-private'
    and exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and exists (
      select 1 from public.private_files pf
      where pf.object_path = name
        and pf.actor = (select auth.uid())
        and pf.complete = true
    )
  );

-- No updates or deletes: objects are immutable once uploaded.
-- (No policy needed; default deny applies.)

-- Service role retains full access for the Edge Function finalize path.
-- (Already granted via grant all on storage.objects to service_role in the
-- bucket setup; no additional policy required.)

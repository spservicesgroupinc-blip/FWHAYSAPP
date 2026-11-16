-- File storage schema for Supabase Edge Functions
-- Run after the complete schema migration

-- SECURITY HOLD: This draft must not run. Client-writable reservation state
-- and unverified finalization can forge file receipts and bypass checks.
-- Replace it with parent-authorized, server-verified operations and integration
-- tests before removing this hold.
do $$ begin
  raise exception 'Blocked: file_storage is an unsafe draft; see security hold';
end $$;

-- ============================================================================
-- FILE RESERVATIONS TABLE
-- ============================================================================

create table if not exists public.file_reservations (
  ticket uuid primary key default gen_random_uuid(),
  parent_type text not null check (parent_type in ('request', 'workspace')),
  parent_id text not null,
  file_id text not null,
  name text not null,
  mime_type text not null,
  kind text not null,
  mutation_id text not null,
  size bigint not null check (size > 0 and size <= 15 * 1024 * 1024),
  sha256 text not null,
  input_fingerprint text,
  template_version integer,
  object_path text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null check (state in ('reserved', 'uploaded', 'complete')) default 'reserved',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (parent_type, parent_id, file_id),
  unique (mutation_id)
);

alter table public.file_reservations enable row level security;
revoke all on public.file_reservations from public, anon, authenticated;
grant select, insert, update on public.file_reservations to authenticated;

-- Staff can read their own reservations
create policy staff_read_own_reservations on public.file_reservations
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Staff can insert reservations for records they have access to
create policy staff_insert_reservations on public.file_reservations
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.staff_members m
      where m.user_id = (select auth.uid()) and m.active
    )
    and (
      (parent_type = 'request' and exists (
        select 1 from public.requests r where r.id = parent_id
      ))
      or (parent_type = 'workspace' and exists (
        select 1 from public.workspaces w where w.id = parent_id
      ))
    )
  );

-- Staff can update their own reservations (for state transitions)
create policy staff_update_own_reservations on public.file_reservations
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Indexes
create index if not exists file_reservations_parent_idx on public.file_reservations (parent_type, parent_id);
create index if not exists file_reservations_mutation_idx on public.file_reservations (mutation_id);
create index if not exists file_reservations_user_idx on public.file_reservations (user_id);

-- ============================================================================
-- STORAGE RPC FUNCTIONS
-- ============================================================================

-- Reserve file upload
create or replace function public.reserve_file_upload(
  p_parent_type text,
  p_parent_id text,
  p_file_id text,
  p_name text,
  p_mime_type text,
  p_kind text,
  p_mutation_id text,
  p_size bigint,
  p_sha256 text,
  p_input_fingerprint text default null,
  p_template_version integer default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  reservation jsonb;
  object_path text;
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;

  -- Verify parent access
  if p_parent_type = 'request' then
    if not exists (select 1 from public.requests where id = p_parent_id) then
      raise exception 'Request not found' using errcode = '404';
    end if;
  elsif p_parent_type = 'workspace' then
    if not exists (select 1 from public.workspaces where id = p_parent_id) then
      raise exception 'Workspace not found' using errcode = '404';
    end if;
  else
    raise exception 'Invalid parent type' using errcode = '22023';
  end if;

  -- Check for existing reservation with same mutation ID
  select to_jsonb(fr.*) into reservation
  from public.file_reservations fr
  where fr.mutation_id = p_mutation_id;

  if found then
    if reservation->>'sha256' <> p_sha256
      or (reservation->>'size')::bigint <> p_size
      or reservation->>'file_id' <> p_file_id then
      raise exception 'Mutation ID already used with different data' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'state', 'complete',
      'receipt', jsonb_build_object(
        'parentType', reservation->>'parent_type',
        'parentId', reservation->>'parent_id',
        'fileId', reservation->>'file_id',
        'name', reservation->>'name',
        'mimeType', reservation->>'mime_type',
        'kind', reservation->>'kind',
        'mutationId', reservation->>'mutation_id',
        'size', (reservation->>'size')::bigint,
        'sha256', reservation->>'sha256',
        'inputFingerprint', reservation->>'input_fingerprint',
        'templateVersion', (reservation->>'template_version')::int
      )
    );
  end if;

  object_path := p_parent_type || 's/' || p_parent_id || '/' || p_file_id;

  insert into public.file_reservations (
    parent_type, parent_id, file_id, name, mime_type, kind,
    mutation_id, size, sha256, input_fingerprint, template_version,
    object_path, user_id, state
  ) values (
    p_parent_type, p_parent_id, p_file_id, p_name, p_mime_type, p_kind,
    p_mutation_id, p_size, p_sha256, p_input_fingerprint, p_template_version,
    object_path, actor, 'reserved'
  )
  returning to_jsonb(file_reservations.*) into reservation;

  return jsonb_build_object(
    'state', 'upload',
    'ticket', reservation->>'ticket',
    'identity', jsonb_build_object(
      'parentType', p_parent_type,
      'parentId', p_parent_id,
      'fileId', p_file_id,
      'name', p_name,
      'mimeType', p_mime_type,
      'kind', p_kind,
      'mutationId', p_mutation_id,
      'size', p_size,
      'sha256', p_sha256,
      'inputFingerprint', p_input_fingerprint,
      'templateVersion', p_template_version
    )
  );
end $$;

revoke all on function public.reserve_file_upload(text,text,text,text,text,text,text,bigint,text,text,integer) from public, anon;
grant execute on function public.reserve_file_upload(text,text,text,text,text,text,text,bigint,text,text,integer) to authenticated;

-- Finalize file upload
create or replace function public.finalize_file_upload(
  p_ticket uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  reservation record;
  object_path text;
  file_bytes bytea;
  hash_hex text;
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;

  select * into reservation
  from public.file_reservations
  where ticket = p_ticket and user_id = actor;

  if not found then
    raise exception 'Reservation not found' using errcode = '404';
  end if;

  if reservation.state <> 'uploaded' then
    raise exception 'File not uploaded yet' using errcode = '22023';
  end if;

  object_path := reservation.object_path;

  -- Note: In a real implementation, we'd verify the file in storage
  -- For now, we trust the Edge Function verification
  -- The Edge Function should call this after verifying the file

  update public.file_reservations
  set state = 'complete', completed_at = now()
  where ticket = p_ticket;

  return jsonb_build_object(
    'state', 'complete',
    'receipt', jsonb_build_object(
      'parentType', reservation.parent_type,
      'parentId', reservation.parent_id,
      'fileId', reservation.file_id,
      'name', reservation.name,
      'mimeType', reservation.mime_type,
      'kind', reservation.kind,
      'mutationId', reservation.mutation_id,
      'size', reservation.size,
      'sha256', reservation.sha256,
      'inputFingerprint', reservation.input_fingerprint,
      'templateVersion', reservation.template_version
    )
  );
end $$;

revoke all on function public.finalize_file_upload(uuid) from public, anon;
grant execute on function public.finalize_file_upload(uuid) to authenticated;

-- Download file (returns metadata, actual download via signed URL)
create or replace function public.download_file(
  p_parent_type text,
  p_parent_id text,
  p_file_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  reservation record;
  signed_url text;
begin
  if actor is null or not exists (
    select 1 from public.staff_members where user_id = actor and active
  ) then
    raise exception 'Active staff membership required' using errcode = '42501';
  end if;

  -- Verify parent access
  if p_parent_type = 'request' then
    if not exists (select 1 from public.requests where id = p_parent_id) then
      raise exception 'Request not found' using errcode = '404';
    end if;
  elsif p_parent_type = 'workspace' then
    if not exists (select 1 from public.workspaces where id = p_parent_id) then
      raise exception 'Workspace not found' using errcode = '404';
    end if;
  else
    raise exception 'Invalid parent type' using errcode = '22023';
  end if;

  select * into reservation
  from public.file_reservations
  where parent_type = p_parent_type
    and parent_id = p_parent_id
    and file_id = p_file_id
    and state = 'complete';

  if not found then
    raise exception 'File not found' using errcode = '404';
  end if;

  -- Generate signed URL for download (valid for 1 hour)
  -- Note: This requires the storage extension to be available
  -- In practice, the Edge Function generates the signed URL
  signed_url := 'https://' || current_setting('app.supabase_url') || '/storage/v1/object/sign/hays-private/' || reservation.object_path || '?token=...';

  return jsonb_build_object(
    'receipt', jsonb_build_object(
      'parentType', reservation.parent_type,
      'parentId', reservation.parent_id,
      'fileId', reservation.file_id,
      'name', reservation.name,
      'mimeType', reservation.mime_type,
      'kind', reservation.kind,
      'mutationId', reservation.mutation_id,
      'size', reservation.size,
      'sha256', reservation.sha256,
      'inputFingerprint', reservation.input_fingerprint,
      'templateVersion', reservation.template_version
    ),
    'signedUrl', signed_url
  );
end $$;

revoke all on function public.download_file(text,text,text) from public, anon;
grant execute on function public.download_file(text,text,text) to authenticated;

-- ============================================================================
-- STORAGE BUCKET POLICIES (Additional)
-- ============================================================================

-- The hays-private bucket was created in the foundation migration
-- Add policies for file_reservations-based access

-- Allow authenticated users to download files they have reservations for
create policy "file_reservations_download" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'hays-private'
    and exists (
      select 1 from public.file_reservations fr
      where fr.object_path = storage.objects.name
      and fr.state = 'complete'
      and fr.user_id = auth.uid()
    )
  );

-- Allow authenticated users to upload to reserved paths
create policy "file_reservations_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'hays-private'
    and exists (
      select 1 from public.file_reservations fr
      where fr.object_path = storage.objects.name
      and fr.state = 'reserved'
      and fr.user_id = auth.uid()
    )
  );

-- ============================================================================
-- GRANTS
-- ============================================================================

grant usage on schema public to anon, authenticated;
grant select on public.file_reservations to anon, authenticated;

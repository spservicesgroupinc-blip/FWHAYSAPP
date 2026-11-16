-- Private file storage protocol: buckets, tables, and service functions.
-- Depends on: 20261116100002_rls_policies.sql
-- Replaces: 20261116094639_private_file_protocol.sql (held draft, SECURITY HOLD)

-- Create the private storage bucket (managed via Supabase Storage API, not SQL).
-- This migration assumes bucket 'hays-private' exists; create it via the
-- Supabase dashboard or CLI before applying this migration.

-- File reservation table: tracks upload tickets before finalization.
create table public.private_files (
  ticket uuid primary key default gen_random_uuid(),
  actor uuid not null references auth.users(id),
  parent_type text not null check (parent_type in ('request', 'workspace')),
  parent_id text not null,
  file_id text not null,
  identity jsonb not null,
  object_path text not null unique,
  complete boolean not null default false,
  created_at timestamptz not null default now(),
  unique(parent_type, parent_id, file_id)
);
alter table public.private_files enable row level security;
revoke all on public.private_files from public, anon, authenticated;
grant all on public.private_files to service_role;

-- Migration file tracking: maps source Drive file IDs to Supabase objects.
create table public.migration_files (
  drive_file_id text primary key,
  bucket_id text not null default 'hays-private' check (bucket_id = 'hays-private'),
  object_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size > 0),
  mime_type text not null
);
alter table public.migration_files enable row level security;
revoke all on public.migration_files from public, anon, authenticated;
grant all on public.migration_files to service_role;
grant select on public.requests, public.workspaces to service_role;

-- Parent access check (security definer, service_role only).
create function hays_private.check_file_parent(
  p_actor uuid,
  p_type text,
  p_id text,
  p_write boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  if not exists (
    select 1 from public.staff_members where user_id = p_actor and active
  ) then
    raise exception 'Active staff required' using errcode = '42501';
  end if;
  if p_type = 'request' then
    select payload into item from public.requests where id = p_id for share;
  elsif p_type = 'workspace' then
    select payload into item from public.workspaces where id = p_id for share;
  else
    raise exception 'Invalid parent' using errcode = '22023';
  end if;
  if item is null then raise exception 'Parent missing' using errcode = 'P0002'; end if;
  if p_write and p_type = 'request' and item->>'status' = 'completed' then
    raise exception 'Completed request is read-only' using errcode = '42501';
  end if;
end $$;
revoke all on function hays_private.check_file_parent(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function hays_private.check_file_parent(uuid, text, text, boolean) to service_role;
grant usage on schema hays_private to service_role;

-- Service entrypoint for file operations (reserve, upload, finalize, download).
-- p_actor comes from Edge auth.getUser(), never from request JSON.
create function public.file_service(
  p_actor uuid,
  p_action text,
  p_identity jsonb default null,
  p_ticket uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.private_files%rowtype; typ text; pid text; fid text; new_ticket uuid;
begin
  if p_action = 'reserve' then
    typ := p_identity->>'parentType';
    pid := p_identity->>'parentId';
    fid := p_identity->>'fileId';
    if p_identity is null or jsonb_typeof(p_identity) <> 'object' or typ is null or pid is null or fid is null
      or length(pid) not between 1 and 200 or length(fid) not between 1 and 200
      or jsonb_typeof(p_identity->'size') is distinct from 'number'
      or (p_identity->>'size')::bigint not between 1 and 15728640
      or coalesce(p_identity->>'sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(p_identity->>'mimeType', '') not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
      or length(coalesce(p_identity->>'name', '')) not between 1 and 300
      or length(coalesce(p_identity->>'mutationId', '')) not between 1 and 200 then
      raise exception 'Invalid identity' using errcode = '22023';
    end if;
    perform hays_private.check_file_parent(p_actor, typ, pid, true);
    perform pg_advisory_xact_lock(hashtextextended(typ || ':' || pid || ':' || fid, 0));
    select * into r from public.private_files
      where parent_type = typ and parent_id = pid and file_id = fid for update;
    if found then
      if r.actor <> p_actor or r.identity <> p_identity then
        raise exception 'File identity collision' using errcode = '22023';
      end if;
    else
      new_ticket := gen_random_uuid();
      insert into public.private_files(ticket, actor, parent_type, parent_id, file_id, identity, object_path)
      values (new_ticket, p_actor, typ, pid, fid, p_identity, 'files/' || new_ticket::text) returning * into r;
    end if;
  else
    select * into r from public.private_files where ticket = p_ticket for update;
    if not found then raise exception 'File missing' using errcode = 'P0002'; end if;
    perform hays_private.check_file_parent(p_actor, r.parent_type, r.parent_id, p_action <> 'download');
    if p_action in ('upload', 'finalize') and r.actor <> p_actor then
      raise exception 'Not upload owner' using errcode = '42501';
    end if;
    if p_action = 'finalize' then
      if not exists (
        select 1 from storage.objects
        where bucket_id = 'hays-private' and name = r.object_path
      ) then
        raise exception 'Object missing' using errcode = 'P0002';
      end if;
      update public.private_files set complete = true where ticket = r.ticket returning * into r;
    elsif p_action = 'download' then
      if not r.complete then raise exception 'File incomplete' using errcode = 'P0002'; end if;
    elsif p_action <> 'upload' then
      raise exception 'Invalid operation' using errcode = '22023';
    end if;
  end if;
  return to_jsonb(r);
end $$;
revoke all on function public.file_service(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.file_service(uuid, text, jsonb, uuid) to service_role;

-- Indexes for file lookups
create index idx_private_files_parent on public.private_files (parent_type, parent_id, file_id);
create index idx_private_files_actor on public.private_files (actor);
create index idx_migration_files_sha256 on public.migration_files (sha256);

-- All bytes are handled by the authenticated Edge service. Browser roles have
-- no object write policies; files cannot be replaced between verification and commit.
create table public.private_files (
  ticket uuid primary key default gen_random_uuid(),
  actor uuid not null references auth.users(id),
  parent_type text not null check (parent_type in ('request','workspace')),
  parent_id text not null,
  file_id text not null,
  identity jsonb not null,
  object_path text not null unique,
  complete boolean not null default false,
  created_at timestamptz not null default now(),
  unique(parent_type,parent_id,file_id)
);
alter table public.private_files enable row level security;
revoke all on public.private_files from public, anon, authenticated;
grant all on public.private_files to service_role;

create table public.migration_files (
  drive_file_id text primary key,
  bucket_id text not null default 'hays-private' check(bucket_id='hays-private'),
  object_path text not null unique,
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check(size>0),
  mime_type text not null
);
alter table public.migration_files enable row level security;
revoke all on public.migration_files from public, anon, authenticated;
grant all on public.migration_files to service_role;
grant select on public.requests, public.job_documents to service_role;

create function hays_private.check_file_parent(p_actor uuid,p_type text,p_id text,p_write boolean)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  if not exists(select 1 from public.staff_members where user_id=p_actor and active) then
    raise exception 'Active staff required' using errcode='42501';
  end if;
  if p_type='request' then
    select payload into item from public.requests where id=p_id for share;
  elsif p_type='workspace' then
    select payload into item from public.workspaces where id=p_id for share;
  else raise exception 'Invalid parent' using errcode='22023'; end if;
  if item is null then raise exception 'Parent missing' using errcode='P0002'; end if;
  if p_write and p_type='request' and item->>'status'='completed' then
    raise exception 'Completed request is read-only' using errcode='42501';
  end if;
end $$;
revoke all on function hays_private.check_file_parent(uuid,text,text,boolean) from public,anon,authenticated;

-- Service-only entrypoint. p_actor comes from Edge auth.getUser(), never request JSON.
create function public.file_service(p_actor uuid,p_action text,p_identity jsonb default null,p_ticket uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.private_files%rowtype; typ text; pid text; fid text; new_ticket uuid;
begin
  if p_action='reserve' then
    typ:=p_identity->>'parentType'; pid:=p_identity->>'parentId'; fid:=p_identity->>'fileId';
    if p_identity is null or jsonb_typeof(p_identity)<>'object' or typ is null or pid is null or fid is null
      or length(pid) not between 1 and 200 or length(fid) not between 1 and 200
      or jsonb_typeof(p_identity->'size') is distinct from 'number'
      or (p_identity->>'size')::bigint not between 1 and 15728640
      or coalesce(p_identity->>'sha256','') !~ '^[0-9a-f]{64}$'
      or coalesce(p_identity->>'mimeType','') not in ('application/pdf','image/jpeg','image/png','image/webp')
      or length(coalesce(p_identity->>'name','')) not between 1 and 300
      or length(coalesce(p_identity->>'mutationId','')) not between 1 and 200 then
      raise exception 'Invalid identity' using errcode='22023'; end if;
    perform hays_private.check_file_parent(p_actor,typ,pid,true);
    perform pg_advisory_xact_lock(hashtextextended(typ||':'||pid||':'||fid,0));
    select * into r from public.private_files where parent_type=typ and parent_id=pid and file_id=fid for update;
    if found then
      if r.actor<>p_actor or r.identity<>p_identity then raise exception 'File identity collision' using errcode='22023'; end if;
    else
      new_ticket:=gen_random_uuid();
      insert into public.private_files(ticket,actor,parent_type,parent_id,file_id,identity,object_path)
      values(new_ticket,p_actor,typ,pid,fid,p_identity,'files/'||new_ticket::text) returning * into r;
    end if;
  else
    select * into r from public.private_files where ticket=p_ticket for update;
    if not found then raise exception 'File missing' using errcode='P0002'; end if;
    perform hays_private.check_file_parent(p_actor,r.parent_type,r.parent_id,p_action<>'download');
    if p_action in ('upload','finalize') and r.actor<>p_actor then raise exception 'Not upload owner' using errcode='42501'; end if;
    if p_action='finalize' then
      if not exists(select 1 from storage.objects where bucket_id='hays-private' and name=r.object_path) then
        raise exception 'Object missing' using errcode='P0002'; end if;
      update public.private_files set complete=true where ticket=r.ticket returning * into r;
    elsif p_action='download' then
      if not r.complete then raise exception 'File incomplete' using errcode='P0002'; end if;
    elsif p_action<>'upload' then raise exception 'Invalid operation' using errcode='22023'; end if;
  end if;
  return to_jsonb(r);
end $$;
revoke all on function public.file_service(uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.file_service(uuid,text,jsonb,uuid) to service_role;
grant execute on function hays_private.check_file_parent(uuid,text,text,boolean) to service_role;
grant usage on schema hays_private to service_role;
update storage.buckets set file_size_limit=15728640 where id='hays-private';

create function public.legacy_file_service(p_actor uuid,p_parent_type text,p_parent_id text,p_drive_file_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare linked boolean:=false; result jsonb;
begin
  perform hays_private.check_file_parent(p_actor,p_parent_type,p_parent_id,false);
  if p_parent_type='request' then
    select exists(select 1 from public.requests r, jsonb_array_elements(coalesce(r.payload->'attachments','[]'::jsonb)) a
      where r.id=p_parent_id and a->>'driveFileId'=p_drive_file_id) into linked;
  else
    select exists(select 1 from public.job_documents where payload->>'workspaceId'=p_parent_id and payload->>'driveFileId'=p_drive_file_id) into linked;
  end if;
  if not linked then raise exception 'File is not linked to parent' using errcode='42501'; end if;
  select to_jsonb(m) into result from public.migration_files m where drive_file_id=p_drive_file_id;
  if result is null then raise exception 'File unavailable' using errcode='P0002'; end if;
  return result;
end $$;
revoke all on function public.legacy_file_service(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.legacy_file_service(uuid,text,text,text) to service_role;

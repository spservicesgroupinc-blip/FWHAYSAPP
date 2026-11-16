-- Keep the privilege-elevated implementation in a non-exposed schema. The
-- API wrapper executes as the caller and delegates to the membership-checked
-- implementation. No client may directly change app tables.
alter function public.save_record(text,text,jsonb,integer,text) set schema hays_private;
grant usage on schema hays_private to authenticated;
create function public.save_record(
  p_table text,
  p_id text,
  p_payload jsonb,
  p_expected_revision integer,
  p_mutation_id text
) returns jsonb language sql security invoker set search_path = ''
as $$
  select hays_private.save_record(p_table, p_id, p_payload, p_expected_revision, p_mutation_id);
$$;
revoke all on function public.save_record(text,text,jsonb,integer,text) from public, anon;
grant execute on function public.save_record(text,text,jsonb,integer,text) to authenticated;

-- Requests are imported and submitted independently from CRM/workspace rows.
-- Their JSON references may point to records that sync later, so enforcing
-- generated-column FKs here rejects valid submissions.
alter table public.requests drop constraint if exists requests_customer_id_fkey;
alter table public.requests drop constraint if exists requests_workspace_id_fkey;

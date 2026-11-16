-- Expand staff_members.role check constraint to include estimator and project_manager.
-- Depends on: 20261113184722_hays_foundation.sql
-- The foundation constraint only allows ('admin', 'staff'), but the app types and
-- planned RLS policies reference 'estimator' and 'project_manager'. This mismatch
-- blocks role-based authorization until resolved.

alter table public.staff_members
  drop constraint staff_members_role_check;

alter table public.staff_members
  add constraint staff_members_role_check
  check (role in ('admin', 'staff', 'estimator', 'project_manager'));

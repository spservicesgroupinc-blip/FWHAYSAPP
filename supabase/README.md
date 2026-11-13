# Supabase development foundation

The two migrations establish a preliminary schema, approved staff membership,
read policies, a private bucket, and a limited `save_record` RPC. They are not
ready for production use: request workflows, document and attachment access,
complete domain validation, customer merge, imports, and integrations still
need implementation and end-to-end testing. The bucket has no client access
policies; file uploads and downloads are intentionally disabled.

The isolated FWHAYSAPP project was empty when these migrations were applied.
Its migration versions match the filenames. On 2026-11-13, the security advisor
returned no findings. A rolled-back test verified that an unapproved identity
could not read a synthetic record, call the save RPC, or insert directly; anon
had no read or RPC grant. All public application tables had RLS enabled and the
bucket was private. No user accounts or persistent test records were created.
A second rolled-back test used a temporary synthetic auth identity and staff
membership. It verified approved reads and writes, initial and subsequent
revisions, identical mutation replay, mutation ID mismatch, stale revision
rejection, unsupported entity rejection, and access denial after deactivation.
No identity or test data remained after rollback. Truly concurrent transactions
and storage policies still require integration tests.

`config.toml` disables self-signup for local development; this file alone does
not configure the hosted project's auth settings. Confirm hosted signup,
redirect URLs, SMTP, session and MFA settings before inviting staff. Membership
must be inserted through a trusted administrative operation after a user is
provisioned; clients can only read their own membership. Local Supabase testing
requires Docker or Podman, which was unavailable during this verification.

The save RPC currently allows shared active staff to write workspaces,
customers and tasks. It preserves revisions and retry IDs but does not yet
implement all business-level validation. It must remain a development-only
foundation until those rules and denial tests are completed.

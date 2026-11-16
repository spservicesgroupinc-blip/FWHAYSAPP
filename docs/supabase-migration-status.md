# Supabase migration status

As of November 14, 2026, migration is **not ready for cutover**. The existing app remains connected to Apps Script. Do not deploy the held schema drafts, Edge Functions, or the isolated Supabase adapters.

The user identified the live source spreadsheet; its expected backend tabs and headers were verified read-only. A preliminary read of column A through row 999 found 6 requests, 109 directory jobs, 28 workspaces, 85 customers, 2 customer activities, 24 customer-reference rows, and no populated task or job-document rows. These are not reconciled migration totals: sheet edits, gaps, Drive history, attachments, and device-only drafts require separate verification.

The new FWHAYSAPP Supabase project has only the two foundation migrations. Prior isolated, rolled-back tests covered staff access and revocation, revision checks, retry identity and unauthorized access. Supabase's security advisor returned no findings on November 14. These checks do not establish feature parity or production readiness.

A standalone customer-activity append RPC and client adapter are being developed with replay identifiers. They are not connected to the app or applied to the hosted project. The held draft migrations precede the new migration and prevent ordinary migration replay until the drafts are safely replaced.

## Required next work

- Replace the held `complete_schema` draft with independently reviewed migrations. Its privileged generic writes bypass request workflow rules, its owner-executed views and broad grants can expose data, role constraints conflict with policies, and retry/merge behavior is incomplete.
- Replace the held file-storage draft and Edge Function with an authorized, server-verified upload/download protocol. Reservation ownership, actual object integrity, parent access, idempotency and download contracts must be tested. Current draft must not be deployed.
- Finish request, CRM, workspace, directory, customer-reference, email and AI backend parity. Connect the frontend only after tests demonstrate that Supabase is the sole source for each migrated workflow; no local fallback may report a shared save or email succeeded.
- Complete durable user-associated offline queues and visible conflict recovery, including account changes and cross-tab behavior.
- Implement an idempotent importer and reconciliation after source snapshots, Drive files, history and destination file contracts are established. The current import/reconciliation scripts deliberately refuse writes.
- Inventory and reconcile the actual source and per-device drafts, rehearse cutover and rollback, configure invitation-based staff authentication, and verify backup and restore for database and object bytes.

No customer data has been imported into Supabase, and no source records or files were altered by the inventory. The new Supabase client and adapters are not the active app backend.

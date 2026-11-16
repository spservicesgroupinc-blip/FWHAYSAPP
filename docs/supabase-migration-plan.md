# Supabase storage and authentication migration plan

## Goal and current state

Move FWHAYSAPP's shared data, files and staff authentication to Supabase while preserving jobs, customer records, change requests, generated PDFs, offline drafts and existing workflows. This is a plan, not a production migration. The existing Vite/React frontend and hosting remain in place.

The checked-out app uses an Apps Script API backed by Google Sheets and Drive. Requests and workspaces use revision and retry identifiers; workspaces have an IndexedDB outbox. CRM is local-first but its pending mutation map is in memory, and request submission can remain in memory until completion. The Apps Script source describes an Anyone-accessible deployment and its handlers do not show staff authentication. Verify the live deployment and data; staff sign-in is a new experience, not a migration of existing accounts.

The existing `tasks/plan.md` and `tasks/todo.md` have unfinished work and are unchanged. This document is the migration checklist. The earlier Convex plan is superseded.

## Proposed architecture

1. **Postgres database:** Use separate development and production Supabase projects, versioned SQL migrations and generated TypeScript types. Model requests, directory jobs, permanent workspaces, customer reference, customers, activities, tasks, attachments and document metadata. Preserve legacy identifiers, links, revisions, status, financial snapshots and timestamps. Keep the replaceable CSV directory separate from permanent jobs. Add foreign keys, constraints, indexes and pagination based on actual access patterns; use transactions for multi-record operations.
2. **Staff identity:** Use Supabase Auth with explicit staff invitations or administrator approval. Start with admin and staff roles, then define estimator and project-manager restrictions from actual workflows. Decide email/password versus email links, recovery, MFA, sign-up restrictions and email delivery before implementation. Establish a secure initial admin and disable unapproved self-registration.
3. **Authorization:** Enable row-level security (RLS) on all exposed application tables, with policies based on trusted staff membership, role and relevant record relationships. Apply the same checks to storage and privileged operations. RLS and database grants are separate; configure and test both. Avoid authorization based on user-editable metadata, and keep secret/service-role credentials out of the browser. Test disabled accounts, denied reads and writes, relationship checks, views and any privileged functions. See [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
4. **Files:** Put attachments and saved PDFs in private Supabase Storage buckets, with object paths and metadata linked to their parent records. Use storage policies matching the parent permissions. Prefer authenticated downloads when access needs to be rechecked; time-limited signed URLs are bearer links that can remain usable until expiry. Validate upload size limits, resumable uploads, retries, orphan cleanup and mobile previews. See [private file downloads](https://supabase.com/docs/guides/storage/serving/downloads).
5. **Offline and synchronization:** Keep durable IndexedDB drafts and an explicit outbox, including operation IDs, expected revisions and conflict recovery. Persist pending CRM and request work across reloads. Use conditional writes or an atomic database function for compare-and-swap and idempotency; distinguish a stale revision from a permissions failure. Realtime may refresh connected views but is not an offline queue. Associate drafts with a user and handle sign-out, shared devices and account changes without silently losing work.
6. **Integrations:** Inventory email and AI intake. Replace Apps Script integrations with authenticated Supabase Edge Functions and appropriate providers, or a tightly restricted temporary bridge. Store secrets server-side; protect against duplicate sends, unauthorized calls and excessive use. Preserve the current PDF generation and CSV import semantics.
7. **Recovery:** Establish and test database and file backup/restore separately. Supabase database backups do not contain Storage object bytes; retain independent object backups and verify restored metadata-to-file links. Confirm current plan limits and costs before choosing production settings. See [database backups](https://supabase.com/docs/guides/platform/backups).

## Ordered tasks and acceptance checks

### 1. Inventory and decisions

- [ ] Inventory the live Sheets tabs, Drive folders, file counts and sizes, historical snapshots, deployed endpoint access, integrations and device-local drafts. Identify the authoritative source for each entity. **Verify:** document counts, permissions, owners and data found only on devices.
- [ ] Decide the Supabase organization and projects, sign-in and recovery method, staff membership and roles, MFA, retention, backup targets, budget and cutover window. **Verify:** record owners and test the chosen sign-in on desktop and installed mobile PWA.
- [ ] Map each source record and file to its destination, including missing files, duplicates, deleted references, historical PDFs and CSV replacement behavior. **Verify:** review mapping and reconciliation rules with representative anonymized records.

### 2. Foundation and security

- [ ] Initialize a local/development Supabase environment and versioned migrations; connect the Vite client using only public client configuration. Provision the first administrator securely. **Verify:** sign-in, sign-out, recovery and a protected read work; unapproved and disabled users are denied.
- [ ] Build schema, constraints, indexes, grants, RLS policies, transactional revision checks and durable operation deduplication. Restrict privileged functions and use server-held credentials only where required. **Verify:** automated tests for anonymous and unauthorized users, cross-record access, stale writes, duplicate retries, concurrency and invalid inputs; run security advisors.
- [ ] Add private buckets, parent-linked metadata, authorized uploads and downloads, and cleanup of failed uploads. **Verify:** file integrity, rejected access, access changes, retries, file size limits and previews on desktop and mobile.

### 3. App parity and offline behavior

- [ ] Move requests, workspaces, jobs, documents, directory imports, customer reference and CRM through a storage adapter in small slices. **Verify:** existing unit, backend and PDF suites plus create, edit, claim, complete, merge, import and file-download flows; preserve links and financial values.
- [ ] Persist pending CRM and request operations and retain workspace drafts, with explicit device-saved, waiting, synced and conflict states. **Verify:** offline edits survive restart, replay once, retain edits during conflicts and do not leak drafts across staff accounts.
- [ ] Replace or secure email and AI intake. **Verify:** authorization, secret handling, failure and retry behavior, duplicate-send protection, and existing intake and document workflows.

### 4. Rehearsal and reconciliation

- [ ] Build a restricted, resumable and idempotent import: export Sheets and referenced Drive snapshots/files, upload objects, import records in bounded batches and maintain source-to-destination mappings. **Verify:** reruns do not duplicate records or files; relationships and source IDs remain traceable.
- [ ] Rehearse on a representative production copy without customer data in logs or test fixtures. Compare counts, relationships, statuses, revisions, amounts, file checksums and representative PDFs. **Verify:** resolve or explicitly accept every discrepancy.
- [ ] Inventory and drain or explicitly recover each device's pending drafts. **Verify:** record a device-by-device disposition and preserve unresolved edits.

### 5. Cutover and rollback

- [ ] Rehearse a short write freeze: stop old frontend writes, restrict the Apps Script write surface and stale PWA clients, wait for in-flight work, take a recoverable Sheets/Drive snapshot, import the final delta and reconcile. Use one authoritative writer. **Verify:** old clients cannot write and counts, checksums and critical workflows pass.
- [ ] Switch the frontend to production Supabase after data, auth, RLS and file validation. Monitor sign-ins, denied access, writes, file transfers and integrations; assign an owner and rollback window. **Verify:** staff complete critical workflows and recover device drafts.
- [ ] Keep old data and a tested rollback procedure. Before switching back, freeze Supabase writes and export/reconcile all post-cutover records, changes and files into the old system or preserve them for re-import. **Verify:** rehearse pre-write rollback and post-write recovery, with owners and a decision deadline.
- [ ] After acceptance, retire the old write endpoint and unused credentials; document operations and test database and object restoration. **Verify:** no active client or integration depends on the endpoint and retention requirements are met.

## Decisions and risks

- Who should receive access, what can each role do, and are MFA and account recovery required?
- Local-only drafts may exist on staff devices and cannot be discovered by a server export alone.
- Supabase login does not secure the old Apps Script endpoint or existing Drive permissions; address them during cutover after identifying dependencies.
- Measure data volume, file sizes, expected traffic, backup requirements and current Supabase costs before choosing a production plan.
- This plan reflects repository inspection and current product documentation, not a live data audit or a verified Supabase project.

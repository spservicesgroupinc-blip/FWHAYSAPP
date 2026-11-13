# Convex storage and authentication migration plan

> Superseded by [the Supabase migration plan](supabase-migration-plan.md). Retained for historical reference; Supabase is the selected direction.

## Goal and current state

Move the FWHAYSAPP shared database, attachments, and staff authentication to Convex while preserving jobs, customer records, change requests, generated PDFs, offline drafts, and existing workflows. This is a plan; it does not authorize a production cutover or claim that the live data matches the repository.

The checked-out Vite/React app uses an Apps Script API backed by Sheets and Drive. Requests and workspaces include revision and retry identifiers; workspaces have an IndexedDB outbox. CRM is stored locally, but its pending mutation map is currently in memory. Request submission can also be in memory until completion. The Apps Script source describes an Anyone-accessible deployment and its handlers do not show staff authentication. Verify actual deployment settings and data before migration; adding auth is a new user experience, not a transfer of existing accounts.

The existing `tasks/plan.md` and `tasks/todo.md` contain unfinished work and remain intact. This file is the migration task list.

## Proposed architecture

- Use a dedicated Convex project with separate development and production deployments. Retain the existing Vite frontend and hosting. Configure the Convex React provider with the selected authentication integration.
- Evaluate current Convex Auth v2 for first-party authentication and confirm its capabilities for this team's sign-in and recovery needs. Use staff accounts with an explicit invitation or administrator approval process; do not rely solely on email domain. The exact provider, enrollment method, recovery and MFA requirements are decisions before implementation. Convex's [Auth v2 documentation](https://docs.convex.dev/auth/convex-auth) identifies it as the current stable release; verify current setup instructions at implementation time.
- Store staff membership and roles in Convex; enforce authorization on every public query, mutation, action, upload and download. Start with admin and staff, adding narrower estimator/project-manager permissions only after documenting the existing workflow. Do not trust a name, role, client filter, or file ID supplied by a browser.
- Model requests, job directory entries, permanent workspaces, customer references, customers, activities, tasks, document metadata, attachments and migration mappings. Preserve legacy IDs and links with indexed source IDs, revisions, timestamps, status, snapshots and historical financial values. Define indexes from actual screen access patterns and paginate growing lists. Keep the replaceable CSV directory separate from permanent jobs.
- Use Convex file storage for attachments and saved PDFs, with metadata and ownership tied to the parent record. For sensitive files, authenticate and authorize each download using an HTTP action; a `storage.getUrl()` link is a bearer URL, not a per-request authorization mechanism. Confirm file-size limits and an alternative for files too large for authorized HTTP responses. See [Convex file security](https://docs.convex.dev/file-storage/overview).
- Preserve durable device drafts and an explicit outbox with retries, revision checks and conflict resolution. Convex's live subscriptions and client retries improve connected behavior, but do not by themselves prove persistence across browser restarts. Bind pending work to the signed-in account and design shared-device sign-out and recovery behavior.
- Inventory Apps Script's email and AI intake separately. Replace them with authenticated Convex actions and appropriate providers or retain a restricted transitional integration; configure secrets server-side. Preserve PDF generation, CSV import semantics and existing UI behaviors.

## Ordered tasks and acceptance checks

### 1. Inventory and decisions

- [ ] Inventory the actual production Sheets tabs, Drive folders, file counts/sizes, archived versions, current endpoint access, locally stored drafts, user devices and all deployed integrations. Identify the authoritative deployment and source for each entity. **Verify:** produce counts, access and ownership matrix, and list of data that exists only on devices.
- [ ] Decide staff onboarding, recovery, MFA, roles, retention, export/backup, acceptable file costs, cutover window, and the Convex account/team/project. **Verify:** document owners and decisions; test the chosen sign-in on desktop and installed mobile PWA.
- [ ] Define feature parity and data reconciliation rules, including missing Drive files, duplicate IDs, references to deleted records, historical PDFs, CSV replacements and local/server conflicts. **Verify:** sign off a mapping with representative anonymized records.

### 2. Foundation and security

- [ ] Initialize Convex in a development deployment, configure Vite and the selected auth provider, provision a first administrator securely, and set deployment-specific environment variables. **Verify:** sign-in, sign-out, recovery and a protected read work; anonymous and disabled accounts are denied.
- [ ] Implement validated schema, indexed queries and transactional mutations, staff authorization, audit fields, revision checks and idempotency for durable outbox operations. **Verify:** automated tests cover role denial, cross-record access, duplicate retries, stale revisions, invalid input and concurrent edits.
- [ ] Implement authorized upload/download and metadata linking; handle failed, duplicate and orphaned uploads. **Verify:** file integrity, permissions after access changes, retries, size limits, preview and downloads on mobile and desktop.

### 3. App parity and offline behavior

- [ ] Migrate requests, workspace/job/document screens, directory imports, customer reference and CRM in small slices through a storage adapter. Preserve links, statuses, signed amounts and document generation. **Verify:** existing unit/backend/PDF suites plus end-to-end create, edit, claim, complete, merge, import and download flows.
- [ ] Persist pending CRM and request operations where needed, retain workspace drafts and show device-saved, waiting, synced and conflict states. **Verify:** offline edits survive reload and restart, replay once after reconnect, report conflicts without losing edits, and do not leak drafts between staff accounts.
- [ ] Replace email and AI endpoints or document and secure a temporary bridge. **Verify:** authorization, secrets, failure/retry behavior and no duplicate emails; generated files and intake still work.

### 4. Rehearsal and reconciliation

- [ ] Build a repeatable, resumable, idempotent migration using restricted service credentials: export Sheets and current referenced Drive snapshots/files, upload files, import in bounded batches, and record source-to-Convex IDs and failures. **Verify:** rerunning does not duplicate records or attachments; preserve source IDs and relationships.
- [ ] Rehearse on a representative production copy without exposing customer data in logs or test fixtures. Compare counts, missing records, relationships, statuses, revisions, amounts, file checksums and representative PDFs. **Verify:** every discrepancy is resolved or explicitly accepted before proceeding.
- [ ] Inventory and drain or explicitly recover each device's pending drafts before cutover. **Verify:** record a device-by-device disposition; do not silently overwrite local changes.

### 5. Cutover and rollback

- [ ] Rehearse a time-limited write freeze: stop old frontend writes and restrict the old Apps Script write surface, including stale PWA clients; wait for in-flight operations, take a recoverable final Sheets/Drive snapshot, import the delta and reconcile. Keep one authoritative writer. **Verify:** old clients cannot write, counts/checksums match and representative end-to-end flows pass.
- [ ] Switch the frontend to production Convex only after migration and auth validation. Monitor sign-ins, authorization failures, writes, file transfers and integrations; retain a named owner and rollback window. **Verify:** real staff complete the critical workflows and can recover device drafts.
- [ ] Keep the old data and a tested rollback procedure until acceptance. Before any switch back, freeze Convex writes and export/reconcile all new records, changes and files into the old system or explicitly preserve them for re-import; changing the frontend alone would lose post-cutover work. **Verify:** rehearse both pre-write rollback and post-write recovery, with owners and a decision deadline.
- [ ] After acceptance, retire the old write endpoint and unused credentials, document operational ownership and test backup restoration. **Verify:** no active client or integration depends on it and retention requirements are met.

## Key risks and open decisions

1. **Authentication is a behavior change:** who should be invited, which roles are needed, and are MFA and account recovery required?
2. **Local-only work:** unsynced drafts may exist on individual devices and cannot be discovered from a server export alone.
3. **Old endpoint access:** a new login does not protect a still-accessible Apps Script endpoint or its underlying files. Restrict it as part of cutover, after confirming dependencies.
4. **File access and cost:** validate production volume, file sizes, access requirements and Convex usage costs before committing to a storage approach.
5. **Unknown production state:** this plan is based on repository inspection, not a live Sheets/Drive audit or a verified Convex deployment.

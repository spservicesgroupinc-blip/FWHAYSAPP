# Supabase migration preparation and rehearsal

This runbook prepares a source inventory. It does **not** import data, copy files to Supabase, alter source data, or establish that the migration is ready for cutover. Complete and test an importer against the final database and storage contract before using it for production. The existing Apps Script may have live users and is the current source of truth until the cutover freeze.

## Source inventory

The existing `apps-script/Code.gs` contains these sources:

| Source | Contents | Additional data |
| --- | --- | --- |
| Requests | request index and current/previous Drive snapshot IDs | Current JSON snapshot contains the full request and attachment Drive IDs; retain previous snapshots as history. |
| Jobs | replaceable CSV job directory | Do not conflate with permanent workspaces. |
| Workspaces | permanent job index and snapshot IDs | Current Drive JSON contains the workspace; retain previous snapshots as history. |
| JobDocuments | generated document metadata and Drive ID | Copy document bytes and metadata. |
| Customers, CustomerActivities, Tasks | CRM JSON in sheet cells | Preserve IDs, customer links and mutation envelopes. |
| CustomerReference | replaceable customer reference JSON rows and metadata | Preserve the version, including an empty-but-present sheet. |

Inventory Drive history, other files, permissions, integrations and device-only drafts separately. The current snapshot/linked-file checks below do not enumerate older revisions, unlinked/orphan files, pending browser operations or Drive sharing permissions. The file's presence does not establish ownership or authorization.

The experimental `src/crm/outbox.ts` module is not connected to the existing CRM sync. Before connecting it, implement a user-visible conflict state and recovery flow, account ownership of stored drafts across sign-out and shared devices, recovery after interrupted writes, and cross-tab serialization. Verify retries reuse mutation IDs and that device-storage failures are surfaced. Until then, the existing CRM pending queue remains in memory and pending edits can be lost when the app closes.

## Extract and validate a source bundle

1. Obtain access to the *correct* source spreadsheet and Drive using a scoped authorized account. Work in a protected location outside the repository. Use a copy of the Apps Script project with `scripts/supabase-source-export.gs` installed; do not deploy its functions as an open web endpoint. Its helpers read the configured spreadsheet and Drive snapshots; they do not mutate source data. Verify copied project properties refer to the intended source before any extraction. Use authenticated Apps Script Execution API tooling to call `supabaseExportSheetPage(sheetName, offset, limit)` starting at offset 0 and continue using `nextOffset` until null. The first page includes the header. A missing sheet is returned as `exists: false` and must be investigated; the helper never creates missing sheets. Page reads are not a transactionally consistent snapshot while users are writing, so repeat after the cutover freeze.
2. Assemble the exact original rows under `sheets`, with each sheet name mapped to one array containing the header followed by all rows. For every nonempty `Requests.dataFileId` and `Workspaces.dataFileId`, call `supabaseExportSnapshot(fileId)` and put its `snapshot` under `snapshots[fileId]`. Copy all referenced request attachments and job-document files through authenticated Drive export tooling to the protected bundle directory. Use a mapping from Drive file ID to the relative local path under `files`. Do not put secrets in the bundle. Example shape:

   ```json
   {"sheets": {"Requests": [["id", "revision"]]}, "snapshots": {}, "files": {}}
   ```

   The example is illustrative only: a valid bundle needs every complete source sheet and all referenced snapshots and files. Preserve source JSON and file names in the protected bundle; don't commit it, paste it into chat, or print its contents. Independently copy current and historical snapshots and remaining Drive contents for rollback.
3. Run `node scripts/supabase-inventory.mjs <absolute-path-to-bundle.json>`. The tool is read-only, checks required header positions, duplicate IDs, referenced current snapshots and their revisions, basic CRM and workspace relationships, and local file availability. It hashes file bytes with SHA-256 and reports counts and hashed IDs for matching without printing source names or IDs. Store the output securely. A nonzero exit means investigation is required; fix the source bundle, not the live source. A zero exit only covers these checks and is not authorization to cut over.
4. Run `node scripts/supabase-import-plan.mjs <absolute-path-to-bundle.json>` to make a deterministic offline receipt for a validated bundle. The receipt deliberately reports blockers and exits nonzero: it does not upload files, import records, or imply the source is complete. Store the receipt securely. Any source record, snapshot, or referenced file change changes its digest.
5. Before creating a real importer, finalize the destination record and file-path contract, authenticated download behavior, bounded batches, durable checkpoints, idempotency and conflict rules. The importer must resume without duplicates and refuse to overwrite destination edits or silently omit source records. Compare counts and hashes with the importer and the destination after an isolated rehearsal. Compare original contract and signed change amounts, statuses, timestamps, customer/job links, current and historical documents, and representative PDF bytes. Verify mutation receipts, failures and retries, and a repeat run without duplicates. Reconcile gaps before any production cutover.

## Cutover and rollback requirements

Before a production switch, confirm destination auth, RLS and private file policies, feature parity, backups and restoration, account onboarding, staff device drafts, email/AI integrations, and a named owner. Freeze writes to the old app, including stale installed PWAs and its Apps Script endpoint; drain in-flight operations, extract a fresh source bundle, compare it to the rehearsal and apply the final delta. Validate staff workflows before releasing the freeze on the new system. Do not run simultaneous uncoordinated writers.

Keep a recoverable source snapshot and file backup. A rollback after Supabase has accepted writes requires freezing Supabase, exporting and reconciling all new records and files before returning to the old app; a frontend switch alone would discard post-cutover work. Database backups do not include Storage file bytes, so verify separate object backup and restore. Test both rollback paths before production.

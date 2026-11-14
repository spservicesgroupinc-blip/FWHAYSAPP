# Private file storage: implementation design

Status: **not implemented or enabled**. The held `20261113190001_file_storage.sql`
and `functions/file-storage/index.ts` are unsafe drafts and must not be deployed.
The existing `hays-private` bucket has no client access policies. The app's
`src/supabase/privateFiles.ts` is an unconnected client contract.

## Security and integrity requirements

Every operation must authenticate the caller and check current active staff
membership and access to the request or workspace, including after revocation.
Use an authenticated user-scoped Supabase client for parent-record and Storage
checks so RLS applies. A service key must never be treated as evidence that the
end user may access a record; service-role queries bypass RLS. A narrowly scoped
trusted server operation may be needed to mark verification complete, but it
must independently bind a verified caller identity and recheck membership and
parent permission when committing. Never let clients call that privileged
operation or supply a claim that their own bytes passed verification.

Use one private bucket and a server-generated, opaque, immutable object path.
Do not use customer names or client-controlled path segments. Do not permit
upserts, client update/delete of uploaded objects, or mutation of completed
receipts. Access to download must be tied to a completed receipt and current
parent permission, not knowledge of a ticket or object path. Authenticated
Storage requests apply RLS; signed URLs are bearer links and can remain usable
until their expiry. See [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
and [private downloads](https://supabase.com/docs/guides/storage/serving/downloads).

## Proposed protocol

1. **Reserve.** A user-scoped request validates parent type and ID, file ID,
   filename, kind, allowed MIME type, 1–15 MiB size, SHA-256, mutation ID and,
   for generated documents, template version and fingerprint. The database
   atomically records the complete identity, owner, expiration and opaque path.
   Parent write permission is checked in the transaction. A unique mutation ID
   and parent/file identity prevent concurrent duplicates. Repeating the exact
   request by the same authorized user returns the current `upload`, `finalize`
   or `complete` state; a changed field or user is rejected. The reservation is
   not client-editable through the Data API.
2. **Upload.** A policy permits only the reservation owner to insert at the
   exact reserved immutable path while the reservation is valid and the parent
   remains writable. Bind policy checks to `auth.uid()` and active membership.
   Upload directly to private Storage using the user's token; select standard
   or resumable upload by size and confirm retry behavior using the real Storage
   service. Enforce the chosen maximum on both the reservation and bucket. A
   client must not assert `uploaded` or `complete` in a database row. A lost
   upload response is resolved by inspecting the reserved object, not overwriting
   it. See [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).
3. **Verify and finalize.** An authenticated server function rechecks the
   caller and parent using a user-scoped client, reads the exact reserved object,
   verifies size, content signature and SHA-256 from the stored bytes, then uses
   a server-only commit path to atomically lock and recheck the reservation,
   actor, parent permission and immutable object identity before recording a
   completed receipt. The commit path must not be callable with a browser JWT.
   Storage and Postgres do not form one transaction: prevent overwrite or delete
   between verification and commit, define cleanup coordination, and verify any
   Storage generation/version assumptions against the actual service before
   claiming integrity. If those guarantees cannot be demonstrated, do not
   finalize. A repeated finalize returns the same verified receipt.
4. **Attach and download.** The request-save/document operation links only a
   completed receipt for the correct parent and file identity. It also checks
   PDF fingerprint and template version for generated customer documents.
   Download reauthorizes the current caller and parent and fetches bytes via an
   authenticated private Storage request; verify the resulting bytes against
   the recorded size/hash. Do not return an invented signed URL, raw Storage
   path or another user's ticket. Avoid spreading file bytes into function
   arguments or using base64 for large files; stream or transfer binary blobs.
5. **Recover and clean up.** Durable outboxes retain the same bytes and mutation
   ID through offline/restart. Expired reservations and orphaned objects need a
   privileged, auditable cleanup process that cannot delete finalized files or
   race an in-progress verification. Treat verified metadata and object backup
   separately; database backup alone does not back up file bytes.

## Verification before enabling

- Anonymous, unapproved, disabled and cross-user callers cannot reserve,
  upload, finalize or download. Test parent read versus write restrictions and
  revocation between each step, including a leaked ticket or object path.
- Exact retry succeeds at every step, including after response loss; reused IDs
  with changed parent, user, filename, content, hash, kind or template fail.
  Two concurrent reserves and finalizations create one durable receipt.
- Reject nonexistent or mismatched parents, malformed input, wrong file
  signature, hash and size, oversize files, overwritten objects, invalid object
  paths, and attempts to forge reservation or completion state through Data API.
- Simulate network loss after upload and after finalization; verify reload and
  offline recovery, checksum of downloads, correct generated PDF linkage,
  cleanup races and restoration of a file plus its database metadata.
- Run end-to-end Storage and Edge Function tests against a disposable project
  with two synthetic users, then review RLS, grants, function privileges and
  Supabase security advisors. The hosted project and real data stay unchanged.

## Decisions before implementation

Define the actual staff/record authorization model and how it is rechecked by a
trusted finalize worker. Confirm Storage immutability, request size limits,
streaming and resumable-upload behavior, billing and backups on the target plan.
Until those choices and tests establish integrity across Storage and Postgres,
there is no safe reservation/finalization migration to deploy.

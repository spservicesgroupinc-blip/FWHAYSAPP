# Private file service

This implementation depends on `20261116094639_private_file_protocol.sql` and the foundation migrations. It has not been deployed or verified against hosted Storage. Browser roles have no access to the registry RPCs or the private bucket. The Edge Function validates each caller with Supabase Auth, and service-only SQL rechecks current active staff membership and parent existence/writability.

Every operation uses POST `/functions/v1/file-storage?action=<action>` with the staff JWT in `Authorization: Bearer ...`. Configure `FILE_ALLOWED_ORIGINS` as a comma-separated exact frontend origin allowlist before hosting; the default permits only `http://localhost:3000` and `http://127.0.0.1:3000`. Never put the service role key in the frontend. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the hosted function.

| Action | Request | Response |
|---|---|---|
| reserve | JSON `PrivateFileIdentity` | `{state:"upload",ticket,identity}` or `{state:"complete",receipt}` |
| upload | raw Blob; `x-file-ticket` header | `{ok:true}` after size, signature and SHA-256 verification and immutable upload |
| finalize | JSON `{ticket}` | exact identity after stored-byte verification and database reauthorization |
| download | JSON `{parentType,parentId,fileId}` | binary Blob; URL-encoded JSON identity in `x-file-receipt` |
| legacyDownload | JSON `{parentType,parentId,driveFileId}` | binary Blob after checking the ID is linked in the parent's request attachments or workspace document metadata |

Paths are opaque server-generated `files/<ticket>` values; clients cannot select or replace them. On an upload collision the service downloads and verifies the existing immutable object before acknowledging. A lost upload or finalization response can be retried with the same ticket and exact bytes. A complete reservation always returns its original receipt. Downloads reauthorize after reading bytes and use `Cache-Control: no-store`; no signed/public URL is returned.

Imported files use `public.migration_files` with `drive_file_id`, `bucket_id='hays-private'`, `object_path`, `sha256`, `size`, and `mime_type`. Only the trusted importer/service can read or write this table; legacy downloads prove the mapping belongs to the requested parent before reading bytes.

Run `deno check supabase/functions/file-storage/index.ts` and `deno test supabase/functions/file-storage/validation_test.ts`. For isolated SQL tests, install `@electric-sql/pglite` in a disposable test environment, set `PGLITE_MODULE` to its module directory if it is outside this repository, then run `node supabase/tests/private-files.cjs`. These checks do not replace hosted integration tests for authentication, CORS, binary upload/retry, concurrent reservations, finalization, revocation and downloads.

The registry does not yet link newly uploaded documents into request/workspace payloads or implement orphan cleanup. Callers must finish those workflows before enabling the app's file controls. Requests that are completed are read-only; uploaded objects remain downloadable by active staff with parent access. The app's shared staff access model is retained.

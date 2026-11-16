# Supabase Migration - Task Breakdown & Sub-Agent Organization

## Overview
Migrate FWHAYSAPP from Apps Script (Google Sheets + Drive) to Supabase (Postgres + Auth + Storage) while preserving all existing functionality, offline capabilities, and data integrity.

## Current State Analysis

### Existing Supabase Foundation (Already Implemented)
- ✅ **Migrations**: 2 migrations in `supabase/migrations/`
  - `20261113184722_hays_foundation.sql` - Core tables, RLS, `save_record` function, mutation receipts
  - `20261113184745_protect_save_record.sql` - Security definer function protection
- ✅ **Client**: `src/supabase/client.ts` - Validated public config, anon key only
- ✅ **Records API**: `src/supabase/records.ts` - `saveSupabaseRecord` with conflict detection
- ✅ **Workspaces API**: `src/supabase/workspaces.ts` - List, open, save with cursor pagination
- ✅ **Private Files Protocol**: `src/supabase/privateFiles.ts` - Reservation/upload/finalize/download
- ✅ **Auth Gate**: `src/supabase/SupabaseAuthGate.tsx` - Staff sign-in with membership check
- ✅ **Tests**: `supabase-config.test.ts`, `supabase-records.test.ts`, `supabase-workspaces.test.ts`

### Source Data (Apps Script)
- **Sheets**: Requests, Jobs, Workspaces, JobDocuments, Customers, CustomerActivities, Tasks, CustomerReference
- **Drive**: Request snapshots, workspace snapshots, job documents, attachments
- **API**: Single Apps Script endpoint with actions for all entities

### App Architecture
- **Frontend**: Vite + React 19 + PWA (vite-plugin-pwa)
- **Storage**: Local-first IndexedDB + localStorage + in-memory CRM pending queue
- **Sync**: Background sync with exponential backoff, mutation IDs for idempotency
- **Offline**: Durable outbox (CRM), request drafts, workspace drafts

---

## Sub-Agent Organization

### Agent 1: Database & Schema Engineer
**Focus**: Complete Postgres schema, RLS policies, indexes, functions
**Files**: `supabase/migrations/`, `supabase/config.toml`
**Tasks**:
- [ ] Extend foundation migration with all entity tables (requests, jobs, workspaces, job_documents, customers, customer_activities, tasks, customer_reference)
- [ ] Add foreign keys, constraints, check constraints for data integrity
- [ ] Create comprehensive RLS policies for all tables (staff membership + record relationships)
- [ ] Add indexes for query patterns (workspaceId, customerId, status, dates)
- [ ] Create `save_record` overloads for requests, job_documents
- [ ] Add database advisors checks
- [ ] Generate TypeScript types from schema

### Agent 2: Auth & Authorization Specialist
**Focus**: Supabase Auth setup, staff roles, invitation flow, RLS integration
**Files**: `src/supabase/auth.css`, `src/supabase/SupabaseAuthGate.tsx`, `src/supabase/client.ts`
**Tasks**:
- [ ] Configure Supabase Auth providers (email/password, email links)
- [ ] Set up staff invitation flow with admin approval
- [ ] Define roles: admin, staff, estimator, project_manager
- [ ] Implement MFA and account recovery policies
- [ ] Create initial admin user securely
- [ ] Test disabled/unapproved user denial
- [ ] Integrate with existing `SupabaseAuthGate` component

### Agent 3: Storage & Files Engineer
**Focus**: Private Supabase Storage buckets, upload/download, policies
**Files**: `src/supabase/privateFiles.ts`, new storage migration
**Tasks**:
- [ ] Create private buckets: `hays-private` (attachments, PDFs, snapshots)
- [ ] Design object path structure: `{parentType}/{parentId}/{fileId}`
- [ ] Implement storage policies matching parent record RLS
- [ ] Build Edge Function for reservation/upload/finalize/download protocol
- [ ] Add file validation (MIME, size, signatures, SHA-256)
- [ ] Implement resumable uploads and orphan cleanup
- [ ] Test mobile previews and authenticated downloads

### Agent 4: Data Layer & Sync Engineer
**Focus**: Storage adapter, offline sync, mutation receipts, conflict resolution
**Files**: `src/supabase/records.ts`, `src/supabase/workspaces.ts`, `src/crm/outbox.ts`, `src/crm/sync.ts`, `src/services/storage.ts`
**Tasks**:
- [ ] Create unified `SupabaseStorage` adapter implementing existing storage interface
- [ ] Port request/workspace/CRM operations to Supabase RPC/functions
- [ ] Implement durable outbox for all mutations (requests, workspaces, CRM)
- [ ] Add mutation receipt verification and retry logic
- [ ] Handle conflict states: device-saved → waiting → synced → conflict
- [ ] Preserve drafts across sign-out, shared devices, account changes
- [ ] Cross-tab serialization for concurrent edits

### Agent 5: Import Pipeline Engineer
**Focus**: Source bundle validation, idempotent import, reconciliation
**Files**: `scripts/supabase-inventory.mjs`, `scripts/supabase-import-plan.mjs`, `scripts/supabase-source-export.gs`
**Tasks**:
- [ ] Finalize source bundle format (sheets, snapshots, files)
- [ ] Build deterministic import with bounded batches
- [ ] Implement checkpoint/resume without duplicates
- [ ] Maintain source→destination ID mappings
- [ ] Verify counts, relationships, checksums, financial values
- [ ] Compare original contract amounts, signed change amounts, PDFs
- [ ] Handle historical snapshots and orphan files

### Agent 6: Frontend Integration Engineer
**Focus**: Connect UI to Supabase, replace Apps Script calls, preserve UX
**Files**: `src/App.tsx`, `src/components/`, `src/services/`, `src/crm/`, `src/workspaces/`
**Tasks**:
- [ ] Replace `storage.ts` Apps Script calls with Supabase adapter
- [ ] Connect `SupabaseAuthGate` to app routing
- [ ] Update CRM sync to use Supabase backend
- [ ] Migrate document generation to Supabase Storage
- [ ] Preserve all offline states and UI indicators
- [ ] Update request submission flow
- [ ] Test all 61 browser scenarios

### Agent 7: Testing & Verification Engineer
**Focus**: Automated tests, security advisors, load testing, browser verification
**Files**: `tests/`, `playwright.config.ts`
**Tasks**:
- [ ] Extend unit tests for Supabase operations
- [ ] Add RLS policy tests (anonymous, unauthorized, cross-record)
- [ ] Test mutation receipt idempotency and conflict detection
- [ ] Test storage upload/download with policies
- [ ] Run `supabase db advisors` and fix issues
- [ ] Execute full browser test suite (61 scenarios)
- [ ] Verify PDF generation and download flows

---

## Migration Phases

### Phase 1: Foundation (Week 1-2)
- Agents 1, 2, 3 work in parallel on schema, auth, storage
- Agent 7 sets up test infrastructure
- **Deliverable**: Working local Supabase with auth, RLS, storage

### Phase 2: Data Layer (Week 2-3)
- Agent 4 builds storage adapter and sync
- Agent 5 builds import pipeline
- **Deliverable**: App reads/writes to local Supabase, offline works

### Phase 3: Integration (Week 3-4)
- Agent 6 connects frontend
- Agent 7 runs full test suite
- **Deliverable**: Feature parity with Apps Script backend

### Phase 4: Rehearsal (Week 4-5)
- Agent 5 runs import on production copy
- All agents verify reconciliation
- **Deliverable**: Validated import receipt, resolved discrepancies

### Phase 5: Cutover (Week 5-6)
- Coordinated write freeze, delta import, frontend switch
- Rollback procedures tested
- **Deliverable**: Production on Supabase, old endpoint retired

---

## Key Technical Decisions (from plan)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema approach | Imperative migrations | Existing migrations, explicit control |
| Auth method | Email/password + email links | Staff invitations, admin approval |
| Roles | admin, staff, estimator, project_manager | Workflow-based restrictions |
| Storage | Private buckets + signed URLs | Access revalidation, bearer link limits |
| Offline | IndexedDB outbox + mutation receipts | Survives restart, idempotent retries |
| Import | Deterministic, resumable, idempotent | No duplicates, traceable mappings |
| Realtime | Optional refresh only | Not an offline queue |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Local-only drafts on devices | Inventory per-device before cutover, explicit recovery |
| Old Apps Script still accessible | Freeze writes during cutover, restrict endpoint |
| Supabase costs unknown | Measure data volume, file sizes, traffic before production plan |
| RLS policy gaps | Automated tests for every policy, security advisors |
| Migration duplicates | Deterministic import with source IDs, checksums |

---

## Next Steps

1. **Enable Supabase MCP** in VS Code to use MCP tools
2. **Start Phase 1** with Agents 1, 2, 3 in parallel
3. **Create development branch** on Supabase project
4. **Run `supabase db advisors`** after each migration
5. **Generate TypeScript types** with `supabase gen types typescript`

---

## File Ownership (Disjoint for Parallel Work)

| Agent | Files |
|-------|-------|
| 1 - Database | `supabase/migrations/*.sql`, `supabase/config.toml` |
| 2 - Auth | `src/supabase/SupabaseAuthGate.tsx`, `src/supabase/auth.css`, `src/supabase/client.ts` |
| 3 - Storage | `src/supabase/privateFiles.ts`, new Edge Function, storage migration |
| 4 - Data Layer | `src/supabase/records.ts`, `src/supabase/workspaces.ts`, `src/crm/outbox.ts`, `src/crm/sync.ts`, `src/services/storage.ts` |
| 5 - Import | `scripts/supabase-inventory.mjs`, `scripts/supabase-import-plan.mjs`, `scripts/supabase-source-export.gs` |
| 6 - Frontend | `src/App.tsx`, `src/components/**`, `src/services/**`, `src/crm/**`, `src/workspaces/**` |
| 7 - Testing | `tests/**`, `playwright.config.ts` |
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveSupabaseRecord, SupabaseRecordError } from "../src/supabase/records";
import type { Customer } from "../src/crm/types";

const customer: Customer = { id: "c1", revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", name: "Example" };
const client = (fn: (name: string, args: Record<string, unknown>) => Promise<unknown>) => ({ rpc: fn }) as unknown as Pick<SupabaseClient, "rpc">;

test("save carries exact identity, revision and retry key", async () => {
  const api = client(async (name, args) => {
    assert.equal(name, "save_record");
    assert.deepEqual(args, { p_table: "customers", p_id: "c1", p_payload: customer, p_expected_revision: 1, p_mutation_id: "retry-1" });
    return { data: { ...customer, revision: 2 }, error: null };
  });
  assert.equal((await saveSupabaseRecord(api, "customers", customer, 1, "retry-1")).revision, 2);
});

test("save distinguishes stale edits and rejects malformed confirmations", async () => {
  const conflict = client(async () => ({ data: null, error: { code: "40001" } }));
  await assert.rejects(saveSupabaseRecord(conflict, "customers", customer, 1, "retry-1"), (e: unknown) => e instanceof SupabaseRecordError && e.kind === "conflict");
  const badResponse = client(async () => ({ data: { ...customer, revision: 7 }, error: null }));
  await assert.rejects(saveSupabaseRecord(badResponse, "customers", customer, 1, "retry-1"), (e: unknown) => e instanceof SupabaseRecordError && e.kind === "service");
});

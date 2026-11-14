import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Activity } from "../src/crm/types";
import { appendSupabaseActivity, SupabaseActivityError } from "../src/supabase/activities";

const activity: Activity = { id: "a1", customerId: "c1", kind: "note", direction: "outbound", body: "Called back", at: "2026-11-14T12:00:00Z" };
const client = (rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) => ({ rpc }) as unknown as Pick<SupabaseClient, "rpc">;

test("activity append sends exact payload and preserves the caller's retry identifier", async () => {
  const calls: Record<string, unknown>[] = [];
  const api = client(async (name, args) => { assert.equal(name, "append_customer_activity"); calls.push(args); return { data: args.p_activity, error: null }; });
  assert.deepEqual(await appendSupabaseActivity(api, activity, "operation-1"), activity);
  assert.deepEqual(await appendSupabaseActivity(api, activity, "operation-1"), activity);
  assert.deepEqual(calls, [{ p_activity: activity, p_mutation_id: "operation-1" }, { p_activity: activity, p_mutation_id: "operation-1" }]);
});

test("activity append rejects identifier reuse and preserves service errors for retry", async () => {
  const duplicate = client(async () => ({ data: null, error: { code: "22023" } }));
  await assert.rejects(appendSupabaseActivity(duplicate, activity, "operation-1"), (e: unknown) => e instanceof SupabaseActivityError && e.kind === "invalid");
  const denied = client(async () => ({ data: null, error: { code: "42501" } }));
  await assert.rejects(appendSupabaseActivity(denied, activity, "operation-1"), (e: unknown) => e instanceof SupabaseActivityError && e.kind === "denied");
  const missing = client(async () => ({ data: null, error: { code: "P0002" } }));
  await assert.rejects(appendSupabaseActivity(missing, activity, "operation-1"), (e: unknown) => e instanceof SupabaseActivityError && e.kind === "not_found");
  const network = client(async () => { throw new Error("lost response"); });
  await assert.rejects(appendSupabaseActivity(network, activity, "operation-1"), (e: unknown) => e instanceof SupabaseActivityError && e.kind === "service");
});

test("activity append rejects altered acknowledgements and blank identifiers", async () => {
  const altered = client(async () => ({ data: { ...activity, body: "wrong" }, error: null }));
  await assert.rejects(appendSupabaseActivity(altered, activity, "operation-1"), (e: unknown) => e instanceof SupabaseActivityError && e.kind === "service");
  await assert.rejects(appendSupabaseActivity(altered, activity, ""), (e: unknown) => e instanceof SupabaseActivityError && e.kind === "invalid");
});

test("an uncertain outcome can be replayed with the same ID without a second logical insert", async () => {
  const receipts = new Map<string, Activity>();
  let inserts = 0;
  let loseFirstResponse = true;
  const api = client(async (_name, args) => {
    const id = args.p_mutation_id as string;
    const payload = args.p_activity as Activity;
    if (!receipts.has(id)) { receipts.set(id, payload); inserts += 1; }
    if (loseFirstResponse) { loseFirstResponse = false; throw new Error("response lost"); }
    return { data: receipts.get(id), error: null };
  });
  await assert.rejects(appendSupabaseActivity(api, activity, "operation-1"), SupabaseActivityError);
  assert.deepEqual(await appendSupabaseActivity(api, activity, "operation-1"), activity);
  assert.equal(inserts, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../src/workspaces/types";
import { listSupabaseWorkspaces, openSupabaseWorkspace, saveSupabaseWorkspace } from "../src/supabase/workspaces";
import { SupabaseRecordError } from "../src/supabase/records";

const workspace = (id: string): Workspace => ({ id, revision: 1, updatedAt: "2026-01-01", originalContract: "", previousChanges: "", record: {} as Workspace["record"] });
const row = (id: string) => ({ id, revision: 1, payload: workspace(id) });
function mockRead(rows: unknown[], error: unknown = null) {
  const calls: unknown[][] = [];
  const query = {
    select: (...args: unknown[]) => { calls.push(["select", ...args]); return query; },
    order: (...args: unknown[]) => { calls.push(["order", ...args]); return query; },
    limit: (...args: unknown[]) => { calls.push(["limit", ...args]); return query; },
    gt: (...args: unknown[]) => { calls.push(["gt", ...args]); return query; },
    eq: (...args: unknown[]) => { calls.push(["eq", ...args]); return query; },
    maybeSingle: async () => ({ data: rows[0] ?? null, error }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(resolve),
  };
  return { calls, client: { from: (name: string) => { calls.push(["from", name]); return query; } } as unknown as Pick<SupabaseClient, "from"> };
}

test("workspace listing requests a bounded cursor page and reports continuation", async () => {
  const { client, calls } = mockRead([row("b"), row("c"), row("d")]);
  const page = await listSupabaseWorkspaces(client, "a", 2);
  assert.deepEqual(page.workspaces.map((item) => item.id), ["b", "c"]);
  assert.equal(page.nextCursor, "c");
  assert.ok(calls.some((call) => call[0] === "gt" && call[1] === "id" && call[2] === "a"));
  assert.ok(calls.some((call) => call[0] === "limit" && call[1] === 3));
});

test("opening validates stored snapshots and preserves service errors", async () => {
  assert.equal((await openSupabaseWorkspace(mockRead([row("a")]).client, "a"))?.id, "a");
  assert.equal(await openSupabaseWorkspace(mockRead([]).client, "missing"), null);
  await assert.rejects(openSupabaseWorkspace(mockRead([{ ...row("a"), revision: 2 }]).client, "a"), SupabaseRecordError);
  await assert.rejects(openSupabaseWorkspace(mockRead([], { message: "denied" }).client, "a"), SupabaseRecordError);
});

test("workspace saves retain caller retry identity and surface conflicts", async () => {
  const client = { rpc: async (_name: string, args: { p_mutation_id: string }) => {
    assert.equal(args.p_mutation_id, "retry-1");
    return { data: null, error: { code: "40001" } };
  } } as unknown as Pick<SupabaseClient, "rpc">;
  await assert.rejects(saveSupabaseWorkspace(client, workspace("a"), 1, "retry-1"), (error: unknown) => error instanceof SupabaseRecordError && error.kind === "conflict");
});

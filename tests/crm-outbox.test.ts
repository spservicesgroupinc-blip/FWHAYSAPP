import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { enqueue, listPending, acknowledge, markConflict } from "../src/crm/outbox";
import type { Customer } from "../src/crm/types";

const customer = (id: string, name: string, revision = 0): Customer => ({ id, name, revision, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

test("queue survives reads and acknowledges only the matching head", async () => {
  const id = crypto.randomUUID();
  await enqueue({ kind: "customer", entity: customer(id, "first"), expectedRevision: 0, mutationId: "one" });
  await enqueue({ kind: "customer", entity: customer(id, "newer", 1), expectedRevision: 0, mutationId: "two" });
  const before = (await listPending()).find(x => x.key === `customer:${id}`)!;
  assert.deepEqual(before.entries.map(x => x.mutationId), ["one", "two"]);
  assert.equal(await acknowledge(before.key, "wrong", 1), false);
  assert.equal(await acknowledge(before.key, "one", 1), true);
  const remaining = (await listPending()).find(x => x.key === before.key)!;
  assert.equal(remaining.entries[0].mutationId, "two");
  assert.equal(remaining.entries[0].kind === "customer" && remaining.entries[0].expectedRevision, 1);
  await markConflict(before.key, "two");
  const blocked = (await listPending()).find(x => x.key === before.key)!;
  assert.equal(blocked.conflict, true);
  assert.equal(blocked.entries[0].mutationId, "two");
  assert.equal(await acknowledge(before.key, "two", 2), false);
});

test("refuses to accept mutations when durable device storage is unavailable", async () => {
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
  try {
    await assert.rejects(enqueue({ kind: "customer", entity: customer("missing", "unsaved"), expectedRevision: 0, mutationId: "unwritten" }), /storage is unavailable/);
  } finally {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: previous });
  }
});

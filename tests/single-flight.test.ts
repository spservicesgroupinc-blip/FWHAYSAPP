import assert from "node:assert/strict";
import test from "node:test";
import { createSingleFlight } from "../src/services/singleFlight";

test("single-flight shares one active operation across concurrent callers", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const run = createSingleFlight(async () => {
    calls += 1;
    await blocked;
    return calls;
  });

  const first = run();
  const second = run();
  assert.equal(calls, 1);
  assert.equal(first, second);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
});

test("single-flight permits a new operation after success or failure", async () => {
  let calls = 0;
  const run = createSingleFlight(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary");
    return calls;
  });

  await assert.rejects(run(), /temporary/);
  assert.equal(await run(), 2);
});

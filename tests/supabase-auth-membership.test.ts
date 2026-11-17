import assert from "node:assert/strict";
import test from "node:test";
import { membershipCheckKey } from "../src/supabase/authMembership";

test("membership checks stay stable across repeated auth events for the same user", () => {
  assert.equal(membershipCheckKey("user-1", false, 0), "user-1:0");
  assert.equal(membershipCheckKey("user-1", false, 0), "user-1:0");
});

test("membership checks restart only for a retry, account change, or completed password setup", () => {
  assert.equal(membershipCheckKey("user-1", false, 1), "user-1:1");
  assert.equal(membershipCheckKey("user-2", false, 0), "user-2:0");
  assert.equal(membershipCheckKey("user-1", true, 0), null);
  assert.equal(membershipCheckKey(null, false, 0), null);
});

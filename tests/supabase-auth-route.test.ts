import test from "node:test";
import assert from "node:assert/strict";
import { authRedirectUrl, showAuthPreview } from "../src/supabase/authRoute";

test("staff preview is explicit and does not replace the default app", () => {
  assert.equal(showAuthPreview({}, ""), false);
  assert.equal(showAuthPreview({}, "?staffAuth=1"), true);
  assert.equal(showAuthPreview({}, "?staffAuth=0"), false);
  assert.equal(showAuthPreview({ VITE_SUPABASE_AUTH_PREVIEW: "true" }, ""), true);
  assert.equal(showAuthPreview({ VITE_SUPABASE_AUTH_PREVIEW: "false" }, ""), false);
});

test("email callback keeps auth preview selected without preserving credentials", () => {
  assert.equal(authRedirectUrl({ origin: "http://localhost:3000", pathname: "/" }), "http://localhost:3000/?staffAuth=1");
  assert.equal(authRedirectUrl({ origin: "https://app.example", pathname: "/staff/" }), "https://app.example/staff/?staffAuth=1");
});

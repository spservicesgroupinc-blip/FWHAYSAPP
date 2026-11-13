import assert from "node:assert/strict";
import test from "node:test";
import { readSupabaseConfig } from "../src/supabase/client";

test("Supabase client configuration accepts public keys and secure URLs", () => {
  assert.deepEqual(readSupabaseConfig({ VITE_SUPABASE_URL: "https://example.supabase.co/", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }), { url: "https://example.supabase.co", publishableKey: "sb_publishable_test" });
  assert.ok(readSupabaseConfig({ VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }));
});

test("Supabase client rejects missing config, insecure URLs and service credentials", () => {
  const key = "sb_publishable_test";
  assert.equal(readSupabaseConfig({}), null);
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "http://example.com", VITE_SUPABASE_PUBLISHABLE_KEY: key }), null);
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "https://example.com", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_test" }), null);
  const serviceJwt = `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  assert.equal(readSupabaseConfig({ VITE_SUPABASE_URL: "https://example.com", VITE_SUPABASE_PUBLISHABLE_KEY: serviceJwt }), null);
});

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupabaseConfig = { url: string; publishableKey: string };

/** Validate public browser configuration without ever accepting a secret key. */
export function readSupabaseConfig(env: Record<string, unknown>): SupabaseConfig | null {
  const url = typeof env.VITE_SUPABASE_URL === "string" ? env.VITE_SUPABASE_URL.trim() : "";
  const publishableKey = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === "string"
    ? env.VITE_SUPABASE_PUBLISHABLE_KEY.trim() : "";
  if (!url || !publishableKey || publishableKey.startsWith("sb_secret_")) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) return null;
    // Legacy JWT secret/service-role keys must never be included in a client bundle.
    if (publishableKey.split(".").length === 3) {
      const payload = publishableKey.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(atob(payload)) as { role?: unknown };
      if (claims.role !== "anon") return null;
    } else if (!publishableKey.startsWith("sb_publishable_")) return null;
    return { url: parsed.origin, publishableKey };
  } catch {
    return null;
  }
}

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  try {
    const config = readSupabaseConfig(import.meta.env);
    client = config ? createClient(config.url, config.publishableKey) : null;
  } catch {
    client = null;
  }
  return client;
}

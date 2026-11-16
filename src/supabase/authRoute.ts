/** Explicit preview entry point; the default app stays on its current backend. */
export function showAuthPreview(env: Record<string, unknown>, search: string): boolean {
  return env.VITE_SUPABASE_AUTH_PREVIEW === "true" || new URLSearchParams(search).get("staffAuth") === "1";
}

/** Keep the auth entry point through email callbacks without retaining URL tokens. */
export function authRedirectUrl(location: Pick<Location, "origin" | "pathname">): string {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("staffAuth", "1");
  return url.toString();
}

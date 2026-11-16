import { useEffect, useState } from "react";
import type { Workspace } from "../workspaces/types";
import { getSupabaseClient } from "./client";
import { SupabaseAuthGate } from "./SupabaseAuthGate";
import { listSupabaseWorkspaces } from "./workspaces";
import "./auth.css";

function WorkspacePreview() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) { setLoading(false); setError("The workspace service is not configured."); return; }
    let current = true;
    setLoading(true);
    setError("");
    void listSupabaseWorkspaces(client).then((page) => {
      if (current) { setWorkspaces(page.workspaces); setCursor(page.nextCursor); setError(""); }
    }, () => { if (current) setError("Unable to load workspaces. Check your connection and try again."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [retryVersion]);

  async function loadMore() {
    const client = getSupabaseClient();
    if (!client || !cursor || loading) return;
    setLoading(true);
    setError("");
    try {
      const page = await listSupabaseWorkspaces(client, cursor);
      setWorkspaces((current) => [...current, ...page.workspaces]);
      setCursor(page.nextCursor);
    } catch {
      setError("Unable to load more workspaces. Check your connection and try again.");
    } finally { setLoading(false); }
  }

  async function signOut() {
    const client = getSupabaseClient();
    if (!client || signingOut) return;
    setSigningOut(true);
    try {
      const result = await client.auth.signOut();
      if (result.error) throw result.error;
    } catch {
      setError("Could not sign out. Please try again.");
    } finally { setSigningOut(false); }
  }

  return <main className="auth-page"><section className="auth-card auth-preview">
    <h1>Staff workspace preview</h1>
    <p>Sign-in is complete. This preview shows jobs available in the new workspace.</p>
    <h2>Jobs</h2>
    {error && <p role="alert">{error}</p>}
    {error && !loading && <button className="button" onClick={() => setRetryVersion(value => value + 1)}>Try loading jobs again</button>}
    {loading && <p role="status">Loading jobs…</p>}
    {!loading && !error && workspaces.length === 0 && <p>No jobs are available yet.</p>}
    {workspaces.length > 0 && <ul>{workspaces.map((workspace) => <li key={workspace.id}>
      <strong>{workspace.record.customer?.customerName || "Unnamed customer"}</strong>
      <span>{workspace.record.customer?.jobNumber || "No job number"}</span>
    </li>)}</ul>}
    {cursor && <button className="button" disabled={loading} onClick={() => void loadMore()}>Load more jobs</button>}
    <button className="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
  </section></main>;
}

/** Read-only preview; it never mounts the legacy app or its sync services. */
export function AuthPreview() {
  return <SupabaseAuthGate><WorkspacePreview /></SupabaseAuthGate>;
}

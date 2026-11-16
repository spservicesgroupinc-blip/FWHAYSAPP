import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "./client";
import { AuthForm } from "./AuthForm";
import { authRedirectUrl } from "./authRoute";
import "./auth.css";

type Membership = "checking" | "allowed" | "denied" | "error";
type StaffRole = "admin" | "staff" | "estimator" | "project_manager" | null;

/** Opt-in gate; authorization must also be enforced by server RLS and Storage policies. */
export function SupabaseAuthGate({ children }: { children: ReactNode | ((role: StaffRole) => ReactNode) }) {
  // Capture invitation links before the SDK consumes and clears the URL fragment.
  const initialLinkType = typeof window === "undefined" ? null
    : new URLSearchParams(window.location.hash.slice(1)).get("type") || new URLSearchParams(window.location.search).get("type");

  const client = getSupabaseClient();
  const [session, setSession] = useState<Session | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [passwordSetup, setPasswordSetup] = useState(initialLinkType === "invite" || initialLinkType === "recovery");
  const [membership, setMembership] = useState<Membership>("checking");
  const [staffRole, setStaffRole] = useState<StaffRole>(null);
  const [checkVersion, setCheckVersion] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [resetRequested, setResetRequested] = useState(false);
  const membershipGeneration = useRef(0);

  useEffect(() => {
    if (!client) return;
    const { data } = client.auth.onAuthStateChange((event, nextSession) => {
      // Never reuse a prior account's membership while a new session is checked.
      membershipGeneration.current += 1;
      setMembership("checking");
      setCheckVersion((value) => value + 1);
      if (event === "PASSWORD_RECOVERY") { setResetRequested(false); setPasswordSetup(true); }
      if (event === "SIGNED_OUT") setPasswordSetup(false);
      setSession(nextSession);
      setInitialized(true);
    });
    return () => data.subscription.unsubscribe();
  }, [client]);

  useEffect(() => {
    if (!client || !session || passwordSetup) return;
    let current = true;
    const generation = ++membershipGeneration.current;
    setMembership("checking");
    setStaffRole(null);
    void client.from("staff_members").select("role,active").eq("user_id", session.user.id).maybeSingle()
      .then(({ data, error }) => {
        if (!current || generation !== membershipGeneration.current) return;
        const active = data?.active === true;
        const role = (data?.role ?? null) as StaffRole;
        setStaffRole(role);
        // Every active staff member can use the shared app. The role is
        // informational for UI behavior; it is not an app-wide access gate.
        setMembership(error ? "error" : active && !!role ? "allowed" : "denied");
      }, () => { if (current && generation === membershipGeneration.current) setMembership("error"); });
    return () => { current = false; };
  }, [client, session, passwordSetup, checkVersion]);

  useEffect(() => {
    if (!session) return;
    const refresh = () => {
      membershipGeneration.current += 1;
      setMembership("checking");
      setCheckVersion((value) => value + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (passwordSetup) {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setPassword("");
        setPasswordSetup(false);
      } else if (resetRequested) {
        const redirectTo = authRedirectUrl(window.location);
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (error) throw error;
        setMessage("If this email has an account, a reset link will be sent. Check your inbox.");
      } else {
        const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        setPassword("");
      }
    } catch {
      setMessage(passwordSetup ? "Could not update your password. The link may have expired; request a new one." : resetRequested ? "Could not request a reset link. Please try again." : "Sign-in failed. Check your email and password, then try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!client) return;
    setBusy(true);
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      setMessage(""); setPassword("");
    } catch {
      setMessage("Could not sign out. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!client) return <main className="auth-page"><section className="auth-card"><h1>Workspace unavailable</h1><p>Staff sign-in is not configured. Contact your administrator.</p></section></main>;
  if (!initialized) return <main className="auth-page"><p role="status">Checking your session…</p></main>;
  if (passwordSetup && !session) return <main className="auth-page"><section className="auth-card"><h1>Link unavailable</h1><p>This invitation or reset link may have expired. Contact your administrator or request another password reset.</p><button className="button primary" onClick={() => { setPasswordSetup(false); setResetRequested(true); }}>Request reset link</button></section></main>;
  if (session && !passwordSetup && membership === "allowed") return <>{typeof children === "function" ? children(staffRole) : children}</>;
  if (session && !passwordSetup) return <main className="auth-page"><section className="auth-card">
    <h1>{membership === "checking" ? "Checking access…" : membership === "denied" ? "Access not available" : "Unable to check access"}</h1>
    <p role={membership === "checking" ? "status" : undefined}>{membership === "checking" ? "Please wait." : membership === "denied" ? "Your account is not approved for this workspace. Contact your administrator." : "Check your connection and try again."}</p>
    {message && <p role="alert">{message}</p>}
    {membership === "error" && <button className="button primary" onClick={() => setCheckVersion((value) => value + 1)}>Try again</button>}
    <button className="button" disabled={busy} onClick={() => void signOut()}>Sign out</button>
  </section></main>;

  return <AuthForm passwordSetup={passwordSetup} resetRequested={resetRequested} email={email} password={password} busy={busy} message={message} canSignOut={!!session}
    onEmailChange={setEmail} onPasswordChange={setPassword} onSubmit={(event) => void submit(event)}
    onToggleReset={() => { setResetRequested(!resetRequested); setMessage(""); }} onSignOut={() => void signOut()} />;
}

import type { FormEvent } from "react";

export interface AuthFormProps {
  passwordSetup: boolean;
  resetRequested: boolean;
  email: string;
  password: string;
  busy: boolean;
  message: string;
  canSignOut: boolean;
  onEmailChange(value: string): void;
  onPasswordChange(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onToggleReset(): void;
  onSignOut(): void;
}

export function AuthForm(props: AuthFormProps) {
  const { passwordSetup, resetRequested, email, password, busy, message, canSignOut } = props;
  return <main className="auth-page"><section className="auth-card">
    <h1>{passwordSetup ? "Set your password" : resetRequested ? "Reset your password" : "Staff sign in"}</h1>
    <p>{passwordSetup ? "Choose a password to finish setting up your account." : resetRequested ? "Enter your work email to request a reset link." : "Sign in with your invited staff account."}</p>
    <form onSubmit={props.onSubmit}>
      {!passwordSetup && <label>Email<input type="email" autoComplete="username" required value={email} onChange={(event) => props.onEmailChange(event.target.value)} /></label>}
      {(passwordSetup || !resetRequested) && <label>Password<input type="password" autoComplete={passwordSetup ? "new-password" : "current-password"} minLength={passwordSetup ? 6 : undefined} required value={password} onChange={(event) => props.onPasswordChange(event.target.value)} /></label>}
      {message && <p role="status" className="auth-message">{message}</p>}
      <button className="button primary" disabled={busy} type="submit">{busy ? "Please wait…" : passwordSetup ? "Save password" : resetRequested ? "Send reset link" : "Sign in"}</button>
    </form>
    {!passwordSetup && <button className="text-button" disabled={busy} type="button" onClick={props.onToggleReset}>{resetRequested ? "Back to sign in" : "Forgot password?"}</button>}
    {passwordSetup && canSignOut && <button className="text-button" disabled={busy} type="button" onClick={props.onSignOut}>Sign out</button>}
  </section></main>;
}

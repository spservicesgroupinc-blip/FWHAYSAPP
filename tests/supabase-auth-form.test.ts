import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthForm, type AuthFormProps } from "../src/supabase/AuthForm";

const props: AuthFormProps = { passwordSetup: false, resetRequested: false, email: "", password: "", busy: false, message: "", canSignOut: false, onEmailChange() {}, onPasswordChange() {}, onSubmit() {}, onToggleReset() {}, onSignOut() {} };

test("staff sign-in and reset screens expose labeled controls", () => {
  const signIn = renderToStaticMarkup(createElement(AuthForm, props));
  assert.match(signIn, /<label>Email<input type="email"/);
  assert.match(signIn, /<label>Password<input type="password"/);
  assert.match(signIn, /Forgot password\?/);
  const reset = renderToStaticMarkup(createElement(AuthForm, { ...props, resetRequested: true }));
  assert.match(reset, /Send reset link/);
  assert.doesNotMatch(reset, /type="password"/);
});

test("recovery still displays the password field if a reset was requested in the same tab", () => {
  const recovery = renderToStaticMarkup(createElement(AuthForm, { ...props, passwordSetup: true, resetRequested: true, canSignOut: true }));
  assert.match(recovery, /<label>Password<input type="password"/);
  assert.match(recovery, /autoComplete="new-password"/i);
  assert.match(recovery, /Save password/);
  assert.match(recovery, /Sign out/);
});

test("busy forms prevent navigation and report status", () => {
  const html = renderToStaticMarkup(createElement(AuthForm, { ...props, busy: true, message: "Please retry." }));
  assert.match(html, /role="status"/);
  assert.match(html, /disabled=""[^>]*>Please wait/);
  assert.match(html, /disabled=""[^>]*>Forgot password/);
});

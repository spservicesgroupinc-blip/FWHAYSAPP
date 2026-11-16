import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { lazy, Suspense } from "react";
import { showAuthPreview } from "./supabase/authRoute";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";

// Loading only the selected shell keeps legacy sync modules out of staff preview.
const Shell = showAuthPreview(import.meta.env, window.location.search)
  ? lazy(() => import("./supabase/AuthPreview").then(module => ({ default: module.AuthPreview })))
  : lazy(() => import("./App").then(module => ({ default: module.SupabaseApp })));

// A deploy replaces every hashed file. If a tab is still running an older
// shell, a lazily imported chunk can 404 — reload once to pick up the current
// build instead of leaving the screen stuck.
window.addEventListener("vite:preloadError", () => {
  const recovery = "hays-preload-recovery";
  try {
    if (sessionStorage.getItem(recovery)) return;
    sessionStorage.setItem(recovery, "1");
  } catch {
    return;
  }
  window.location.reload();
});

registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    // Long-lived tabs pick up a new deployment within the hour.
    if (!registration) return;
    window.setInterval(() => void registration.update(), 60 * 60 * 1000);
  },
  onRegisterError(error) {
    console.error("Service worker registration failed.", error);
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<main className="auth-page"><p role="status">Loading workspace…</p></main>}><Shell /></Suspense>
    </ErrorBoundary>
  </StrictMode>,
);

// The app rendered, so the inline boot guard in index.html can arm again.
try {
  sessionStorage.removeItem("hays-boot-recovery");
} catch {
  // Storage is unavailable; nothing to clear.
}

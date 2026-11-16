import { useEffect, useState } from "react";
import { Download, Monitor, Share, Smartphone, WifiOff, X } from "lucide-react";
import "./InstallApp.css";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isStandaloneApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export default function InstallApp() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [offline, setOffline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? !navigator.onLine : false,
  );

  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (isStandaloneApp()) return;

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setPrompt(null);
      setShowIOS(false);
      setGuideOpen(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    let timer: number | undefined;
    if (isIOS()) {
      timer = window.setTimeout(() => setShowIOS(true), 1500);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onOpenInstall = () => {
      if (prompt) {
        void (async () => {
          await prompt.prompt();
          await prompt.userChoice;
          setPrompt(null);
        })();
      } else {
        setGuideOpen(true);
      }
    };
    window.addEventListener("hays:open-install-pwa", onOpenInstall);
    return () => window.removeEventListener("hays:open-install-pwa", onOpenInstall);
  }, [prompt]);

  const install = async () => {
    if (!prompt) {
      setGuideOpen(true);
      return;
    }
    await prompt.prompt();
    await prompt.userChoice;
    setPrompt(null);
  };

  return (
    <>
      {offline && (
        <div className="pwa-offline-banner" role="status" aria-live="polite">
          <WifiOff size={15} />
          <span>
            Offline mode — changes and drafts are saved on this device and will sync when reconnected.
          </span>
        </div>
      )}

      {!dismissed && !isStandaloneApp() && prompt && (
        <div className="install-banner" role="region" aria-label="Install app">
          <div className="install-banner-text">
            <strong>Install Hays + Sons Change Orders</strong>
            <span>
              Add it to your desktop or smartphone home screen for a full-screen, offline-ready app.
            </span>
          </div>
          <div className="install-banner-actions">
            <button
              className="button primary small"
              onClick={() => void install()}
            >
              <Download size={16} />
              Install
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss install prompt"
              onClick={() => setDismissed(true)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {!dismissed && !isStandaloneApp() && !prompt && showIOS && (
        <div
          className="install-banner"
          role="region"
          aria-label="Add to home screen"
        >
          <div className="install-banner-text">
            <strong>Add Change Orders to your home screen</strong>
            <span>Tap the Share button, then choose “Add to Home Screen”.</span>
          </div>
          <div className="install-banner-actions">
            <span className="install-share-hint">
              <Share size={16} />
            </span>
            <button
              className="icon-button"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {guideOpen && (
        <div
          className="install-guide-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-guide-title"
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="install-guide-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="install-guide-head">
              <div>
                <h2 id="install-guide-title">Install Hays + Sons App</h2>
                <p>Run as a standalone app on Desktop or Smartphone with offline support.</p>
              </div>
              <button
                className="icon-button"
                aria-label="Close install guide"
                onClick={() => setGuideOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="install-guide-grid">
              <div className="install-guide-card">
                <div className="install-guide-icon">
                  <Monitor size={18} />
                </div>
                <h3>Desktop (Chrome, Edge, Safari)</h3>
                <ol>
                  <li>Click the <strong>Install</strong> icon in the right side of the browser address bar.</li>
                  <li>Or open the browser menu and select <strong>Install Hays + Sons Change Orders</strong> (or <strong>File → Add to Dock</strong> in Safari).</li>
                </ol>
              </div>
              <div className="install-guide-card">
                <div className="install-guide-icon">
                  <Smartphone size={18} />
                </div>
                <h3>Smartphone (iPhone &amp; Android)</h3>
                <ol>
                  <li><strong>iPhone / iPad (Safari):</strong> Tap the <strong>Share</strong> button, then tap <strong>Add to Home Screen</strong>.</li>
                  <li><strong>Android (Chrome):</strong> Tap the 3-dot browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
                </ol>
              </div>
            </div>
            <div className="install-guide-foot">
              {prompt && (
                <button
                  className="button primary"
                  onClick={() => {
                    setGuideOpen(false);
                    void install();
                  }}
                >
                  <Download size={16} /> Install now
                </button>
              )}
              <button className="button" onClick={() => setGuideOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

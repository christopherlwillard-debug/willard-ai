import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setBaseUrl } from "@workspace/api-client-react";

setBaseUrl((import.meta.env.BASE_URL || "/").replace(/\/+$/, ""));

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const workerUrl = `${import.meta.env.BASE_URL}sw.js`;
  const workerScope = import.meta.env.BASE_URL;
  let hasReloadedForUpdate = false;

  void navigator.serviceWorker.register(workerUrl, { scope: workerScope }).then((registration) => {
    const checkForUpdate = () => void registration.update().catch(() => {
      // A network failure should not interrupt the already-running app.
    });

    checkForUpdate();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          window.dispatchEvent(new Event("willard:pwa-update"));
        }
      });
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // sw.js uses skipWaiting, so a new worker takes control immediately.
      // Reload once in this page to prevent mixing old HTML with new assets.
      if (hasReloadedForUpdate) return;
      hasReloadedForUpdate = true;
      window.location.reload();
    });
  }).catch(() => {
    // The app remains fully usable without the optional offline shell.
  });
}

createRoot(document.getElementById("root")!).render(<App />);

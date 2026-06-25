"use client";

import { useEffect } from "react";
import { App } from "~remiadmin/App";
import "./admin.css";

/**
 * Client island that mounts the real Remi admin (后台) SPA inside the console.
 *
 * The admin is a client-rendered React app with wouter hash-routing and zustand
 * stores — it runs entirely in the browser. We render it under
 * `.remi-admin-root` so its v4 token bridge (admin.css) applies and stays
 * scoped away from the Multiremi board.
 */
export default function RemiAdminApp() {
  // The standalone SPA defaulted to dark via localStorage("remi-theme").
  // Preserve that default here without fighting the console's theme provider.
  useEffect(() => {
    const stored =
      typeof window !== "undefined"
        ? window.localStorage.getItem("remi-theme")
        : null;
    if (stored === "light") {
      document.documentElement.classList.remove("dark");
    } else if (stored === "dark") {
      document.documentElement.classList.add("dark");
    }
  }, []);

  return (
    <div className="remi-admin-root">
      <App />
    </div>
  );
}

"use client";

/**
 * Sun/moon theme switch. The icon shows the theme it switches TO: a moon in
 * light mode ("Switch to dark theme"), a sun in dark mode. Icon and label are
 * picked with CSS from data-theme, so the server markup never depends on
 * client-only state and hydration cannot mismatch.
 */

import { useLayoutEffect } from "react";
import { THEME_STORAGE_KEY, applyTheme, currentTheme, readStoredTheme, saveTheme } from "@/lib/theme";

function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function ThemeToggle({ className = "" }: { className?: string }) {
  useLayoutEffect(() => {
    // Re-apply after React's dev Strict Mode remount resets <html> attributes
    // (a no-op in production, where the inline script already applied it).
    applyTheme(readStoredTheme() ?? systemTheme());

    // Keep other tabs in sync, and follow the OS while no choice is saved.
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) applyTheme(readStoredTheme() ?? systemTheme());
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (!readStoredTheme()) applyTheme(systemTheme());
    };
    window.addEventListener("storage", onStorage);
    media.addEventListener("change", onSystemChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onSystemChange);
    };
  }, []);

  return (
    <button
      type="button"
      id="theme-toggle"
      onClick={() => saveTheme(currentTheme() === "dark" ? "light" : "dark")}
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-canvas hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
    >
      {/* Light mode: moon — offers dark */}
      <svg className="h-[18px] w-[18px] dark:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
      {/* Dark mode: sun — offers light */}
      <svg className="hidden h-[18px] w-[18px] dark:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
        />
      </svg>
      <span className="sr-only dark:hidden">Switch to dark theme</span>
      <span className="sr-only hidden dark:inline">Switch to light theme</span>
    </button>
  );
}

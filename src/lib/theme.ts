/**
 * Light/dark theme persistence.
 *
 * The choice is stored in localStorage and applied as data-theme on <html>.
 * An inline script in the root layout applies it during HTML parsing, before
 * the first paint, so there is no flash and no server/client markup to
 * mismatch (see node_modules/next/dist/docs/01-app/02-guides/
 * preventing-flash-before-hydration.md). Without a saved choice the OS
 * preference is used.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "clearcollect-theme";

/** Runs in <head> before paint. Must stay dependency-free ES5. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null; // storage blocked (private mode, disabled cookies)
  }
}

/** The theme currently applied to the page. */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Still applied for this page view; it just won't persist.
  }
}

import type { ReactNode } from "react";

/** Eye / eye-off outlines (Lucide shapes, inlined: the project has no icon library). */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
          <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
          <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
          <path d="m2 2 20 20" />
        </>
      ) : (
        <>
          <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/**
 * Wraps a password input with a button that shows or hides its value.
 * The wrapped input needs `pr-10` so its text clears the button.
 */
export default function PasswordToggle({ visible, onToggle, controls, children }: { visible: boolean; onToggle: () => void; controls: string; children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={controls}
        title={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-muted transition hover:text-navy focus-visible:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <EyeIcon off={visible} />
      </button>
    </div>
  );
}

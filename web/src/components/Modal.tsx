import { X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Everything the browser would stop at on Tab, for anything that has to keep focus inside itself. */
export const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Dialogs portal into <body> in the order they open, so the last backdrop is the one on top. */
const isTopmost = (dialog: HTMLElement | null) => {
  const backdrops = document.querySelectorAll(".modal-backdrop");
  return dialog !== null && backdrops[backdrops.length - 1]?.contains(dialog) === true;
};

/**
 * Keyboard behaviour shared by every dialog: Escape closes only the topmost one (a Retry dialog
 * opened from the chat used to close both), Tab stays inside it, and focus goes back to whatever
 * opened it.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  // Captured during the first render, before an autoFocus child has taken focus.
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    return () => {
      // Only once the dialog has really left the page (StrictMode re-runs effects on a live node).
      setTimeout(() => {
        if (dialog && !dialog.isConnected && returnTo?.isConnected) returnTo.focus();
      });
    };
  }, [ref, returnTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = ref.current;
      if (!dialog || !isTopmost(dialog)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "Tab") {
        const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return event.preventDefault();
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref, onClose]);
}

export function Modal({
  title,
  onClose,
  children,
  width = 460,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ width }}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export const isModalOpen = () => document.querySelector(".modal-backdrop") !== null;

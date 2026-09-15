import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cls } from "../lib/format";

/** Breathing room kept between the panel and the viewport edge, and between the panel and its trigger. */
const MARGIN = 12;
const GAP = 8;

interface Position {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * A trigger button and a floating panel of arbitrary content. The panel is portalled to <body> so
 * cards and scroll containers can't clip it, flips above the trigger when there is more room there,
 * and closes on outside click, Escape or focus leaving.
 */
export function Popover({
  label,
  trigger,
  triggerLabel,
  triggerClassName,
  className,
  width = 360,
  children,
}: {
  /** Accessible name of the panel. */
  label: string;
  trigger: ReactNode;
  /** Accessible name of the trigger, for icon-only triggers. */
  triggerLabel?: string;
  triggerClassName?: string;
  /** Extra class on the panel. Needed for styles scoped to the view, since the panel is portalled out of it. */
  className?: string;
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const place = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const height = panel.offsetHeight;
    const below = window.innerHeight - anchor.bottom - GAP - MARGIN;
    const above = anchor.top - GAP - MARGIN;
    const flip = height > below && above > below;
    const maxHeight = Math.max(160, flip ? above : below);
    setPosition({
      top: flip ? Math.max(MARGIN, anchor.top - GAP - Math.min(height, maxHeight)) : anchor.bottom + GAP,
      left: Math.min(Math.max(MARGIN, anchor.left), Math.max(MARGIN, window.innerWidth - panel.offsetWidth - MARGIN)),
      maxHeight,
    });
  }, []);

  // Measure before paint so the panel never shows up in the wrong place.
  useLayoutEffect(() => {
    if (!open) return setPosition(null);
    place();
    panelRef.current?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    // Capture, so the panel follows its trigger when any scroll container between them moves.
    const onScroll = () => place();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  // The panel grows and shrinks as its content changes (a test result, a validation notice).
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, place]);

  const onKeyDown = (event: KeyboardEvent) => {
    // Stop here so an open task drawer doesn't close along with the popover.
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onKeyDown={onKeyDown}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={cls("popover", className)}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            style={{
              width: `min(${width}px, calc(100vw - ${MARGIN * 2}px))`,
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              maxHeight: position?.maxHeight,
              visibility: position ? undefined : "hidden",
            }}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              // Tabbing (or clicking) past the last control closes it, the way a menu would.
              const next = event.relatedTarget as Node | null;
              if (next && !panelRef.current?.contains(next) && !triggerRef.current?.contains(next)) setOpen(false);
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

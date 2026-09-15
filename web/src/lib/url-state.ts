import { useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asked before leaving an entry, whether in-app or by back/forward; any returning false stays put. */
const guards = new Set<() => boolean>();

const positionOf = (state: unknown): number =>
  typeof state === "object" && state !== null && "position" in state && typeof state.position === "number"
    ? state.position
    : 0;

/** Every entry we push is numbered, so a refused back/forward knows how far to step back. Survives reloads. */
let position = positionOf(window.history.state);

/** Set while we undo a refused back/forward; that step is a popstate of our own, not one to guard. */
let restoring = false;

window.addEventListener("popstate", (event) => {
  if (restoring) {
    restoring = false;
    return;
  }
  // The browser moves first and asks later, so a refusal steps back onto our entry to match the screen.
  const to = positionOf(event.state);
  if (position !== to && [...guards].some((allow) => !allow())) {
    restoring = true;
    window.history.go(position - to);
    return;
  }
  position = to;
  notify();
});

/** Reads one search param and re-renders when it changes (including back/forward). */
export function useQueryParam(key: string): string | null {
  return useSyncExternalStore(subscribe, () => new URLSearchParams(window.location.search).get(key));
}

/**
 * Updates several search params as one history entry. `null` removes a param. Returns false when
 * an unsaved-changes guard kept the page where it is; `force` skips the guards.
 */
export function setQueryParams(
  changes: Record<string, string | null>,
  options: { replace?: boolean; force?: boolean } = {},
): boolean {
  const before = new URLSearchParams(window.location.search).toString();
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  if (query === before) return true;
  if (!options.force && [...guards].some((allow) => !allow())) return false;

  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (options.replace) window.history.replaceState({ position }, "", url);
  else window.history.pushState({ position: ++position }, "", url);
  notify();
  return true;
}

/**
 * While `message` is set, in-app navigation and back/forward ask before leaving, and the browser
 * warns on reload or close. Everything in the app navigates through `setQueryParams` or history.
 */
export function useUnsavedChangesGuard(message: string | null): void {
  useEffect(() => {
    if (!message) return;
    const guard = () => window.confirm(message);
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    guards.add(guard);
    window.addEventListener("beforeunload", warn);
    return () => {
      guards.delete(guard);
      window.removeEventListener("beforeunload", warn);
    };
  }, [message]);
}

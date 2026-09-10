import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
window.addEventListener("popstate", notify);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads one search param and re-renders when it changes (including back/forward). */
export function useQueryParam(key: string): string | null {
  return useSyncExternalStore(subscribe, () => new URLSearchParams(window.location.search).get(key));
}

/** Updates several search params as one history entry. `null` removes a param. */
export function setQueryParams(changes: Record<string, string | null>, options: { replace?: boolean } = {}): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (options.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  notify();
}

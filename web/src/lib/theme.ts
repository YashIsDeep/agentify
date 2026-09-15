import { useSyncExternalStore } from "react";

/**
 * The app is always pinned to one theme; the OS preference only seeds it on the very first visit,
 * after which the choice is the user's and is remembered. The resolved theme lives on
 * `<html data-theme>`, which every token in styles.css keys off. index.html repeats this rule in an
 * inline script so the theme is on the page before the first paint instead of flashing.
 */
export type ThemePreference = "light" | "dark";

export const THEME_STORAGE_KEY = "wm.theme";

const listeners = new Set<() => void>();
let preference: ThemePreference = readStored();

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be blocked outright; the OS preference still works, it just won't be remembered.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(): void {
  document.documentElement.dataset.theme = preference;
}

/** Starts the app on the stored preference, falling back to the OS on a first visit. */
export function startTheme(): void {
  apply();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Not remembering the choice is better than not honouring it for this session.
  }
  apply();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

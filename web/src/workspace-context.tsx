import type { WorkspaceInfo } from "@wm/shared";
import { createContext, useCallback, useContext } from "react";
import { setQueryParams } from "./lib/url-state";

export interface WorkspaceContextValue {
  current: WorkspaceInfo;
  list: WorkspaceInfo[];
  select: (id: string) => void;
  manage: (action: "create" | "clone" | "rename") => void;
  /** Fetches the workspace list again, after another screen or device changed it. */
  refreshCatalog: () => void;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace provider is missing");
  return context;
}

/** Late mutation callbacks from a workspace we left must not navigate the current workspace. */
export function useWorkspaceNavigation() {
  const { current } = useWorkspace();
  return useCallback((...args: Parameters<typeof setQueryParams>) => {
    const selected = new URLSearchParams(window.location.search).get("workspace") ?? "default";
    return selected === current.id && setQueryParams(...args);
  }, [current.id]);
}

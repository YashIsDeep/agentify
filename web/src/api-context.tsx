import { createContext, useContext } from "react";
import type { WorkspaceApi } from "./api";

export const ApiContext = createContext<WorkspaceApi | null>(null);

export function useApi(): WorkspaceApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("Workspace API provider is missing");
  return api;
}

import type { SessionInfo } from "@wm/shared";
import { createContext, useContext } from "react";

export type Session = Exclude<SessionInfo, { access: "none" }>;

export const SessionContext = createContext<Session | null>(null);

/** Who this browser is: the computer running Agentify, or one of its paired devices. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Session provider is missing");
  return session;
}

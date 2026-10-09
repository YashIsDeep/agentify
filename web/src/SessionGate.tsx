import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { ACCESS_LOST_EVENT, ApiError, sessionApi } from "./api";
import { PairScreen } from "./components/PairScreen";
import { SessionContext } from "./session-context";
import { Button, Splash } from "./ui";

/**
 * Asks the server who this browser is before anything else loads. This computer and paired devices
 * get the app; a device that hasn't paired gets the pairing screen. Whenever a request is turned
 * away (the device was removed, remote access switched off) it asks again.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: sessionApi.get, retry: false, refetchOnWindowFocus: true });

  useEffect(() => {
    const recheck = () => void queryClient.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener(ACCESS_LOST_EVENT, recheck);
    return () => window.removeEventListener(ACCESS_LOST_EVENT, recheck);
  }, [queryClient]);

  // A server that can't be reached keeps the app up (it shows Offline and reconnects); one that says no doesn't.
  const refusal = session.error instanceof ApiError && (session.error.status === 401 || session.error.status === 403) ? session.error : null;
  if (refusal) {
    return (
      <Splash title="Agentify isn't available on this device." action={<Button onClick={() => void session.refetch()}>Try again</Button>}>
        {refusal.message}
      </Splash>
    );
  }
  if (!session.data) {
    if (session.isLoading) return <Splash title="Loading…" />;
    return (
      <Splash title="Could not reach the Agentify server." action={<Button onClick={() => void session.refetch()}>Try again</Button>}>
        {session.error?.message}
      </Splash>
    );
  }
  if (session.data.access === "none") {
    return <PairScreen onPaired={(next) => queryClient.setQueryData(["session"], next)} />;
  }
  return <SessionContext.Provider value={session.data}>{children}</SessionContext.Provider>;
}

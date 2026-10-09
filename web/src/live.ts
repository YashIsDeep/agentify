import { useQueryClient } from "@tanstack/react-query";
import type { RunLogLine, ServerEvent, SettingsScope } from "@wm/shared";
import { useEffect, useRef, useState } from "react";
import { ACCESS_LOST_EVENT } from "./api";
import { useApi } from "./api-context";
import { useWorkspace } from "./workspace-context";

const RETRY_DELAY_MS = 2000;
/** The server pings every 15s; a stream silent for longer than this is treated as dead. */
const STALE_AFTER_MS = 40_000;
/**
 * A tab coming back into view that has heard nothing for this long was frozen in the background
 * (phones do it within seconds) and has missed whatever happened meanwhile.
 */
const MISSED_PINGS_MS = 20_000;

/** The queries behind each settings page; the workspace list belongs to the catalog above this one. */
const SETTINGS_QUERIES: Record<Exclude<SettingsScope, "workspaces">, string[][]> = {
  concurrency: [["concurrency"]],
  "remote-access": [["remote-access"]],
  agents: [["agents"], ["agent-models"]],
  connections: [["connections"]],
  "ticket-draft": [["ticket-draft-settings"]],
};

/**
 * Subscribes to the server's event stream. Structural changes invalidate queries (batched);
 * log lines are appended straight into any cached run log.
 */
export function useLiveUpdates(): boolean {
  const api = useApi();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const { refreshCatalog } = useWorkspace();
  const refreshCatalogRef = useRef(refreshCatalog);
  refreshCatalogRef.current = refreshCatalog;

  useEffect(() => {
    const dirty = { tasks: false, workflows: false, taskIds: new Set<string>(), runIds: new Set<number>() };
    let source: EventSource | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let hasConnected = false;
    let disposed = false;
    let lastHeard = Date.now();

    const flush = () => {
      flushTimer = undefined;
      if (dirty.tasks) void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (dirty.workflows) {
        // The catalogue drives the sidebar's boards and the workflow editor; usage counts follow a deletion.
        void queryClient.invalidateQueries({ queryKey: ["workflows"] });
        void queryClient.invalidateQueries({ queryKey: ["workflow-usage"] });
      }
      for (const taskId of dirty.taskIds) {
        void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        void queryClient.invalidateQueries({ queryKey: ["artifacts", taskId] });
      }
      for (const runId of dirty.runIds) void queryClient.invalidateQueries({ queryKey: ["runLog", runId] });
      dirty.tasks = false;
      dirty.workflows = false;
      dirty.taskIds.clear();
      dirty.runIds.clear();
    };
    const schedule = () => {
      flushTimer ??= setTimeout(flush, 100);
    };

    const reconnect = (delay: number) => {
      source?.close();
      clearTimeout(watchdog);
      setConnected(false);
      if (!disposed) retryTimer = setTimeout(connect, delay);
    };
    // A restarted server can leave the proxied stream half-open: no error, just silence.
    const resetWatchdog = () => {
      lastHeard = Date.now();
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reconnect(0), STALE_AFTER_MS);
    };
    // Coming back to a tab that was frozen, or back online: reconnect now rather than when the watchdog fires.
    const wake = () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (!source || source.readyState === EventSource.CLOSED || Date.now() - lastHeard > MISSED_PINGS_MS) reconnect(0);
    };

    const connect = () => {
      const es = new EventSource(api.eventsUrl);
      source = es;
      const on = <T extends ServerEvent["type"]>(type: T, handle: (event: Extract<ServerEvent, { type: T }>) => void) =>
        es.addEventListener(type, (message) => {
          resetWatchdog();
          handle(JSON.parse((message as MessageEvent<string>).data));
        });

      es.addEventListener("ready", resetWatchdog);
      es.addEventListener("ping", resetWatchdog);
      on("task.changed", ({ taskId }) => {
        dirty.tasks = true;
        dirty.taskIds.add(taskId);
        schedule();
      });
      on("workflow.changed", () => {
        dirty.workflows = true;
        schedule();
      });
      on("timeline.appended", ({ taskId }) => {
        dirty.taskIds.add(taskId);
        schedule();
      });
      on("run.changed", ({ taskId, runId }) => {
        dirty.taskIds.add(taskId);
        dirty.runIds.add(runId);
        schedule();
      });
      on("run.log", ({ runId, line }) => {
        queryClient.setQueryData<RunLogLine[]>(["runLog", runId], (lines) => (lines ? [...lines, line] : lines));
      });
      // Changed on this device or another: whichever settings page is open shows it straight away.
      on("settings.changed", ({ scope }) => {
        if (scope === "workspaces") return refreshCatalogRef.current();
        for (const queryKey of SETTINGS_QUERIES[scope]) void queryClient.invalidateQueries({ queryKey });
      });

      es.onopen = () => {
        setConnected(true);
        resetWatchdog();
        // After a reconnect we may have missed events.
        if (hasConnected) void queryClient.invalidateQueries();
        hasConnected = true;
      };
      es.onerror = () => {
        setConnected(false);
        // Browsers retry dropped streams themselves, but give up for good after an error
        // response (e.g. the dev proxy's 502 while the server restarts) — reconnect ourselves.
        if (es.readyState === EventSource.CLOSED) reconnect(RETRY_DELAY_MS);
        // A paired device's stream also ends when it loses access, which the session check finds out.
        window.dispatchEvent(new Event(ACCESS_LOST_EVENT));
      };
    };

    connect();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      disposed = true;
      source?.close();
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      clearTimeout(watchdog);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [queryClient, api]);

  return connected;
}

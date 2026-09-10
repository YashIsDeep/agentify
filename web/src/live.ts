import { useQueryClient } from "@tanstack/react-query";
import type { RunLogLine, ServerEvent } from "@wm/shared";
import { useEffect, useState } from "react";

const RETRY_DELAY_MS = 2000;
/** The server pings every 15s; a stream silent for longer than this is treated as dead. */
const STALE_AFTER_MS = 40_000;

/**
 * Subscribes to the server's event stream. Structural changes invalidate queries (batched);
 * log lines are appended straight into any cached run log.
 */
export function useLiveUpdates(): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const dirty = { tasks: false, taskIds: new Set<string>(), runIds: new Set<number>() };
    let source: EventSource | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let hasConnected = false;
    let disposed = false;

    const flush = () => {
      flushTimer = undefined;
      if (dirty.tasks) void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      for (const taskId of dirty.taskIds) {
        void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        void queryClient.invalidateQueries({ queryKey: ["artifacts", taskId] });
      }
      for (const runId of dirty.runIds) void queryClient.invalidateQueries({ queryKey: ["runLog", runId] });
      dirty.tasks = false;
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
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reconnect(0), STALE_AFTER_MS);
    };

    const connect = () => {
      const es = new EventSource("/api/events");
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
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      clearTimeout(flushTimer);
      clearTimeout(retryTimer);
      clearTimeout(watchdog);
    };
  }, [queryClient]);

  return connected;
}

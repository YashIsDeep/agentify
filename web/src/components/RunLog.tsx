import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useApi } from "../api-context";
import { cls } from "../lib/format";

export function RunLog({ runId, live, archived = false }: { runId: number; live: boolean; archived?: boolean }) {
  const api = useApi();
  const log = useQuery({ queryKey: ["runLog", runId], queryFn: () => api.runLog(runId), staleTime: 0 });
  const ref = useRef<HTMLPreElement>(null);
  const followTail = useRef(true);
  const lineCount = log.data?.length ?? 0;

  useEffect(() => {
    const element = ref.current;
    if (element && followTail.current) element.scrollTop = element.scrollHeight;
  }, [lineCount]);

  if (log.isLoading) return <div className="log log-empty">Loading output…</div>;
  if (log.error) return <div className="log log-empty">Could not load output: {log.error.message}</div>;

  const lines = log.data ?? [];
  if (lines.length === 0) {
    return (
      <div className="log log-empty">
        {live ? "Waiting for output…" : archived ? "Transcripts are removed when a task is archived." : "No output recorded."}
      </div>
    );
  }

  return (
    <pre
      ref={ref}
      className="log"
      onScroll={(event) => {
        const element = event.currentTarget;
        followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {lines.map((line, index) => (
        <div key={index} className={cls("log-line", `log-${line.stream}`)}>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

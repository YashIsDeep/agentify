import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentStatus, AgentTestResult } from "@wm/shared";
import { Bot, Check, Copy, FlaskConical, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { truncateText, usageSummary } from "../lib/format";
import { ModelSelect } from "./ModelSelect";
import { useToast } from "./Toast";

export function AgentsView() {
  const statuses = useQuery({ queryKey: ["agents"], queryFn: api.agents, staleTime: 60_000 });

  return (
    <div className="page-view">
      <div className="page-header">
        <div>
          <h2>Coding agents</h2>
          <p className="muted">
            Coding-agent actions run these CLIs headlessly. Each one uses its own login; Workflow Manager stores no agent
            credentials and removes <code>ANTHROPIC_API_KEY</code> and <code>OPENAI_API_KEY</code> from their environment so
            your subscriptions are used.
          </p>
        </div>
        <button type="button" className="button" onClick={() => void statuses.refetch()} disabled={statuses.isFetching}>
          <RefreshCw size={14} className={statuses.isFetching ? "spin" : undefined} />
          Re-check
        </button>
      </div>
      {statuses.isLoading && <p className="muted">Checking installed agents…</p>}
      {statuses.error && <p className="error">{statuses.error.message}</p>}
      <div className="agent-grid">
        {statuses.data?.map((status) => (
          <AgentCard key={status.id} status={status} />
        ))}
      </div>
    </div>
  );
}

function readiness(status: AgentStatus): { label: string; tone: "success" | "warn" | "danger" | "muted" } {
  if (!status.installed) return { label: status.error ? "Not found" : "Not installed", tone: "danger" };
  if (status.loggedIn === false) return { label: "Not logged in", tone: "warn" };
  if (status.loggedIn === null) return { label: "Login unknown", tone: "muted" };
  return { label: "Ready", tone: "success" };
}

function AgentCard({ status }: { status: AgentStatus }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [path, setPath] = useState(status.pathOverride ?? "");
  const [model, setModel] = useState("");
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null);

  const savePath = useMutation({
    mutationFn: (value: string | null) => api.setAgentPath(status.id, value),
    onSuccess: (next) => {
      queryClient.setQueryData<AgentStatus[]>(["agents"], (list) => list?.map((item) => (item.id === next.id ? next : item)));
      setPath(next.pathOverride ?? "");
      toast(next.pathOverride ? `${next.label} path saved` : `${next.label} back to auto-detect`);
    },
    onError: (error) => toast(error.message, "error"),
  });
  const test = useMutation({
    mutationFn: () => api.testAgent(status.id, model.trim() || undefined),
    onMutate: () => setTestResult(null),
    onSuccess: setTestResult,
    onError: (error) => setTestResult({ ok: false, text: "", error: error.message, durationMs: 0, usage: null }),
  });

  const ready = readiness(status);
  const pathValue = path.trim() || null;

  return (
    <section className="agent-card">
      <header className="agent-card-header">
        <Bot size={18} />
        <h3>{status.label}</h3>
        <span className={`pill pill-${ready.tone}`}>{ready.label}</span>
      </header>

      <dl className="info">
        <dt>Version</dt>
        <dd>{status.version ?? "—"}</dd>
        <dt>Executable</dt>
        <dd className="mono">{status.path ?? "—"}</dd>
        <dt>Login</dt>
        <dd>{status.authDetail ?? "—"}</dd>
      </dl>

      {status.error && (
        <div className="callout callout-danger">
          <TriangleAlert size={14} />
          {status.error}
        </div>
      )}
      {!status.installed && <CommandHint label="Install" command={status.installCommand} />}
      {status.installed && status.loggedIn === false && (
        <CommandHint label="Log in from a terminal, then re-check" command={status.loginCommand} />
      )}

      <form
        className="agent-row"
        onSubmit={(event) => {
          event.preventDefault();
          savePath.mutate(pathValue);
        }}
      >
        <label className="field field-grow">
          <span>Executable override</span>
          <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="Auto-detect from PATH" />
        </label>
        <button type="submit" className="button" disabled={savePath.isPending || pathValue === status.pathOverride}>
          Save
        </button>
        {status.pathOverride && (
          <button type="button" className="button ghost" onClick={() => savePath.mutate(null)} disabled={savePath.isPending}>
            Reset
          </button>
        )}
      </form>

      <form
        className="agent-row"
        onSubmit={(event) => {
          event.preventDefault();
          test.mutate();
        }}
      >
        <label className="field field-grow">
          <span>Test with model</span>
          <ModelSelect value={model} agent={status.id} onChange={setModel} />
        </label>
        <button type="submit" className="button" disabled={!status.installed || test.isPending}>
          <FlaskConical size={14} />
          {test.isPending ? "Testing…" : "Send test prompt"}
        </button>
      </form>
      {test.isPending && <p className="hint">Sends a one-line, read-only prompt. This can take up to a minute.</p>}
      {testResult &&
        (testResult.ok ? (
          <div className="callout callout-success">
            <Check size={14} />
            <span>
              Replied “{truncateText(testResult.text, 80)}” in {(testResult.durationMs / 1000).toFixed(1)}s
              {testResult.usage && usageSummary(testResult.usage) ? ` · ${usageSummary(testResult.usage)}` : ""}
            </span>
          </div>
        ) : (
          <div className="callout callout-danger">
            <TriangleAlert size={14} />
            <span>{testResult.error}</span>
          </div>
        ))}
    </section>
  );
}

function CommandHint({ label, command }: { label: string; command: string }) {
  const toast = useToast();
  return (
    <div className="command-hint">
      <span className="label">{label}</span>
      <div className="command">
        <code>{command}</code>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy command"
          onClick={() => navigator.clipboard.writeText(command).then(() => toast("Copied"), () => toast("Could not copy", "error"))}
        >
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

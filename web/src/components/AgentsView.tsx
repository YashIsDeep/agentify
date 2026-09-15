import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentId, AgentStatus, AgentTestResult } from "@wm/shared";
import { Bot, Check, ChevronDown, Copy, FlaskConical, RefreshCw, Sparkles, Terminal, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { AGENTS } from "../lib/agents";
import { truncateText, usageSummary } from "../lib/format";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "./ModelSelect";
import { Popover } from "./Popover";
import { useToast } from "./Toast";

export function AgentsView() {
  const api = useApi();
  const statuses = useQuery({ queryKey: ["agents"], queryFn: api.agents, staleTime: 60_000 });

  return (
    <div className="page-view agents-view">
      <div className="page-header">
        <h2>Coding agents</h2>
        <button type="button" className="button" onClick={() => void statuses.refetch()} disabled={statuses.isFetching}>
          <RefreshCw size={14} className={statuses.isFetching ? "spin" : undefined} />
          Refresh status
        </button>
      </div>
      {statuses.isLoading && <p className="muted" role="status">Checking installed agents…</p>}
      {statuses.error && <p className="error">{statuses.error.message}</p>}
      <div className="agent-grid">
        {statuses.isLoading && AGENTS.map((agent) => (
          <div key={agent.id} className="agent-card agent-placeholder" aria-hidden="true"><span className="agent-placeholder-title" /><span /><span /></div>
        ))}
        {statuses.data?.map((status) => (
          <AgentCard key={status.id} status={status} />
        ))}
      </div>
      <TicketDraftCard />
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
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const models = useAgentModels();
  const [path, setPath] = useState(status.pathOverride ?? "");
  const [defaultModel, setDefaultModel] = useState(status.defaultModel ?? "");
  const [defaultEffort, setDefaultEffort] = useState(status.defaultEffort ?? "");
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null);

  const replaceStatus = (next: AgentStatus) =>
    queryClient.setQueryData<AgentStatus[]>(["agents"], (list) => list?.map((item) => (item.id === next.id ? next : item)));

  const savePath = useMutation({
    mutationFn: (value: string | null) => api.setAgentPath(status.id, value),
    onSuccess: (next) => {
      replaceStatus(next);
      setPath(next.pathOverride ?? "");
      toast(next.pathOverride ? `${next.label} path saved` : `${next.label} back to auto-detect`);
    },
    onError: (error) => toast(error.message, "error"),
  });
  const saveDefaults = useMutation({
    mutationFn: () => api.setAgentDefaults(status.id, { model: defaultModel || null, effort: defaultEffort || null }),
    onSuccess: (next) => {
      replaceStatus(next);
      setDefaultModel(next.defaultModel ?? "");
      setDefaultEffort(next.defaultEffort ?? "");
      toast(`${next.label} defaults saved`);
    },
    onError: (error) => toast(error.message, "error"),
  });
  const test = useMutation({
    mutationFn: () => api.testAgent(status.id),
    onMutate: () => setTestResult(null),
    onSuccess: setTestResult,
    onError: (error) => setTestResult({ ok: false, text: "", error: error.message, durationMs: 0, usage: null }),
  });

  const ready = readiness(status);
  const pathValue = path.trim() || null;
  const defaultsUnchanged = defaultModel === (status.defaultModel ?? "") && defaultEffort === (status.defaultEffort ?? "");

  return (
    <section className="agent-card" aria-label={status.label}>
      <header className="agent-card-header">
        <span className="agent-avatar" data-brand={status.id}>
          {hasBrandIcon(status.id) ? <BrandIcon brand={status.id} size={20} /> : <Bot size={20} />}
        </span>
        <div className="agent-identity"><h3>{status.label}</h3></div>
        <span className={`pill pill-${ready.tone}`}>{ready.label}</span>
      </header>

      <form
        className="agent-defaults"
        onSubmit={(event) => {
          event.preventDefault();
          saveDefaults.mutate();
        }}
      >
        <label className="field field-grow">
          <span>Default model</span>
          <ModelSelect
            value={defaultModel}
            agent={status.id}
            onChange={(value) => {
              setDefaultModel(value);
              setDefaultEffort(keepEffort(models.data, status.id, value, defaultEffort));
            }}
          />
        </label>
        <label className="field field-narrow">
          <span>Default effort</span>
          <EffortSelect value={defaultEffort} agent={status.id} model={defaultModel} onChange={setDefaultEffort} />
        </label>
        <div className="agent-defaults-footer">
          <button
            type="button"
            className="button small"
            disabled={!status.installed || test.isPending}
            title="Send a short, read-only prompt using saved defaults"
            onClick={() => test.mutate()}
          >
            <FlaskConical size={14} />
            {test.isPending ? "Testing…" : "Test agent"}
          </button>
          <button type="submit" className={`button small ${defaultsUnchanged ? "ghost" : "primary"}`} disabled={saveDefaults.isPending || defaultsUnchanged}>
            {saveDefaults.isPending ? "Saving…" : "Save defaults"}
          </button>
        </div>
        {/* Tests run with saved defaults, so only show this reminder when the form differs. */}
        {!defaultsUnchanged && <p className="hint agent-defaults-notice" role="status">Unsaved changes. Save before testing this model.</p>}
      </form>
      {test.isPending && <p className="hint" role="status">Waiting for a reply. This can take up to a minute.</p>}
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
      <div className="agent-setup">
        <Popover
          label={`${status.label} connection & setup`}
          triggerClassName="agent-setup-trigger"
          className="agent-setup-popover"
          width={400}
          trigger={<><Terminal size={14} /><span>Connection & setup</span><ChevronDown size={14} /></>}
        >
          <div className="agent-setup-body">
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
              <CommandHint label="Log in from a terminal, then refresh status" command={status.loginCommand} />
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
                {savePath.isPending ? "Saving…" : "Save path"}
              </button>
              {status.pathOverride && (
                <button type="button" className="button ghost" onClick={() => savePath.mutate(null)} disabled={savePath.isPending}>
                  Reset
                </button>
              )}
            </form>
          </div>
        </Popover>
      </div>
    </section>
  );
}

/** Which agent turns a new task's linked ticket into its title and description. */
function TicketDraftCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const models = useAgentModels();
  const saved = useQuery({ queryKey: ["ticket-draft-settings"], queryFn: api.ticketDraftSettings });
  const [edit, setEdit] = useState<{ agent: string; model: string; effort: string } | null>(null);
  const value = edit ?? { agent: saved.data?.agent ?? "", model: saved.data?.model ?? "", effort: saved.data?.effort ?? "" };
  const agent = value.agent || null;

  const save = useMutation({
    mutationFn: () =>
      api.saveTicketDraftSettings({ agent: agent as AgentId | null, model: value.model || null, effort: value.effort || null }),
    onSuccess: (next) => {
      queryClient.setQueryData(["ticket-draft-settings"], next);
      setEdit(null);
      toast("Ticket drafting saved");
    },
    onError: (error) => toast(error.message, "error"),
  });

  return (
    <section className="agent-card ticket-draft-card">
      <header className="agent-card-header">
        <span className="agent-avatar"><Sparkles size={20} /></span>
        <div className="agent-identity"><h3>Ticket drafting</h3></div>
      </header>
      <p className="hint">
        Draft task titles and descriptions from Jira or Linear tickets.
      </p>
      {saved.error && <p className="error small" role="alert">Could not load ticket drafting settings: {saved.error.message}</p>}
      <form
        className="ticket-draft-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label className="field">
          <span>Agent</span>
          <select
            value={value.agent}
            disabled={!saved.data}
            onChange={(event) => setEdit({ agent: event.target.value, model: "", effort: "" })}
          >
            <option value="">None — copy the ticket</option>
            {AGENTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-grow">
          <span>Model</span>
          <ModelSelect
            value={value.model}
            agent={agent}
            disabled={!agent || !saved.data}
            onChange={(model) => setEdit({ ...value, model, effort: keepEffort(models.data, agent, model, value.effort) })}
          />
        </label>
        <label className="field field-narrow">
          <span>Effort</span>
          <EffortSelect
            value={value.effort}
            agent={agent}
            model={value.model}
            disabled={!agent || !saved.data}
            onChange={(effort) => setEdit({ ...value, effort })}
          />
        </label>
        <button type="submit" className="button" disabled={save.isPending || !edit || !saved.data}>
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </form>
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentId, AgentStatus, AgentTestResult } from "@wm/shared";
import { Bot, Copy, FlaskConical, RefreshCw, Sparkles, Terminal } from "lucide-react";
import { useState } from "react";
import { useApi } from "../api-context";
import { AGENTS } from "../lib/agents";
import { truncateText, usageSummary } from "../lib/format";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardGrid,
  CardHeader,
  DetailList,
  Disclosure,
  Field,
  FieldRow,
  IconButton,
  Page,
  type Tone,
  useToast,
} from "../ui";
import { BrandIcon, hasBrandIcon } from "./BrandIcon";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "./ModelSelect";

export function AgentsView() {
  const api = useApi();
  const statuses = useQuery({ queryKey: ["agents"], queryFn: api.agents, staleTime: 60_000 });

  return (
    <Page
      title="Agents"
      narrow
      actions={
        <Button icon={RefreshCw} loading={statuses.isFetching} onClick={() => void statuses.refetch()}>
          Refresh status
        </Button>
      }
    >
      {statuses.error && <Callout tone="danger">{statuses.error.message}</Callout>}
      <CardGrid>
        {statuses.isLoading &&
          AGENTS.map((agent) => (
            <Card key={agent.id} as="div" className="agent-placeholder" aria-hidden="true">
              <span className="agent-placeholder-title" />
              <span />
              <span />
            </Card>
          ))}
        {statuses.data?.map((status) => (
          <AgentCard key={status.id} status={status} />
        ))}
      </CardGrid>
      <TicketDraftCard />
    </Page>
  );
}

function readiness(status: AgentStatus): { label: string; tone: Tone } {
  if (!status.installed) return { label: status.error ? "Not found" : "Not installed", tone: "danger" };
  if (status.loggedIn === false) return { label: "Not logged in", tone: "warn" };
  if (status.loggedIn === null) return { label: "Login unknown", tone: "neutral" };
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
    <Card label={status.label}>
      <CardHeader
        brand={status.id}
        icon={hasBrandIcon(status.id) ? <BrandIcon brand={status.id} size={20} /> : <Bot size={20} />}
        title={status.label}
        aside={<Badge tone={ready.tone}>{ready.label}</Badge>}
      />

      <form
        className="agent-defaults"
        onSubmit={(event) => {
          event.preventDefault();
          saveDefaults.mutate();
        }}
      >
        <FieldRow>
          <Field label="Default model" grow>
            <ModelSelect
              value={defaultModel}
              agent={status.id}
              onChange={(value) => {
                setDefaultModel(value);
                setDefaultEffort(keepEffort(models.data, status.id, value, defaultEffort));
              }}
            />
          </Field>
          <Field label="Default effort">
            <EffortSelect value={defaultEffort} agent={status.id} model={defaultModel} onChange={setDefaultEffort} />
          </Field>
        </FieldRow>
        <div className="agent-defaults-footer">
          <Button
            size="sm"
            icon={FlaskConical}
            disabled={!status.installed}
            loading={test.isPending}
            loadingText="Testing…"
            title={defaultsUnchanged ? "Send a short, read-only prompt with these defaults" : "Tests the saved defaults. Save first to test this choice."}
            onClick={() => test.mutate()}
          >
            Test agent
          </Button>
          <Button
            type="submit"
            size="sm"
            variant={defaultsUnchanged ? "ghost" : "primary"}
            disabled={defaultsUnchanged}
            loading={saveDefaults.isPending}
            loadingText="Saving…"
          >
            Save defaults
          </Button>
        </div>
      </form>
      {testResult &&
        (testResult.ok ? (
          <Callout tone="success">
            Replied “{truncateText(testResult.text, 80)}” in {(testResult.durationMs / 1000).toFixed(1)}s
            {testResult.usage && usageSummary(testResult.usage) ? ` · ${usageSummary(testResult.usage)}` : ""}
          </Callout>
        ) : (
          <Callout tone="danger">{testResult.error}</Callout>
        ))}
      {/* What stops the agent working goes on the card itself, not behind the setup fold. */}
      {!status.installed && <CommandHint label="Install" command={status.installCommand} />}
      {status.installed && status.loggedIn === false && (
        <CommandHint label="Log in from a terminal, then refresh status" command={status.loginCommand} />
      )}
      <Disclosure className="agent-setup" summary="Setup" icon={<Terminal size={14} aria-hidden="true" />} defaultOpen={!!status.error}>
        <DetailList
          items={[
            ["Version", status.version],
            ["Executable", status.path && <span className="mono">{status.path}</span>],
            ["Login", status.authDetail],
          ]}
        />
        {status.error && <Callout tone="danger">{status.error}</Callout>}
        <form
          className="agent-row"
          onSubmit={(event) => {
            event.preventDefault();
            savePath.mutate(pathValue);
          }}
        >
          <Field label="Executable override" optional grow>
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="Auto-detect from PATH" />
          </Field>
          <Button type="submit" disabled={pathValue === status.pathOverride} loading={savePath.isPending} loadingText="Saving…">
            Save path
          </Button>
          {status.pathOverride && (
            <Button variant="ghost" onClick={() => savePath.mutate(null)} disabled={savePath.isPending}>
              Reset
            </Button>
          )}
        </form>
      </Disclosure>
    </Card>
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
    <Card>
      <CardHeader
        icon={<Sparkles size={20} />}
        title="Ticket drafting"
        tip="When a new task gets a Jira or Linear link, this agent drafts its title and description from the ticket."
      />
      {saved.error && <Callout tone="danger">Could not load ticket drafting settings: {saved.error.message}</Callout>}
      <form
        className="ticket-draft-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FieldRow>
          <Field label="Agent">
            <select value={value.agent} disabled={!saved.data} onChange={(event) => setEdit({ agent: event.target.value, model: "", effort: "" })}>
              <option value="">None — copy the ticket</option>
              {AGENTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" grow>
            <ModelSelect
              value={value.model}
              agent={agent}
              disabled={!agent || !saved.data}
              onChange={(model) => setEdit({ ...value, model, effort: keepEffort(models.data, agent, model, value.effort) })}
            />
          </Field>
          <Field label="Effort">
            <EffortSelect
              value={value.effort}
              agent={agent}
              model={value.model}
              disabled={!agent || !saved.data}
              onChange={(effort) => setEdit({ ...value, effort })}
            />
          </Field>
        </FieldRow>
        <Button type="submit" variant={edit ? "primary" : "secondary"} disabled={!edit || !saved.data} loading={save.isPending} loadingText="Saving…">
          Save settings
        </Button>
      </form>
    </Card>
  );
}

/** A shell command to run yourself, with a copy button. */
function CommandHint({ label, command }: { label: string; command: string }) {
  const toast = useToast();
  return (
    <Field label={label} group>
      <div className="command">
        <code>{command}</code>
        <IconButton
          label="Copy command"
          icon={Copy}
          size="sm"
          onClick={() => navigator.clipboard.writeText(command).then(() => toast("Copied"), () => toast("Could not copy", "error"))}
        />
      </div>
    </Field>
  );
}

import type { ActionField, ActionTypeInfo, AgentId, ConnectionInfo, StageAgentDefaults } from "@wm/shared";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { AGENTS, agentLabel } from "../../lib/agents";
import { replaceAt, type DraftStage } from "../../lib/draft";
import { Button, Checkbox, Field, FieldRow, IconButton } from "../../ui";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "../ModelSelect";

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** Agent, model and effort make one choice together, so they share a row and one explanation. */
const AGENT_CHOICE = new Set<ActionField["kind"]>(["agent", "model", "effort"]);

/** Whether any of the action's advanced fields holds something other than its default. */
export const advancedCustomised = (action: ActionTypeInfo, config: Record<string, unknown>) =>
  action.fields.some(
    (field) => field.advanced && JSON.stringify(config[field.name] ?? null) !== JSON.stringify(field.default ?? null),
  );

/**
 * A field can hang off another (an approval's instructions off "Wait for my approval", the CI
 * commands off the CI loop): otherwise it is noise, and its value is kept for when it shows again.
 */
export function isShown(action: ActionTypeInfo, field: ActionField, config: Record<string, unknown>): boolean {
  if (!field.shownWhen) return true;
  const { field: name, in: values } = field.shownWhen;
  return values.includes(config[name] ?? action.fields.find((other) => other.name === name)?.default);
}

/**
 * Renders an action's config form from the field metadata the server publishes: either its main
 * fields, or (`advanced`) the ones it marks as rarely changed.
 */
export function ConfigFields({
  action,
  config,
  stages,
  connections,
  stageAgent,
  stageDefaults,
  advanced = false,
  onChange,
}: {
  action: ActionTypeInfo;
  config: Record<string, unknown>;
  stages: DraftStage[];
  connections: ConnectionInfo[];
  /** The agent this action's stage supplies when its own is left blank. */
  stageAgent: AgentId | null;
  /** The stage's model and effort, which apply while this action runs the stage's agent. */
  stageDefaults?: StageAgentDefaults;
  advanced?: boolean;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const models = useAgentModels();
  // With no agent here or on the stage, it's only settled at run time, so lists cover every agent.
  const agentOf = (values: Record<string, unknown>) => stringOrNull(values.agent) || stageAgent;
  const set = (name: string, value: unknown) => {
    const next = { ...config, [name]: value };
    // An effort belongs to its model: drop it when the new agent or model doesn't offer it.
    if ((name === "agent" || name === "model") && typeof next.effort === "string") {
      next.effort = keepEffort(models.data, agentOf(next), stringOrNull(next.model), next.effort);
    }
    onChange(next);
  };
  // Blank here defers to the stage, by the same rules as resolveAgentChoice: its model only for its
  // own agent, and its effort only while this action doesn't pick a model of its own.
  const stageApplies = !!stageDefaults?.agent && agentOf(config) === stageDefaults.agent;
  const stageModel = stageApplies ? stageDefaults.model : null;
  const stageEffort = stageApplies && !stringOrNull(config.model) ? stageDefaults.effort : null;
  // Only connections this action can actually authenticate with.
  const usable = connections.filter((connection) => connection.type === action.connectionType);

  const shown = action.fields.filter((field) => !!field.advanced === advanced && isShown(action, field, config));
  const choice = shown.filter((field) => AGENT_CHOICE.has(field.kind));
  const render = (field: ActionField, note?: string) => (
    <ConfigField
      key={field.name}
      note={note}
      field={field}
      value={config[field.name]}
      stages={stages}
      connections={usable}
      // The model list depends on the agent chosen in this same form, the effort list on both.
      agent={agentOf(config)}
      stageAgent={stageAgent}
      model={stringOrNull(config.model)}
      modelBlank={stageModel ? `Stage default (${stageModel})` : "Default"}
      effortBlank={stageEffort ? `Stage default (${stageEffort})` : "Default"}
      onChange={(value) => set(field.name, value)}
    />
  );

  return (
    <>
      {shown.map((field) => {
        if (!AGENT_CHOICE.has(field.kind)) return render(field);
        if (field !== choice[0]) return null;
        return (
          <FieldRow key="agent-choice">
            {choice.map((item, index) =>
              render(item, index === 0 ? "Blank ones fall back to the stage's defaults, then the agent's own on the Agents page. A task or a retry can override them." : undefined),
            )}
          </FieldRow>
        );
      })}
    </>
  );
}

/** One field of an action's config, drawn from its metadata. */
function ConfigField({
  field,
  note,
  value,
  stages,
  connections,
  agent,
  stageAgent,
  model,
  modelBlank = "Default",
  effortBlank = "Default",
  onChange,
}: {
  field: ActionField;
  /** Extra explanation for the label's tip, beyond the field's own help. */
  note?: string;
  value: unknown;
  stages: DraftStage[];
  connections: ConnectionInfo[];
  agent: string | null;
  stageAgent: AgentId | null;
  model: string | null;
  /** What a blank model or effort means here, e.g. "Stage default (sonnet)". */
  modelBlank?: string;
  effortBlank?: string;
  onChange: (value: unknown) => void;
}) {
  const tip = (field.help || field.templated || note) && (
    <>
      {field.help && <p>{field.help}</p>}
      {note && <p>{note}</p>}
      {field.templated && (
        <p>
          Supports <code>{"{{task.title}}"}</code>, <code>{'{{artifacts["notes.md"]}}'}</code> and{" "}
          <code>{"{{outputs.key.field}}"}</code>.
        </p>
      )}
    </>
  );
  const text = (next: string) => onChange(next);

  switch (field.kind) {
    case "boolean":
      return <Checkbox checked={value === true} onChange={onChange} label={field.label} tip={tip || undefined} />;
    case "key-value":
      return (
        <Field label={field.label} tip={tip} group>
          <KeyValueRows
            value={(value ?? {}) as Record<string, string>}
            keyLabel={field.keyLabel ?? "Key"}
            valueLabel={field.valueLabel ?? "Value"}
            onChange={onChange}
          />
        </Field>
      );
    case "model":
      return (
        <Field label={field.label} tip={tip} grow>
          <ModelSelect value={String(value ?? "")} agent={agent} blankLabel={modelBlank} onChange={text} />
        </Field>
      );
    case "effort":
      return (
        <Field label={field.label} tip={tip}>
          <EffortSelect value={String(value ?? "")} agent={agent} model={model} blankLabel={effortBlank} onChange={text} />
        </Field>
      );
    case "connection":
      return (
        <Field
          label={field.label}
          tip={tip}
          error={connections.length === 0 ? "No connection of this kind yet. Add one on the Connections page." : undefined}
        >
          <select value={String(value ?? "")} onChange={(event) => text(event.target.value)}>
            <option value="">Choose a connection…</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </Field>
      );
    case "textarea":
      return (
        <Field label={field.label} tip={tip}>
          {/* Templated text is a prompt or a message; anything else is a short list. */}
          <textarea value={String(value ?? "")} rows={field.templated ? 7 : 3} placeholder={field.placeholder} onChange={(event) => text(event.target.value)} />
        </Field>
      );
    case "number":
      return (
        <Field label={field.label} tip={tip}>
          <input
            type="number"
            min={1}
            value={typeof value === "number" ? value : ""}
            placeholder={field.placeholder}
            // Blank means "unset", which the schemas treat as no limit.
            onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
          />
        </Field>
      );
    case "select":
      return (
        <Field label={field.label} tip={tip}>
          <select value={String(value ?? "")} onChange={(event) => text(event.target.value)}>
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case "agent":
      return (
        <Field label={field.label} tip={tip}>
          <select value={String(value ?? "")} onChange={(event) => text(event.target.value)}>
            <option value="">Stage default ({agentLabel(stageAgent ?? "claude")})</option>
            {AGENTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case "stage":
      return (
        <Field label={field.label} tip={tip}>
          <select value={String(value ?? (field.noneLabel === undefined ? "next" : ""))} onChange={(event) => text(event.target.value)}>
            {field.noneLabel === undefined ? <option value="next">The next stage</option> : <option value="">{field.noneLabel}</option>}
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </Field>
      );
    default:
      return (
        <Field label={field.label} tip={tip}>
          <input value={String(value ?? "")} placeholder={field.placeholder} onChange={(event) => text(event.target.value)} />
        </Field>
      );
  }
}

/**
 * Rows are held locally so a half-typed row (no key yet) survives editing; only named rows
 * reach the config. Seeded once — the parent keys this subtree per binding.
 */
function KeyValueRows({
  value,
  keyLabel,
  valueLabel,
  onChange,
}: {
  value: Record<string, string>;
  keyLabel: string;
  valueLabel: string;
  onChange: (value: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));
  const commit = (next: [string, string][]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([key]) => key.trim())));
  };

  return (
    <div className="kv-rows">
      {rows.map(([key, item], index) => (
        <div className="kv-row" key={index}>
          <input
            value={key}
            aria-label={keyLabel}
            placeholder={keyLabel}
            onChange={(event) => commit(replaceAt(rows, index, [event.target.value, item]))}
          />
          <input
            value={item}
            aria-label={valueLabel}
            placeholder={valueLabel}
            onChange={(event) => commit(replaceAt(rows, index, [key, event.target.value]))}
          />
          <IconButton label={`Remove ${key || keyLabel}`} icon={X} onClick={() => commit(rows.filter((_row, i) => i !== index))} />
        </div>
      ))}
      <Button variant="link" icon={Plus} onClick={() => setRows([...rows, ["", ""]])}>
        Add
      </Button>
    </div>
  );
}

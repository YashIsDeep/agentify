import type { ActionField, ActionTypeInfo, AgentId, ConnectionInfo } from "@wm/shared";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { AGENTS, agentLabel } from "../../lib/agents";
import { replaceAt, type DraftStage } from "../../lib/draft";
import { EffortSelect, keepEffort, ModelSelect, useAgentModels } from "../ModelSelect";

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** Renders an action's config form from the field metadata the server publishes. */
export function ConfigFields({
  action,
  config,
  stages,
  connections,
  stageAgent,
  onChange,
}: {
  action: ActionTypeInfo;
  config: Record<string, unknown>;
  stages: DraftStage[];
  connections: ConnectionInfo[];
  /** The agent this action's stage supplies when its own is left blank. */
  stageAgent: AgentId | null;
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
  // Only connections this action can actually authenticate with.
  const usable = connections.filter((connection) => connection.type === action.connectionType);

  return (
    <>
      {action.fields
        // A field can hang off a switch (an approval's instructions off "Wait for my approval"):
        // with the switch off it is noise, and its value is kept for when it goes back on.
        .filter((field) => !field.dependsOn || config[field.dependsOn] === true)
        .map((field) => (
          <Field
            key={field.name}
            field={field}
            value={config[field.name]}
            stages={stages}
            connections={usable}
            // The model list depends on the agent chosen in this same form, the effort list on both.
            agent={agentOf(config)}
            stageAgent={stageAgent}
            model={stringOrNull(config.model)}
            onChange={(value) => set(field.name, value)}
          />
        ))}
    </>
  );
}

function Field({
  field,
  value,
  stages,
  connections,
  agent,
  stageAgent,
  model,
  onChange,
}: {
  field: ActionField;
  value: unknown;
  stages: DraftStage[];
  connections: ConnectionInfo[];
  agent: string | null;
  stageAgent: AgentId | null;
  model: string | null;
  onChange: (value: unknown) => void;
}) {
  const help = (
    <>
      {field.help && <span className="hint">{field.help}</span>}
      {field.templated && (
        <span className="hint">
          Supports <code>{"{{task.title}}"}</code>, <code>{'{{artifacts["requirements.md"]}}'}</code>,{" "}
          <code>{"{{outputs.someAction.field}}"}</code>.
        </span>
      )}
    </>
  );

  if (field.kind === "boolean") {
    return (
      <label className="field field-check">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
        {help}
      </label>
    );
  }

  if (field.kind === "model") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <ModelSelect value={String(value ?? "")} agent={agent} blankLabel="Default" onChange={onChange} />
        {help}
      </label>
    );
  }

  if (field.kind === "effort") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <EffortSelect value={String(value ?? "")} agent={agent} model={model} blankLabel="Default" onChange={onChange} />
        {help}
      </label>
    );
  }

  if (field.kind === "connection") {
    return (
      <label className="field">
        <span>{field.label}</span>
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose a connection…</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </select>
        {connections.length === 0 ? (
          <span className="hint error">Add one on the Connections tab, then come back and enable this action.</span>
        ) : (
          help
        )}
      </label>
    );
  }

  if (field.kind === "key-value") {
    return (
      <div className="field">
        <span>{field.label}</span>
        <KeyValueRows
          value={(value ?? {}) as Record<string, string>}
          keyLabel={field.keyLabel ?? "Key"}
          valueLabel={field.valueLabel ?? "Value"}
          onChange={onChange}
        />
        {help}
      </div>
    );
  }

  return (
    <label className="field">
      <span>{field.label}</span>
      {field.kind === "textarea" ? (
        <textarea value={String(value ?? "")} rows={8} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
      ) : field.kind === "number" ? (
        <input
          type="number"
          min={1}
          value={typeof value === "number" ? value : ""}
          placeholder={field.placeholder}
          // Blank means "unset", which the schemas treat as no limit.
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        />
      ) : field.kind === "select" ? (
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === "agent" ? (
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          <option value="">Stage default ({agentLabel(stageAgent ?? "claude")})</option>
          {AGENTS.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>
      ) : field.kind === "stage" ? (
        <select value={String(value ?? (field.noneLabel === undefined ? "next" : ""))} onChange={(event) => onChange(event.target.value)}>
          {field.noneLabel === undefined ? <option value="next">The next stage</option> : <option value="">{field.noneLabel}</option>}
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      ) : (
        <input value={String(value ?? "")} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
      )}
      {help}
    </label>
  );
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
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${key || keyLabel}`}
            onClick={() => commit(rows.filter((_row, i) => i !== index))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="button small ghost" onClick={() => setRows([...rows, ["", ""]])}>
        <Plus size={13} />
        Add
      </button>
    </div>
  );
}

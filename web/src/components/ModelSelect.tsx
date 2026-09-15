import { useQuery } from "@tanstack/react-query";
import { type AgentModelList, effortsFor } from "@wm/shared";
import { useApi } from "../api-context";

/** The models each agent accepts, sourced from the CLIs themselves where they can say. */
export function useAgentModels() {
  const api = useApi();
  return useQuery({ queryKey: ["agent-models"], queryFn: api.agentModels, staleTime: Infinity });
}

export const modelsFor = (lists: AgentModelList[] | undefined, agent: string | null | undefined): string[] => {
  if (!lists) return [];
  if (agent) return lists.find((list) => list.agent === agent)?.models ?? [];
  // No agent pinned down (a task-level override): anything any agent accepts will do.
  return [...new Set(lists.flatMap((list) => list.models))];
};

/**
 * A dropdown rather than a free-text box: a mistyped model used to sit in a workflow until the
 * agent ran and the CLI rejected it. A value that isn't on the list is still offered — so an
 * existing one is never silently rewritten — but it is called out as unrecognised.
 */
export function ModelSelect({
  value,
  agent,
  blankLabel = "CLI default",
  disabled,
  onChange,
}: {
  value: string;
  agent: string | null | undefined;
  blankLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const models = useAgentModels();
  const options = modelsFor(models.data, agent);
  const unrecognised = value.trim() !== "" && !options.includes(value);

  return (
    <>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">{blankLabel}</option>
        {options.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        {unrecognised && <option value={value}>{value} — not recognised</option>}
      </select>
      {unrecognised && (
        <span className="hint error">
          {agent ? `No such model for this agent.` : "No installed agent offers this model."} Pick one from the list.
        </span>
      )}
      {models.isError && <span className="hint error">Could not load the model list: {models.error.message}</span>}
    </>
  );
}

/** Effort levels to offer. With no agent pinned down (a task override), whatever any agent offers for the model. */
export const effortOptions = (
  lists: AgentModelList[] | undefined,
  agent: string | null | undefined,
  model: string | null | undefined,
): string[] => {
  if (!lists) return [];
  if (agent) return effortsFor(lists.find((list) => list.agent === agent), model);
  const wanted = (model ?? "").trim();
  const candidates = lists.filter((list) => !wanted || list.models.includes(wanted));
  return [...new Set(candidates.flatMap((list) => effortsFor(list, model)))];
};

/**
 * An effort belongs to its model, so it survives a change of agent or model only while the new
 * choice still offers it; otherwise it falls back to blank, the model's own default. Nothing is
 * dropped before the lists have loaded.
 */
export const keepEffort = (
  lists: AgentModelList[] | undefined,
  agent: string | null | undefined,
  model: string | null | undefined,
  effort: string,
): string => (!lists || !effort || effortOptions(lists, agent, model).includes(effort) ? effort : "");

/** Levels come from the same CLI lists as models: Codex and OpenCode declare them per model. */
export function EffortSelect({
  value,
  agent,
  model,
  blankLabel = "Model default",
  disabled,
  onChange,
}: {
  value: string;
  agent: string | null | undefined;
  model: string | null | undefined;
  blankLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const models = useAgentModels();
  const options = effortOptions(models.data, agent, model);
  const known = models.data !== undefined;
  const unsupported = known && value !== "" && !options.includes(value);
  // Nothing to choose (e.g. an OpenCode model without variants): say so rather than offer an empty list.
  const nothing = known && options.length === 0 && value === "";

  return (
    <>
      <select value={value} disabled={disabled || nothing} onChange={(event) => onChange(event.target.value)}>
        <option value="">{nothing ? ((model ?? "").trim() ? "Not offered by this model" : "Choose a model first") : blankLabel}</option>
        {options.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
        {value !== "" && !options.includes(value) && (
          <option value={value}>
            {value}
            {unsupported ? " — not offered" : ""}
          </option>
        )}
      </select>
      {unsupported && <span className="hint error">This model doesn't offer that effort. Pick one from the list.</span>}
    </>
  );
}

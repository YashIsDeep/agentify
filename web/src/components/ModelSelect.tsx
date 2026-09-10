import { useQuery } from "@tanstack/react-query";
import type { AgentModelList } from "@wm/shared";
import { api } from "../api";

/** The models each agent accepts, sourced from the CLIs themselves where they can say. */
export function useAgentModels() {
  return useQuery({ queryKey: ["agent-models"], queryFn: api.agentModels, staleTime: Infinity });
}

export const modelsFor = (lists: AgentModelList[] | undefined, agent: string | null | undefined): string[] => {
  if (!lists) return [];
  if (agent) return lists.find((list) => list.agent === agent)?.models ?? [];
  // No agent pinned down (a task-level override): anything any agent accepts will do.
  return [...new Set(lists.flatMap((list) => list.models))];
};

/**
 * A dropdown rather than a free-text box: a mistyped model used to sit in a template until the
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

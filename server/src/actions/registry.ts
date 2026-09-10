import { archiveTaskAction } from "./archive-task";
import { codingAgentAction } from "./coding-agent";
import { ensureWorktreeAction } from "./ensure-worktree";
import { jiraTransitionAction } from "./jira-transition";
import { linearUpdateAction } from "./linear-update";
import { moveStageAction } from "./move-stage";
import { notionAppendAction } from "./notion-append";
import { openMergeRequestAction } from "./open-merge-request";
import { shellAction } from "./shell";
import type { AnyActionDefinition } from "./types";
import { writeArtifactAction } from "./write-artifact";

export class ActionRegistry {
  private readonly definitions = new Map<string, AnyActionDefinition>();

  register(definition: AnyActionDefinition): this {
    if (this.definitions.has(definition.type)) throw new Error(`Action type "${definition.type}" already registered`);
    this.definitions.set(definition.type, definition);
    return this;
  }

  get(type: string): AnyActionDefinition | undefined {
    return this.definitions.get(type);
  }

  list(): AnyActionDefinition[] {
    return [...this.definitions.values()];
  }
}

export function createDefaultRegistry(): ActionRegistry {
  return new ActionRegistry()
    .register(codingAgentAction)
    .register(shellAction)
    .register(writeArtifactAction)
    .register(moveStageAction)
    .register(ensureWorktreeAction)
    .register(openMergeRequestAction)
    .register(jiraTransitionAction)
    .register(linearUpdateAction)
    .register(notionAppendAction)
    .register(archiveTaskAction);
}

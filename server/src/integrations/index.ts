import { jiraAdapter } from "./jira";
import { linearAdapter } from "./linear";
import { notionAdapter } from "./notion";
import type { AnyConnectionAdapter } from "./types";

export const DEFAULT_CONNECTION_ADAPTERS: AnyConnectionAdapter[] = [jiraAdapter, linearAdapter, notionAdapter];

export { jiraAdapter, linearAdapter, notionAdapter };

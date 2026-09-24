import { Archive, Bot, type LucideIcon, Plug, Workflow } from "lucide-react";

export type View = "board" | "archive" | "agents" | "workflows" | "connections" | "ui-kit";
/** "ui-kit" is the design system's gallery: reachable by URL, deliberately not in the sidebar. */
export const VIEWS: readonly View[] = ["board", "archive", "agents", "workflows", "connections", "ui-kit"];

type Page = { view: Exclude<View, "board" | "ui-kit">; label: string; icon: LucideIcon };

/** The pages the sidebar lists above the boards; "board" is a workflow's own board, not a page. */
export const PAGES: Page[] = [
  { view: "workflows", label: "Workflows", icon: Workflow },
  { view: "agents", label: "Agents", icon: Bot },
  { view: "connections", label: "Connections", icon: Plug },
  { view: "archive", label: "Archive", icon: Archive },
];

import { Archive, Bot, type LucideIcon, Plug, Workflow } from "lucide-react";

export type View = "board" | "archive" | "agents" | "workflows" | "connections";
export const VIEWS: readonly View[] = ["board", "archive", "agents", "workflows", "connections"];

type Page = { view: Exclude<View, "board">; label: string; icon: LucideIcon };

/** The pages the sidebar lists above the boards; "board" is a workflow's own board, not a page. */
export const PAGES: Page[] = [
  { view: "workflows", label: "Workflows", icon: Workflow },
  { view: "agents", label: "Agents", icon: Bot },
  { view: "connections", label: "Connections", icon: Plug },
  { view: "archive", label: "Archive", icon: Archive },
];

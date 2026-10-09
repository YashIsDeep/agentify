import { Archive, Bot, type LucideIcon, MonitorSmartphone, Plug, Workflow } from "lucide-react";

export type View = "board" | "archive" | "agents" | "workflows" | "connections" | "devices" | "conversations" | "ui-kit";
/**
 * "ui-kit" is the design system's gallery: reachable by URL, deliberately not in the sidebar.
 * "conversations" is opened by the sidebar's Needs you counter rather than a link of its own.
 */
export const VIEWS: readonly View[] = ["board", "archive", "agents", "workflows", "connections", "devices", "conversations", "ui-kit"];

type Page = { view: Exclude<View, "board" | "conversations" | "ui-kit">; label: string; icon: LucideIcon };

/** The pages the sidebar lists above the boards; "board" is a workflow's own board, not a page. */
export const PAGES: Page[] = [
  { view: "workflows", label: "Workflows", icon: Workflow },
  { view: "agents", label: "Agents", icon: Bot },
  { view: "connections", label: "Connections", icon: Plug },
  { view: "devices", label: "Devices", icon: MonitorSmartphone },
  { view: "archive", label: "Archive", icon: Archive },
];

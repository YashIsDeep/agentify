import { ChevronDown, Copy, Pencil, Plus } from "lucide-react";
import { useWorkspace } from "../workspace-context";
import { Menu } from "./Menu";

export function WorkspaceSwitcher() {
  const { current, list, select, manage } = useWorkspace();
  return (
    <Menu
      label="Workspaces"
      title="Switch workspace"
      triggerLabel={`Workspace: ${current.name}`}
      align="left"
      checkActive
      triggerClassName="workspace-label workspace-switcher"
      trigger={<>
        <span className="workspace-avatar" aria-hidden="true">{current.name.slice(0, 1).toUpperCase()}</span>
        <span className="workspace-name">{current.name}<small>Personal workspace</small></span>
        <ChevronDown size={13} aria-hidden="true" />
      </>}
      items={[
        ...list.map((workspace) => ({
          key: workspace.id,
          label: workspace.name,
          active: workspace.id === current.id,
          onSelect: () => select(workspace.id),
        })),
        { key: "create", label: "New workspace", icon: Plus, divided: true, onSelect: () => manage("create") },
        { key: "clone", label: "Clone workspace", icon: Copy, onSelect: () => manage("clone") },
        { key: "rename", label: "Rename workspace", icon: Pencil, onSelect: () => manage("rename") },
      ]}
    />
  );
}

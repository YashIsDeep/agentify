import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceInfo } from "@wm/shared";
import { useState } from "react";
import { createWorkspaceApi, workspaceApi } from "./api";
import { ApiContext } from "./api-context";
import { App } from "./App";
import { Modal } from "./components/Modal";
import { ToastProvider } from "./components/Toast";
import { setQueryParams, useQueryParam } from "./lib/url-state";
import { createQueryClient } from "./query-client";
import { WorkspaceContext, useWorkspace, useWorkspaceNavigation } from "./workspace-context";

export function WorkspaceRoot() {
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaceApi.list,
    refetchOnWindowFocus: true,
  });
  const workspaceId = useQueryParam("workspace") ?? "default";
  if (catalog.isLoading) return <div className="splash">Loading workspace…</div>;
  if (catalog.error) return (
    <div className="splash">
      <strong>Could not load workspaces.</strong>
      <span className="muted">{catalog.error.message}</span>
      <button type="button" className="button" onClick={() => void catalog.refetch()}>Try again</button>
    </div>
  );
  const list = catalog.data ?? [];
  const current = list.find((workspace) => workspace.id === workspaceId);
  if (!current) return (
    <div className="splash">
      <strong>Workspace not found.</strong>
      <button type="button" className="button" onClick={() => setQueryParams({ workspace: null, workflow: null, view: null, task: null })}>
        Back to My workspace
      </button>
    </div>
  );
  return (
    <WorkspaceSession
      key={current.id}
      current={current}
      list={list}
      onSaved={(workspace) => {
        queryClient.setQueryData<WorkspaceInfo[]>(["workspaces"], (previous = []) =>
          previous.some((item) => item.id === workspace.id)
            ? previous.map((item) => item.id === workspace.id ? workspace : item)
            : [...previous, workspace],
        );
      }}
    />
  );
}

function WorkspaceSession({ current, list, onSaved }: {
  current: WorkspaceInfo;
  list: WorkspaceInfo[];
  onSaved: (workspace: WorkspaceInfo) => void;
}) {
  // A separate API client and query cache per mounted workspace also isolate pending requests.
  const [api] = useState(() => createWorkspaceApi(current.id));
  const [queryClient] = useState(createQueryClient);
  const [action, setAction] = useState<"create" | "clone" | "rename" | null>(null);
  return (
    <WorkspaceContext.Provider value={{
      current,
      list,
      select: (id) => setQueryParams({ workspace: id, workflow: null, view: null, task: null }),
      manage: setAction,
    }}>
      <ApiContext.Provider value={api}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <App />
            {action && <WorkspaceDialog action={action} onSaved={onSaved} onClose={() => setAction(null)} />}
          </ToastProvider>
        </QueryClientProvider>
      </ApiContext.Provider>
    </WorkspaceContext.Provider>
  );
}

function WorkspaceDialog({ action, onSaved, onClose }: {
  action: "create" | "clone" | "rename";
  onSaved: (workspace: WorkspaceInfo) => void;
  onClose: () => void;
}) {
  const { current } = useWorkspace();
  const navigate = useWorkspaceNavigation();
  const [name, setName] = useState(action === "clone" ? `${current.name} copy` : action === "rename" ? current.name : "");
  const save = useMutation({
    mutationFn: () => action === "clone"
      ? workspaceApi.clone(current.id, { name })
      : action === "rename"
        ? workspaceApi.rename(current.id, { name })
        : workspaceApi.create({ name }),
    onSuccess: (workspace) => {
      onSaved(workspace);
      onClose();
      if (action !== "rename") navigate({ workspace: workspace.id, workflow: null, view: null, task: null });
    },
  });
  const close = () => { if (!save.isPending) onClose(); };
  const title = action === "clone" ? "Clone workspace" : action === "rename" ? "Rename workspace" : "New workspace";
  return (
    <Modal title={title} onClose={close}>
      <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && !save.isPending) save.mutate(); }}>
        <div className="modal-body form-grid">
          <label className="field">
            <span>Workspace name</span>
            <input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Product team" />
          </label>
          {action !== "rename" && (
            <p className="hint">
              {action === "clone"
                ? `Copies workflows, agent settings, and saved connections (including credentials) from “${current.name}”. Tasks and archive start empty. Changes stay independent.`
                : "Start with your own workflows, agent settings, connections, and archive."}
            </p>
          )}
          {save.error && <p className="error" role="alert">{save.error.message}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button ghost" disabled={save.isPending} onClick={close}>Cancel</button>
          <button type="submit" className="button primary" disabled={!name.trim() || save.isPending}>
            {save.isPending ? "Saving…" : action === "clone" ? "Clone workspace" : action === "rename" ? "Save" : "Create workspace"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

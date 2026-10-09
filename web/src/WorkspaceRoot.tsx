import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceInfo } from "@wm/shared";
import { useState } from "react";
import { createWorkspaceApi, workspaceApi } from "./api";
import { ApiContext } from "./api-context";
import { App } from "./App";
import { setQueryParams, useQueryParam } from "./lib/url-state";
import { createQueryClient } from "./query-client";
import { Button, Callout, Dialog, DialogBody, DialogFooter, Field, Splash, ToastProvider } from "./ui";
import { WorkspaceContext, useWorkspace, useWorkspaceNavigation } from "./workspace-context";

export function WorkspaceRoot() {
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaceApi.list,
    refetchOnWindowFocus: true,
  });
  const workspaceId = useQueryParam("workspace") ?? "default";
  if (catalog.isLoading) return <Splash title="Loading workspace…" />;
  if (catalog.error) return (
    <Splash title="Could not load workspaces." action={<Button onClick={() => void catalog.refetch()}>Try again</Button>}>
      {catalog.error.message}
    </Splash>
  );
  const list = catalog.data ?? [];
  const current = list.find((workspace) => workspace.id === workspaceId);
  if (!current) return (
    <Splash
      title="Workspace not found."
      action={<Button onClick={() => setQueryParams({ workspace: null, workflow: null, view: null, task: null })}>Back to My workspace</Button>}
    />
  );
  return (
    <WorkspaceSession
      key={current.id}
      current={current}
      list={list}
      refreshCatalog={() => void queryClient.invalidateQueries({ queryKey: ["workspaces"] })}
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

function WorkspaceSession({ current, list, refreshCatalog, onSaved }: {
  current: WorkspaceInfo;
  list: WorkspaceInfo[];
  refreshCatalog: () => void;
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
      refreshCatalog,
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
    <Dialog title={title} onClose={close} onSubmit={() => name.trim() && !save.isPending && save.mutate()}>
      <DialogBody>
        <Field
          label="Workspace name"
          // Worth saying up front: a clone carries credentials along with it.
          note={action === "clone" ? "Copies workflows, agent settings and connections, credentials included. Tasks aren't copied." : undefined}
        >
          <input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Product team" />
        </Field>
        {save.error && <Callout tone="danger">{save.error.message}</Callout>}
      </DialogBody>
      <DialogFooter onCancel={close} busy={save.isPending}>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={save.isPending} loadingText="Saving…">
          {action === "clone" ? "Clone workspace" : action === "rename" ? "Save" : "Create workspace"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

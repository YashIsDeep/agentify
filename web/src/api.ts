import type {
  ActionTypeInfo,
  AgentId,
  AnswerQuestionInput,
  ConcurrencySettings,
  AgentModelList,
  AgentStatus,
  AgentTestResult,
  ArtifactInfo,
  ConnectionInfo,
  ConnectionTestResult,
  ConnectionTypeInfo,
  CreateConnectionInput,
  CreateTaskInput,
  CreateWorkflowInput,
  CreateWorkspaceInput,
  RemoteAccessStatus,
  RepoInfo,
  RunLogLine,
  SessionInfo,
  SaveWorkflowInput,
  TaskDetail,
  TaskDiff,
  TaskLink,
  TaskStatus,
  TaskSummary,
  TicketDraft,
  TicketDraftSettings,
  UpdateConnectionInput,
  UpdateTaskInput,
  WorkflowDef,
  WorkflowUsage,
  WorkspaceInfo,
} from "@wm/shared";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Fired when the server turns a request away (401, 403): the device may have been removed or remote
 * access switched off, so whoever shows the session should ask again.
 */
export const ACCESS_LOST_EVENT = "agentify:access-lost";

async function request(path: string, init: { method?: string; json?: unknown; isSessionCheck?: boolean } = {}): Promise<Response> {
  const hasBody = init.json !== undefined;
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init.json) : undefined,
  });
  if (!response.ok) {
    // The session check is what this event asks for, so its own refusal mustn't ask again.
    if ((response.status === 401 || response.status === 403) && !init.isSessionCheck) window.dispatchEvent(new Event(ACCESS_LOST_EVENT));
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `${response.status} ${response.statusText}`, response.status);
  }
  return response;
}

const json = async <T>(path: string, init?: { method?: string; json?: unknown }) =>
  (await (await request(path, init)).json()) as T;
const post = <T>(path: string, body: unknown = {}) => json<T>(path, { method: "POST", json: body });
const enc = encodeURIComponent;

export const workspaceApi = {
  list: () => json<WorkspaceInfo[]>("/api/workspaces"),
  create: (input: CreateWorkspaceInput) => post<WorkspaceInfo>("/api/workspaces", input),
  clone: (id: string, input: CreateWorkspaceInput) => post<WorkspaceInfo>(`/api/workspaces/${enc(id)}/clone`, input),
  rename: (id: string, input: CreateWorkspaceInput) =>
    json<WorkspaceInfo>(`/api/workspaces/${enc(id)}`, { method: "PATCH", json: input }),
};

/** Server-wide settings, shared by every workspace. */
export const serverApi = {
  concurrency: () => json<ConcurrencySettings>("/api/settings/concurrency"),
  saveConcurrency: (settings: ConcurrencySettings) =>
    json<ConcurrencySettings>("/api/settings/concurrency", { method: "PUT", json: settings }),

  remoteAccess: () => json<RemoteAccessStatus>("/api/remote-access"),
  setRemoteAccess: (enabled: boolean) => json<RemoteAccessStatus>("/api/remote-access", { method: "PUT", json: { enabled } }),
  /** Replaces any code still waiting. */
  startPairing: () => post<RemoteAccessStatus>("/api/remote-access/pairing"),
  /** Only if `code` is still the one waiting. */
  cancelPairing: async (code: string) => void (await request(`/api/remote-access/pairing?code=${enc(code)}`, { method: "DELETE" })),
  removeDevice: async (id: string) => void (await request(`/api/devices/${enc(id)}`, { method: "DELETE" })),
};

/** Who this browser is to the server, and how a device that isn't paired yet becomes one. */
export const sessionApi = {
  get: async () => (await (await request("/api/session", { isSessionCheck: true })).json()) as SessionInfo,
  pair: async (code: string) =>
    (await (await request("/api/devices/pair", { method: "POST", json: { code }, isSessionCheck: true })).json()) as SessionInfo,
  signOut: async () => void (await request("/api/devices/sign-out", { method: "POST" })),
};

/** Bound once to a workspace: an in-flight callback can never write into a newly selected one. */
export function createWorkspaceApi(workspaceId: string) {
  const base = `/api/workspaces/${enc(workspaceId)}`;
  const send = (path: string, init?: { method?: string; json?: unknown }) => request(base + path.slice(4), init);
  const json = async <T>(path: string, init?: { method?: string; json?: unknown }) =>
    (await (await send(path, init)).json()) as T;
  const post = <T>(path: string, body: unknown = {}) => json<T>(path, { method: "POST", json: body });
  return {
  eventsUrl: `${base}/events`,
  workflows: () => json<WorkflowDef[]>("/api/workflows"),
  workflowUsage: (id: string) => json<WorkflowUsage>(`/api/workflows/${enc(id)}/usage`),
  createWorkflow: (input: CreateWorkflowInput) => post<WorkflowDef>("/api/workflows", input),
  saveWorkflow: (id: string, input: SaveWorkflowInput) =>
    json<WorkflowDef>(`/api/workflows/${enc(id)}`, { method: "PUT", json: input }),
  /** `force` also deletes the tasks still using the workflow. */
  deleteWorkflow: async (id: string, force = false) =>
    void (await send(`/api/workflows/${enc(id)}${force ? "?force=true" : ""}`, { method: "DELETE" })),
  actionTypes: () => json<ActionTypeInfo[]>("/api/action-types"),

  repos: () => json<RepoInfo[]>("/api/repos"),
  branches: (path: string) => json<string[]>(`/api/repos/branches?path=${enc(path)}`),

  tasks: (filter: { workflowId?: string; status?: TaskStatus }) => {
    const params = new URLSearchParams();
    if (filter.workflowId) params.set("workflowId", filter.workflowId);
    if (filter.status) params.set("status", filter.status);
    return json<TaskSummary[]>(`/api/tasks?${params}`);
  },
  task: (id: string) => json<TaskDetail>(`/api/tasks/${enc(id)}`),
  createTask: (input: CreateTaskInput) => post<TaskDetail>("/api/tasks", input),
  updateTask: (id: string, patch: UpdateTaskInput) =>
    json<TaskDetail>(`/api/tasks/${enc(id)}`, { method: "PATCH", json: patch }),
  moveTask: (id: string, stageId: string, runActions: boolean) =>
    post<TaskDetail>(`/api/tasks/${enc(id)}/move`, { stageId, runActions }),
  /** Runs the current stage's actions when the task was moved in without running them. */
  startActions: (id: string) => post<TaskDetail>(`/api/tasks/${enc(id)}/start`),
  archiveTask: (id: string, force = false) => post<TaskDetail>(`/api/tasks/${enc(id)}/archive`, { force }),

  answerQuestion: (questionId: string, input: AnswerQuestionInput) =>
    post<TaskDetail>(`/api/questions/${enc(questionId)}/answer`, input),

  /** What the task's branch changed, including work the agent has not committed. */
  taskDiff: (id: string) => json<TaskDiff>(`/api/tasks/${enc(id)}/diff`),

  artifacts: (id: string) => json<ArtifactInfo[]>(`/api/tasks/${enc(id)}/artifacts`),
  artifact: async (id: string, name: string) => (await send(`/api/tasks/${enc(id)}/artifact?name=${enc(name)}`)).text(),

  agents: () => json<AgentStatus[]>("/api/agents"),
  agentModels: () => json<AgentModelList[]>("/api/agent-models"),
  setAgentPath: (id: AgentId, path: string | null) => json<AgentStatus>(`/api/agents/${id}`, { method: "PUT", json: { path } }),
  setAgentDefaults: (id: AgentId, defaults: { model: string | null; effort: string | null }) =>
    json<AgentStatus>(`/api/agents/${id}/defaults`, { method: "PUT", json: defaults }),
  /** Runs with the agent's saved default model and effort. */
  testAgent: (id: AgentId) => post<AgentTestResult>(`/api/agents/${id}/test`, {}),

  connectionTypes: () => json<ConnectionTypeInfo[]>("/api/connection-types"),
  connections: () => json<ConnectionInfo[]>("/api/connections"),
  createConnection: (input: CreateConnectionInput) => post<ConnectionInfo>("/api/connections", input),
  updateConnection: (id: string, input: UpdateConnectionInput) =>
    json<ConnectionInfo>(`/api/connections/${enc(id)}`, { method: "PUT", json: input }),
  deleteConnection: async (id: string) => void (await send(`/api/connections/${enc(id)}`, { method: "DELETE" })),
  testConnection: (id: string) => post<ConnectionTestResult>(`/api/connections/${enc(id)}/test`),

  /** Reads the ticket and drafts a title and description; can take a while when an agent writes it. */
  draftFromTicket: (link: TaskLink) => post<TicketDraft>("/api/tickets/draft", { link }),
  ticketDraftSettings: () => json<TicketDraftSettings>("/api/settings/ticket-draft"),
  saveTicketDraftSettings: (settings: TicketDraftSettings) =>
    json<TicketDraftSettings>("/api/settings/ticket-draft", { method: "PUT", json: settings }),

  runLog: (runId: number) => json<RunLogLine[]>(`/api/runs/${runId}/log`),
  retryRun: (runId: number, overrides?: Record<string, unknown>) =>
    post<TaskDetail>(`/api/runs/${runId}/retry`, overrides ? { overrides } : {}),
  cancelRun: (runId: number) => post<TaskDetail>(`/api/runs/${runId}/cancel`),
  /** Carry on past a failed or cancelled action. */
  skipRun: (runId: number) => post<TaskDetail>(`/api/runs/${runId}/skip`),
  approveRun: (runId: number) => post<TaskDetail>(`/api/runs/${runId}/approve`),
  /** Sends an agent waiting for approval back to work, in the session it just used. */
  requestChanges: (runId: number, note: string) => post<TaskDetail>(`/api/runs/${runId}/request-changes`, { note }),
  sendBackRun: (runId: number, note?: string) =>
    post<TaskDetail>(`/api/runs/${runId}/send-back`, note === undefined ? {} : { note }),
  /** Try a run waiting for a usage limit now rather than at the reset time. */
  resumeRun: (runId: number) => post<TaskDetail>(`/api/runs/${runId}/resume`),
};
}

export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;

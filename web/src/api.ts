import type {
  ActionTypeInfo,
  AgentId,
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
  RepoInfo,
  RunLogLine,
  SaveWorkflowInput,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  UpdateConnectionInput,
  UpdateTaskInput,
  WorkflowDef,
  WorkflowUsage,
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

async function send(path: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
  const hasBody = init.json !== undefined;
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init.json) : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `${response.status} ${response.statusText}`, response.status);
  }
  return response;
}

const json = async <T>(path: string, init?: { method?: string; json?: unknown }) =>
  (await (await send(path, init)).json()) as T;
const post = <T>(path: string, body: unknown = {}) => json<T>(path, { method: "POST", json: body });
const enc = encodeURIComponent;

export const api = {
  workflows: () => json<WorkflowDef[]>("/api/workflows"),
  workflowUsage: (id: string) => json<WorkflowUsage>(`/api/workflows/${enc(id)}/usage`),
  createWorkflow: (input: CreateWorkflowInput) => post<WorkflowDef>("/api/workflows", input),
  saveWorkflow: (id: string, input: SaveWorkflowInput) =>
    json<WorkflowDef>(`/api/workflows/${enc(id)}`, { method: "PUT", json: input }),
  deleteWorkflow: async (id: string) => void (await send(`/api/workflows/${enc(id)}`, { method: "DELETE" })),
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
  completePhase: (id: string, phaseStateId: string) =>
    post<TaskDetail>(`/api/tasks/${enc(id)}/phases/${enc(phaseStateId)}/complete`),
  completeStage: (id: string) => post<TaskDetail>(`/api/tasks/${enc(id)}/stage/complete`),
  triggerAction: (id: string, bindingId: string, feedback?: string) =>
    post<TaskDetail>(`/api/tasks/${enc(id)}/bindings/${enc(bindingId)}/trigger`, feedback === undefined ? {} : { feedback }),
  archiveTask: (id: string, force = false) => post<TaskDetail>(`/api/tasks/${enc(id)}/archive`, { force }),

  artifacts: (id: string) => json<ArtifactInfo[]>(`/api/tasks/${enc(id)}/artifacts`),
  artifact: async (id: string, name: string) => (await send(`/api/tasks/${enc(id)}/artifact?name=${enc(name)}`)).text(),

  agents: () => json<AgentStatus[]>("/api/agents"),
  agentModels: () => json<AgentModelList[]>("/api/agent-models"),
  setAgentPath: (id: AgentId, path: string | null) => json<AgentStatus>(`/api/agents/${id}`, { method: "PUT", json: { path } }),
  testAgent: (id: AgentId, model?: string) => post<AgentTestResult>(`/api/agents/${id}/test`, model ? { model } : {}),

  connectionTypes: () => json<ConnectionTypeInfo[]>("/api/connection-types"),
  connections: () => json<ConnectionInfo[]>("/api/connections"),
  createConnection: (input: CreateConnectionInput) => post<ConnectionInfo>("/api/connections", input),
  updateConnection: (id: string, input: UpdateConnectionInput) =>
    json<ConnectionInfo>(`/api/connections/${enc(id)}`, { method: "PUT", json: input }),
  deleteConnection: async (id: string) => void (await send(`/api/connections/${enc(id)}`, { method: "DELETE" })),
  testConnection: (id: string) => post<ConnectionTestResult>(`/api/connections/${enc(id)}/test`),

  runLog: (runId: number) => json<RunLogLine[]>(`/api/runs/${runId}/log`),
  retryRun: (runId: number, overrides?: Record<string, unknown>) =>
    post<TaskDetail>(`/api/runs/${runId}/retry`, overrides ? { overrides } : {}),
  cancelRun: (runId: number) => post<TaskDetail>(`/api/runs/${runId}/cancel`),
};

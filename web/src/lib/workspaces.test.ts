import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceApi } from "../api";
import { createQueryClient } from "../query-client";

afterEach(() => vi.unstubAllGlobals());

describe("workspace clients", () => {
  it("keeps late API calls bound to the workspace that created them", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("[]", { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const first = createWorkspaceApi("first");
    const second = createWorkspaceApi("second");
    await second.tasks({ status: "archived" });
    await first.updateTask("task/one", { title: "Late change" });
    await first.artifact("task/one", "notes.txt");
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/workspaces/second/tasks?status=archived",
      "/api/workspaces/first/tasks/task%2Fone",
      "/api/workspaces/first/tasks/task%2Fone/artifact?name=notes.txt",
    ]);
    expect(first.eventsUrl).toBe("/api/workspaces/first/events");
    expect(second.eventsUrl).toBe("/api/workspaces/second/events");
  });

  it("keeps caches separate even when cloned resources use the same local ID", () => {
    const first = createQueryClient();
    const second = createQueryClient();
    first.setQueryData(["workflows"], [{ id: "same", name: "Original" }]);
    first.setQueryData(["runLog", 1], ["private log"]);
    second.setQueryData(["workflows"], [{ id: "same", name: "Clone" }]);
    expect(second.getQueryData(["runLog", 1])).toBeUndefined();
    expect(first.getQueryData(["workflows"])).toEqual([{ id: "same", name: "Original" }]);
    first.clear();
    second.clear();
  });
});

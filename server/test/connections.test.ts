import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeHttp, json } from "./fake-http";
import { createHarness, type Harness, removeDir } from "./helpers";

let h: Harness;

/** Each test picks the responses it needs, so replace the harness rather than the routes. */
async function harness(routes: Parameters<typeof fakeHttp>[0]): Promise<void> {
  await h.close();
  removeDir(h.dataDir);
  h = createHarness({ http: fakeHttp(routes).http });
}

beforeEach(() => {
  h = createHarness({ http: fakeHttp({ "GET /rest/api/3/myself": () => ({ displayName: "Yash" }) }).http });
});

afterEach(async () => {
  await h.close();
  removeDir(h.dataDir);
});

describe("connections", () => {
  const addJira = (values: Record<string, string> = {}) =>
    h.connections.create({
      name: "Work Jira",
      type: "jira",
      values: { baseUrl: "https://team.atlassian.net", email: "me@example.com", apiToken: "secret-token", ...values },
    });

  it("never returns secret values, only which ones are set", () => {
    const created = addJira();
    expect(created.values).toEqual({ baseUrl: "https://team.atlassian.net", email: "me@example.com" });
    expect(created.secretsSet).toEqual(["apiToken"]);
    expect(JSON.stringify(h.connections.list())).not.toContain("secret-token");
  });

  it("stores credentials in secrets.json, outside the database", () => {
    addJira();
    const file = readFileSync(h.paths.secretsFile, "utf8");
    expect(file).toContain("secret-token");
    expect(readFileSync(h.paths.dbFile).toString("latin1")).not.toContain("secret-token");
  });

  it("keeps a secret the browser never saw, and clears it when explicitly blanked", () => {
    const created = addJira();
    h.connections.update(created.id, { values: { email: "other@example.com" } });
    expect(h.connections.get(created.id).values.apiToken).toBe("secret-token");
    expect(h.connections.get(created.id).values.email).toBe("other@example.com");

    const cleared = h.connections.update(created.id, { values: { apiToken: "" } });
    expect(cleared.secretsSet).toEqual([]);
  });

  it("drops fields the connection type doesn't declare", () => {
    const created = h.connections.create({ name: "Linear", type: "linear", values: { apiKey: "lin_key", nonsense: "x" } });
    expect(Object.keys(h.connections.get(created.id).values)).toEqual(["apiKey"]);
  });

  it("tests credentials against the service and reports who we are", async () => {
    const created = addJira();
    await expect(h.connections.test(created.id)).resolves.toMatchObject({ ok: true, detail: "Yash" });
  });

  it("reports a bad token as a failure rather than throwing", async () => {
    await harness({ "GET /rest/api/3/myself": () => json({ errorMessages: ["Client must be authenticated"] }, 401) });
    const created = addJira();
    const result = await h.connections.test(created.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Client must be authenticated");
  });

  it("explains a half-filled connection instead of sending an empty token", async () => {
    const created = h.connections.create({ name: "Empty", type: "jira", values: { baseUrl: "https://team.atlassian.net" } });
    const result = await h.connections.test(created.id);
    expect(result.error).toContain("email");
  });

  it("removes connections", () => {
    const created = addJira();
    h.connections.remove(created.id);
    expect(h.connections.list()).toEqual([]);
    expect(() => h.connections.remove(created.id)).toThrow(/not found/i);
  });
});

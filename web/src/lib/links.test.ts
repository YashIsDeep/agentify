import { describe, expect, it } from "vitest";
import { cleanLinks, detectLinkType, hasIssueKey, withValue } from "./links";

describe("links", () => {
  it("detects the type of a pasted URL", () => {
    expect(detectLinkType("https://acme.atlassian.net/browse/PROJ-123")).toBe("jira");
    expect(detectLinkType("https://jira.acme.com/browse/PROJ-123")).toBe("jira");
    expect(detectLinkType("https://tracker.acme.com/browse/PROJ-7")).toBe("jira");
    expect(detectLinkType(" https://linear.app/acme/issue/ENG-42/fix-login ")).toBe("linear");
    expect(detectLinkType("https://www.notion.so/acme/Spec-abc123")).toBe("notion");
    expect(detectLinkType("https://github.com/acme/app/pull/9")).toBe("github");
    expect(detectLinkType("https://gitlab.acme.com/team/app/-/merge_requests/3")).toBe("gitlab");
    expect(detectLinkType("https://example.com/doc")).toBe("url");
  });

  it("leaves bare keys and non-web values undecided", () => {
    expect(detectLinkType("PROJ-123")).toBeNull();
    expect(detectLinkType("")).toBeNull();
    expect(detectLinkType("mailto:someone@example.com")).toBeNull();
    expect(detectLinkType("https://notlinear.app/x")).toBe("url");
  });

  it("spots issue keys worth looking up", () => {
    expect(hasIssueKey("PROJ-123")).toBe(true);
    expect(hasIssueKey("https://linear.app/acme/issue/ENG-42/fix-login")).toBe(true);
    expect(hasIssueKey("PROJ-")).toBe(false);
    expect(hasIssueKey("https://www.notion.so/acme/Spec")).toBe(false);
  });

  it("fills in the type only when none was picked", () => {
    const jiraUrl = "https://acme.atlassian.net/browse/PROJ-1";
    expect(withValue({ type: "", value: "" }, jiraUrl)).toEqual({ type: "jira", value: jiraUrl });
    expect(withValue({ type: "url", value: "" }, jiraUrl)).toEqual({ type: "jira", value: jiraUrl });
    expect(withValue({ type: "linear", value: "" }, jiraUrl)).toEqual({ type: "linear", value: jiraUrl });
    expect(withValue({ type: "", value: "" }, "PROJ-1")).toEqual({ type: "", value: "PROJ-1" });
  });

  it("drops blank rows and trims the rest", () => {
    expect(
      cleanLinks([
        { type: "", value: "" },
        { type: "jira", value: "  " },
        { type: " jira ", value: " PROJ-1 " },
      ]),
    ).toEqual([{ type: "jira", value: "PROJ-1" }]);
  });
});

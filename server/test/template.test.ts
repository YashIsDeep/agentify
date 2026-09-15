import { describe, expect, it } from "vitest";
import { parsePath, renderDeep, renderString, TemplateError } from "../src/engine/template";

describe("template", () => {
  it("parses dotted and bracketed paths", () => {
    expect(parsePath("task.title")).toEqual(["task", "title"]);
    expect(parsePath(' artifacts["requirements.md"] ')).toEqual(["artifacts", "requirements.md"]);
    expect(parsePath("outputs.open-mr['url'][0]")).toEqual(["outputs", "open-mr", "url", "0"]);
    expect(() => parsePath("task..title")).toThrow(TemplateError);
    expect(() => parsePath("1abc")).toThrow(TemplateError);
  });

  it("renders values, stringifying objects and blanking missing ones", () => {
    const scope = { task: { title: "Login", tags: ["a"] }, n: 3, nothing: null };
    expect(renderString("{{task.title}} / {{ n }} / {{task.tags}} / [{{missing.deep}}] / [{{nothing}}]", scope)).toBe(
      'Login / 3 / ["a"] / [] / []',
    );
  });

  it("does not expose prototype members", () => {
    expect(renderString("{{task.constructor}}{{task.__proto__}}", { task: {} })).toBe("");
  });

  it("renders strings deep inside config while keeping other types", () => {
    const config = { prompt: "Do {{x}}", nested: [{ v: "{{x}}!" }], enabled: true, count: 2 };
    expect(renderDeep(config, { x: "it" })).toEqual({ prompt: "Do it", nested: [{ v: "it!" }], enabled: true, count: 2 });
  });

  it("reports the references that rendered empty, deep ones included", () => {
    const misses = new Set<string>();
    const collect = (expression: string) => misses.add(expression);
    const scope = { task: { title: "Login" }, outputs: { openMr: { mrUrl: null } } };

    const rendered = renderDeep(
      { prompt: '{{task.title}}: {{ artifacts["requirements.md"] }}', nested: ["{{outputs.openMr.mrUrl}}", "{{task.title}}"] },
      scope,
      collect,
    );
    expect(rendered).toEqual({ prompt: "Login: ", nested: ["", "Login"] });
    expect([...misses]).toEqual(['artifacts["requirements.md"]', "outputs.openMr.mrUrl"]);
  });

  it("renders the same without a collector", () => {
    expect(renderString("[{{missing}}]", {})).toBe("[]");
  });
});

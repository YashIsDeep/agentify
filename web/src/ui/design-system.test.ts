import { describe, expect, it } from "vitest";

/**
 * Keeps the app on its design system (docs/DESIGN-SYSTEM.md): screens build UI from the kit in
 * src/ui rather than its old class names, only the kit talks to Radix, and every stylesheet stays on
 * the token scales. A failure names the file and the offending line.
 */

const sources = import.meta.glob<string>(["../**/*.tsx", "!./**"], { query: "?raw", import: "default", eager: true });
const kitSources = import.meta.glob<string>("./**/*.tsx", { query: "?raw", import: "default", eager: true });
const stylesheets = import.meta.glob<string>(["../**/*.css", "!./tokens.css"], { query: "?raw", import: "default", eager: true });

/** Class names the kit owns (or that it replaced): a screen uses the component instead. */
const RETIRED = [
  "button",
  "icon-button",
  "link-button",
  "chip",
  "pill",
  "badge",
  "callout",
  "hint",
  "field",
  "field-row",
  "form-grid",
  "checkbox",
  "empty-state",
  "splash",
  "page-view",
  "page-header",
  "modal-backdrop",
  "modal-body",
  "modal-footer",
];

const offending = (files: Record<string, string>, test: (line: string) => boolean) =>
  Object.entries(files).flatMap(([file, text]) =>
    text.split("\n").flatMap((line, index) => (test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );

/** The class names written literally in a line's className attributes (not the variables in them). */
const classNames = (line: string) =>
  [...line.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cls\((.*)\)\})/g)].flatMap((match) => {
    // Inside cls(...) only the quoted strings are class names; in a template, not the ${...} parts.
    const value = match[3] !== undefined ? (match[3].match(/"[^"]*"|`[^`]*`/g) ?? []).join(" ") : (match[1] ?? match[2] ?? "");
    return value.replace(/\$\{[^}]*\}/g, " ").match(/[a-z][\w-]*/g) ?? [];
  });

describe("design system", () => {
  it("found the files it checks", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(Object.keys(kitSources).length).toBeGreaterThan(5);
    expect(Object.keys(stylesheets).length).toBeGreaterThan(5);
    // Guards against the stylesheets arriving empty, which would make every CSS check pass.
    expect(Object.values(stylesheets).every((text) => text.length > 0)).toBe(true);
  });

  it("screens use kit components, not the class names they replaced", () => {
    expect(offending(sources, (line) => classNames(line).some((name) => RETIRED.includes(name)))).toEqual([]);
  });

  it("screens don't reach into the kit's own classes", () => {
    expect(offending(sources, (line) => classNames(line).some((name) => name.startsWith("ui-")))).toEqual([]);
  });

  it("only the kit imports Radix", () => {
    expect(offending(sources, (line) => /from "radix-ui"/.test(line))).toEqual([]);
  });

  it("colours come from tokens", () => {
    expect(offending(stylesheets, (line) => /#[0-9a-f]{3,8}\b/i.test(line))).toEqual([]);
  });

  it("font sizes come from the type scale (relative em sizes, like inline code, are fine)", () => {
    expect(offending(stylesheets, (line) => /font(?:-size)?:\s*[\d.]+px/.test(line))).toEqual([]);
  });

  it("single corner radii come from the radius tokens", () => {
    expect(offending(stylesheets, (line) => /border-radius:\s*\d+px;/.test(line) && !/border-radius:\s*[0-2]px;/.test(line))).toEqual([]);
  });

  it("spacing sits on the grid: even pixels, and multiples of 4 from 16px up", () => {
    const offGrid = (value: number) => {
      const size = Math.abs(value);
      return size > 2 && (size % 2 !== 0 || (size >= 16 && size % 4 !== 0));
    };
    expect(
      offending(stylesheets, (line) => {
        const value = line.match(/^\s*(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:([^;]+)/)?.[1] ?? "";
        return [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].some((match) => offGrid(Number(match[1])));
      }),
    ).toEqual([]);
  });
});

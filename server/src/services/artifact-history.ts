import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { writePrivateFile } from "../lib/atomic-file";
import { resolveInside } from "../paths";

export interface Verification {
  decision: "approved" | "changes_requested" | "invalid";
  feedback: string;
  raw: string;
}

/** Other current documents include the previous cumulative decisions.md and the accepted plan. */
export function currentDocumentContext(root: string, exclude: string): string {
  resolveInside(root, exclude);
  if (!existsSync(root)) return "";
  const excluded = relative(root, resolveInside(root, exclude)).split(sep).join("/").toLowerCase();
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((name) => !name.startsWith(".history/") && name.toLowerCase() !== excluded && /\.(md|markdown|txt)$/i.test(name))
    .sort()
    .map((name) => `Current artifact: ${name}\n${readFileSync(resolveInside(root, name), "utf8")}`)
    .join("\n\n---\n\n");
}

/** Append-only snapshots; the ordinary artifact name remains the accepted/current result. */
export function artifactHistory(root: string, name: string) {
  const current = resolveInside(root, name);
  const normalized = relative(root, current).split(sep).join("/");
  if (/^\.history(?:\/|$)/i.test(normalized)) throw new Error(".history is reserved for artifact versions");
  const folder = `.history/${normalized}`;
  const extension = extname(normalized);
  const file = (kind: "B" | "V", version: number) => resolveInside(root, `${folder}/${kind}${version}${kind === "B" ? extension : ".md"}`);
  const append = (version: number, text: string) => writeFileSync(file("B", version), text, { encoding: "utf8", flag: "wx" });

  return {
    reference(kind: "B" | "V", version: number): string {
      return relative(root, file(kind, version)).split(sep).join("/");
    },
    /** Full source text, in build/review order, for the final decision record. Never silently truncate. */
    context(): string {
      const directory = resolveInside(root, folder);
      if (!existsSync(directory)) return "No previous builds or reviews.";
      return readdirSync(directory)
        .filter((entry) => /^[BV][1-9]\d*(?:\..*)?$/.test(entry))
        .sort((a, b) => Number(/^.[0-9]+/.exec(a)![0].slice(1)) - Number(/^.[0-9]+/.exec(b)![0].slice(1)) || a.localeCompare(b))
        .map((entry) => `Source: ${folder}/${entry}\n${readFileSync(resolveInside(root, `${folder}/${entry}`), "utf8")}`)
        .join("\n\n---\n\n");
    },
    build(text: string): number {
      resolveInside(root, name);
      const directory = resolveInside(root, folder);
      mkdirSync(directory, { recursive: true });
      const versions = readdirSync(directory).map((entry) => /^B([1-9]\d*)(?:\..*)?$/.exec(entry)).filter((match) => match !== null);
      let latest = versions.reduce((max, match) => Math.max(max, Number(match[1])), 0);
      // On first use, preserve a pre-existing artifact before a new build can replace it.
      if (!latest && existsSync(current)) append(++latest, readFileSync(current, "utf8"));
      append(++latest, text);
      return latest;
    },
    verify(version: number, verification: Verification): void {
      if (!Number.isSafeInteger(version) || version < 1 || !existsSync(file("B", version))) throw new Error("Missing build for verification");
      const status = { approved: "Clean", changes_requested: "Changes requested", invalid: "Invalid review" }[verification.decision];
      const contents = `# ${normalized} Review V${version}\n\nBuild: B${version}\n\nResult: ${status}\n\n${verification.feedback}\n\n## Reviewer response\n\n${verification.raw}\n`;
      writeFileSync(file("V", version), contents, { encoding: "utf8", flag: "wx" });
    },
    /** Only call after the loop accepts the result. */
    publish(text: string): void {
      resolveInside(root, name);
      mkdirSync(dirname(current), { recursive: true });
      writePrivateFile(current, text);
    },
  };
}

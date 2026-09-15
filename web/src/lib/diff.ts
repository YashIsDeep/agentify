/** The patch split by file, keyed the way the file list is: `diff --git a/old b/new`. */
export function splitPatch(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  let path = "";
  let lines: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (path) byPath.set(path, lines.join("\n"));
      path = headerPath(line);
      lines = [];
      continue;
    }
    if (path) lines.push(line);
  }
  if (path) byPath.set(path, lines.join("\n"));
  return byPath;
}

/** A rename's hunks belong to where the file ended up, which is the b side. */
function headerPath(line: string): string {
  const start = line.lastIndexOf(" b/");
  if (start === -1) return "";
  const path = line.slice(start + 3);
  // Only a path with a space in it comes quoted; git runs with core.quotePath off for the rest.
  return path.endsWith('"') ? path.slice(0, -1) : path;
}

/** How a patch line is coloured, against the log's dark background. */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-line-hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line-del";
  return "";
}

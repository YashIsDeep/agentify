/** History lives beside current artifacts and survives transcript cleanup. */
export interface ArtifactVersion {
  artifact: string;
  version: number;
  kind: "build" | "review";
}

export function artifactVersion(name: string): ArtifactVersion | undefined {
  const match = /^\.history\/(.+)\/([BV])([1-9]\d*)(\.[^/]*)?$/.exec(name);
  if (!match) return undefined;
  return { artifact: match[1]!, kind: match[2] === "B" ? "build" : "review", version: Number(match[3]) };
}

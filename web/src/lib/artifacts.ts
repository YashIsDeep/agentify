import { artifactVersion, type ArtifactInfo } from "@wm/shared";

export function artifactLabel(file: Pick<ArtifactInfo, "name">): string {
  const version = artifactVersion(file.name);
  if (!version) return file.name;
  const title = version.artifact.replace(/\.[^/.]+$/, "");
  return `${title} ${version.kind === "build" ? "B" : "Review V"}${version.version}`;
}

/** Current files first, then each document's builds immediately followed by their reviews. */
export function sortedArtifacts(files: ArtifactInfo[]): ArtifactInfo[] {
  return [...files].sort((a, b) => {
    const av = artifactVersion(a.name);
    const bv = artifactVersion(b.name);
    if (!av || !bv) return Number(!!av) - Number(!!bv) || a.name.localeCompare(b.name);
    return av.artifact.localeCompare(bv.artifact) || av.version - bv.version || Number(av.kind === "review") - Number(bv.kind === "review");
  });
}

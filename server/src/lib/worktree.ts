import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * `git worktree remove` unregisters a worktree but stops short of the links its carry-over made —
 * a junction to the repository's node_modules, say — and leaves the folder behind with that link
 * still live. A later clean-up that follows links (Windows PowerShell's `Remove-Item -Recurse` does)
 * would then empty the repository's own copy. This removes the links themselves, never what they
 * point at, then the directories they leave empty. Anything else is left where it is.
 *
 * Returns whether the folder is gone.
 */
export async function removeWorktreeLeftovers(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => null);
  if (!info) return true;
  // Junctions report as symbolic links, and unlinking one removes the link, not its target.
  if (info.isSymbolicLink()) {
    await unlink(dir);
    return true;
  }
  if (!info.isDirectory()) return false;
  let empty = true;
  for (const name of await readdir(dir)) {
    if (!(await removeWorktreeLeftovers(join(dir, name)))) empty = false;
  }
  if (empty) await rmdir(dir);
  return empty;
}

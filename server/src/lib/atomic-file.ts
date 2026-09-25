import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Replace a file without reusing an existing temporary file's links or permissions. */
export function writePrivateFile(file: string, contents: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  // Exclusive creation refuses existing files, hard links and dangling symlinks alike.
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, contents, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original write/rename error. */ }
    throw error;
  }
}

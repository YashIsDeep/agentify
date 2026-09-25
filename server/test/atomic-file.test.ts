import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writePrivateFile } from "../src/lib/atomic-file";
import { removeDir } from "./helpers";

vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => "test-collision",
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wm-atomic-")); });
afterEach(() => { removeDir(dir); });

it("refuses a colliding temporary hard link without writing to or deleting it", () => {
  const other = join(dir, "other.txt");
  const file = join(dir, "secrets.json");
  const temporary = `${file}.test-collision.tmp`;
  writeFileSync(other, "UNCHANGED");
  writeFileSync(file, "OLD_CREDENTIALS");
  linkSync(other, temporary);
  expect(() => writePrivateFile(file, "PRIVATE_TOKEN")).toThrow();
  expect(readFileSync(other, "utf8")).toBe("UNCHANGED");
  expect(readFileSync(temporary, "utf8")).toBe("UNCHANGED");
  expect(readFileSync(file, "utf8")).toBe("OLD_CREDENTIALS");
});

it("replaces a destination hard link without changing its other name", () => {
  const other = join(dir, "other.txt");
  const file = join(dir, "secrets.json");
  writeFileSync(other, "UNCHANGED");
  linkSync(other, file);
  writePrivateFile(file, "PRIVATE_TOKEN");
  expect(readFileSync(other, "utf8")).toBe("UNCHANGED");
  expect(readFileSync(file, "utf8")).toBe("PRIVATE_TOKEN");
  expect(readdirSync(dir).sort()).toEqual(["other.txt", "secrets.json"]);
});

it("removes temporary credentials when replacement fails", () => {
  const file = join(dir, "occupied");
  mkdirSync(file);
  writeFileSync(join(file, "keep.txt"), "UNCHANGED");
  expect(() => writePrivateFile(file, "PRIVATE_TOKEN")).toThrow();
  expect(readFileSync(join(file, "keep.txt"), "utf8")).toBe("UNCHANGED");
  expect(readdirSync(dir)).toEqual(["occupied"]);
});

it.skipIf(process.platform === "win32")("restricts permissions on both creation and replacement", () => {
  const file = join(dir, "secrets.json");
  writePrivateFile(file, "first");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  chmodSync(file, 0o644);
  writePrivateFile(file, "second");
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

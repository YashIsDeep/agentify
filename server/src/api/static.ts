import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { assertNoSymlinks } from "../paths";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Serves the built web app, falling back to index.html for client-side routes. Register after API routes. */
export function serveWeb(app: Hono, distDir: string): void {
  const indexFile = join(distDir, "index.html");

  app.get("*", async (c, next) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("Bad request", 400);
    }
    if (pathname.startsWith("/api/")) return next();

    const target = resolve(distDir, `.${pathname}`);
    const rel = relative(distDir, target);
    const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    try {
      if (inside) assertNoSymlinks(distDir, target);
      assertNoSymlinks(distDir, indexFile);
    } catch {
      return c.notFound();
    }
    const file = inside && existsSync(target) && statSync(target).isFile() ? target : indexFile;
    if (!existsSync(file)) return next();

    const immutable = file !== indexFile && pathname.startsWith("/assets/");
    return c.body(await readFile(file), 200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
  });
}

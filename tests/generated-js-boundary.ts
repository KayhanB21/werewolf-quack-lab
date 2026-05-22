#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "eval/runs"]);
const ALLOWED_JS_PREFIXES = [path.join(ROOT_DIR, ".generated", "web")];

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT_DIR, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || rel.startsWith(`eval${path.sep}inspect${path.sep}.venv`)) continue;
      files.push(...await collect(abs));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      files.push(abs);
    }
  }
  return files;
}

const html = await readFile(path.join(ROOT_DIR, "web", "index.html"), "utf8");
assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
assert.doesNotMatch(html, /web\/app\.ts/);
assert.doesNotMatch(html, /web\/flow\.ts/);
assert.ok(await exists(path.join(ROOT_DIR, "web", "app.ts")), "web/app.ts must remain browser source of truth");
assert.ok(await exists(path.join(ROOT_DIR, "web", "flow.ts")), "web/flow.ts must remain browser source of truth");

const jsFiles = await collect(ROOT_DIR);
const projectOwnedJs = jsFiles.filter((file) => !ALLOWED_JS_PREFIXES.some((prefix) => file.startsWith(`${prefix}${path.sep}`)));
assert.deepEqual(
  projectOwnedJs.map((file) => path.relative(ROOT_DIR, file)).sort(),
  [],
  "project-owned JS/MJS source files are not allowed; build output belongs under .generated/web",
);

const generated = jsFiles.map((file) => path.relative(ROOT_DIR, file)).sort();
assert.ok(generated.includes(path.join(".generated", "web", "app.js")), "web build should emit .generated/web/app.js");
assert.ok(generated.includes(path.join(".generated", "web", "flow.js")), "web build should emit .generated/web/flow.js");

console.log("ok - generated JS boundary");

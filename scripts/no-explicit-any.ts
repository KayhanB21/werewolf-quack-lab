#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SKIP_DIRS = new Set([".generated", "node_modules", "runs", ".venv"]);
const token = `${"a"}${"ny"}`;
const forbidden = [
  new RegExp(`:\\s*${token}\\b`, "u"),
  new RegExp(`\\bas\\s+${token}\\b`, "u"),
  new RegExp(`<\\s*${token}\\s*>`, "u"),
  new RegExp(`\\bArray\\s*<\\s*${token}\\s*>`, "u"),
];

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await collectTsFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const failures: string[] = [];
for (const file of await collectTsFiles(ROOT_DIR)) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (forbidden.some((pattern) => pattern.test(line))) {
      failures.push(`${path.relative(ROOT_DIR, file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.error("ok - no explicit loose type escapes");

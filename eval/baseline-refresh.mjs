#!/usr/bin/env node
// Regenerate or verify eval/baselines/fixtures.json from eval/fixtures/.
//
// Usage:
//   node eval/baseline-refresh.mjs           # rewrite the baseline file
//   node eval/baseline-refresh.mjs --check   # exit non-zero if it would change

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, loadGameLogs } from "./aggregate.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURES_DIR = path.join(ROOT_DIR, "eval", "fixtures");
const BASELINE_PATH = path.join(ROOT_DIR, "eval", "baselines", "fixtures.json");

function stripVolatile(sc) {
  delete sc.meta.generated_at;
  for (const g of sc.per_game) delete g.path;
  return sc;
}

const games = await loadGameLogs(FIXTURES_DIR);
if (games.length === 0) {
  console.error(`no fixtures found at ${FIXTURES_DIR}`);
  process.exit(2);
}
const next = `${JSON.stringify(stripVolatile(aggregate(games)), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(BASELINE_PATH, "utf8").catch(() => "");
  if (current === next) {
    console.error(`ok - ${path.relative(ROOT_DIR, BASELINE_PATH)} matches aggregator output`);
    process.exit(0);
  }
  console.error(`drift detected in ${path.relative(ROOT_DIR, BASELINE_PATH)}`);
  console.error(`run: node eval/baseline-refresh.mjs   (or: make baseline-refresh)`);
  process.exit(1);
}

await writeFile(BASELINE_PATH, next);
console.error(`wrote ${path.relative(ROOT_DIR, BASELINE_PATH)}`);

#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapBinaryCi, buildReport, discoverRuns, formatMarkdown } from "../eval/report.ts";

const ci = bootstrapBinaryCi([1, 0, 1, 1], { iterations: 20, seed: 1 });
assert.equal(ci.n, 4);
assert.equal(ci.mean, 0.75);
assert.ok(ci.low >= 0 && ci.low <= 1);
assert.ok(ci.high >= 0 && ci.high <= 1);

const tmp = await mkdtemp(join(tmpdir(), "eval-report-"));
try {
  const runDir = join(tmp, "omlx-mini");
  await writeFile(join(tmp, "ignore.txt"), "");
  await mkdir(runDir);
  await writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify({ run_id: "r1", scenario_id: "local-core", provider: "omlx", model: "qwen" }),
  );
  await writeFile(
    join(runDir, "scorecard.json"),
    JSON.stringify({
      meta: { game_count: 2, completed_game_count: 2, providers: ["omlx"], models: ["qwen"] },
      prompt_following: { valid_json_rate: 1, target_override_rate: 0 },
      game_shape: { village_winrate: 0.5 },
      strategy: { town_vote_accuracy: 0.5 },
      trust_dynamics: { wolf_town_suspicion_gap: 0.25 },
      deception: { deception_production_rate: null, deception_detection_f1: null },
      performance: {
        p95_latency_ms: 10,
        total_prompt_tokens: 100,
        total_completion_tokens: 50,
        total_reasoning_tokens: 25,
      },
      per_game: [
        { completed: true, winner: "village" },
        { completed: true, winner: "wolves" },
      ],
    }),
  );
  const runs = await discoverRuns([tmp]);
  assert.equal(runs.length, 1);
  const report = buildReport(runs);
  assert.equal(report.run_count, 1);
  assert.equal(report.rows[0].total_tokens, 175);
  const md = formatMarkdown(report);
  assert.match(md, /Werewolf Eval Comparison/);
  assert.match(md, /local-core/);
  await writeFile(join(tmp, "report.md"), md);
  assert.match(await readFile(join(tmp, "report.md"), "utf8"), /Town vote acc/);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("ok - eval-report");

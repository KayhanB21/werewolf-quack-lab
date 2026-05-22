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
  const runDir2 = join(tmp, "omlx-hot");
  await writeFile(join(tmp, "ignore.txt"), "");
  await mkdir(runDir);
  await mkdir(runDir2);
  await writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify({ run_id: "r1", profile_name: "omlx-mini", scenario_id: "local-core", provider: "omlx", model: "qwen" }),
  );
  await writeFile(join(runDir, "gates.json"), JSON.stringify({ pass: true, hard_failures: [] }));
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
  await writeFile(
    join(runDir2, "manifest.json"),
    JSON.stringify({ run_id: "r2", profile_name: "omlx-hot", scenario_id: "hot", provider: "omlx", model: "qwen" }),
  );
  await writeFile(join(runDir2, "gates.json"), JSON.stringify({ pass: false, hard_failures: [{ label: "valid_json_rate_min" }] }));
  await writeFile(
    join(runDir2, "scorecard.json"),
    JSON.stringify({
      meta: { game_count: 2, completed_game_count: 2, providers: ["omlx"], models: ["qwen"] },
      prompt_following: { valid_json_rate: 0.8, target_override_rate: 0.1 },
      game_shape: { village_winrate: 1 },
      strategy: { town_vote_accuracy: 0.75 },
      trust_dynamics: { wolf_town_suspicion_gap: 0.5 },
      deception: { deception_production_rate: 0.5, deception_detection_f1: 0.25 },
      performance: {
        p95_latency_ms: 20,
        total_prompt_tokens: 200,
        total_completion_tokens: 50,
        total_reasoning_tokens: 50,
      },
      per_game: [
        { completed: true, winner: "village" },
        { completed: true, winner: "village" },
      ],
    }),
  );
  const runs = await discoverRuns([tmp]);
  assert.equal(runs.length, 2);
  const report = buildReport(runs);
  assert.equal(report.run_count, 2);
  const row1 = report.rows.find((row) => row.run === "r1");
  const row2 = report.rows.find((row) => row.run === "r2");
  assert.ok(row1);
  assert.ok(row2);
  assert.equal(row1.total_tokens, 175);
  assert.equal(row1.gates, "pass");
  assert.equal(row2.gates, "fail");
  assert.equal(row1.delta_village_winrate, -0.5);
  assert.equal(row2.delta_village_winrate, 0);
  const md = formatMarkdown(report);
  assert.match(md, /Werewolf Eval Comparison/);
  assert.match(md, /local-core/);
  assert.match(md, /\| r2 \| hot \| omlx \| fail \| 2\/2 \| 80\.0%/);
  assert.match(md, /-50\.0%/);
  await writeFile(join(tmp, "report.md"), md);
  assert.match(await readFile(join(tmp, "report.md"), "utf8"), /Town vote acc/);

  const normalized = {
    ...report,
    generated_at: "<generated>",
    rows: report.rows.map((row) => ({
      run: row.run,
      scenario: row.scenario,
      profile: row.profile,
      provider: row.provider,
      gates: row.gates,
      completed: row.completed,
      valid_json_rate: row.valid_json_rate,
      delta_village_winrate: row.delta_village_winrate,
    })).sort((a, b) => a.run.localeCompare(b.run)),
  };
  assert.deepEqual(normalized, {
    generated_at: "<generated>",
    run_count: 2,
    rows: [
      {
        run: "r1",
        scenario: "local-core",
        profile: "omlx-mini",
        provider: "omlx",
        gates: "pass",
        completed: 2,
        valid_json_rate: 1,
        delta_village_winrate: -0.5,
      },
      {
        run: "r2",
        scenario: "hot",
        profile: "omlx-hot",
        provider: "omlx",
        gates: "fail",
        completed: 2,
        valid_json_rate: 0.8,
        delta_village_winrate: 0,
      },
    ],
  });
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("ok - eval-report");

#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function pct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function num(n, digits = 2) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

function seededRand(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function bootstrapBinaryCi(values, { iterations = 500, seed = 0x51f15e } = {}) {
  const xs = values.filter((v) => v === 0 || v === 1);
  if (xs.length === 0) return { mean: 0, low: 0, high: 0, n: 0 };
  const rand = seededRand(seed);
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < xs.length; j += 1) {
      sum += xs[Math.floor(rand() * xs.length)];
    }
    samples.push(sum / xs.length);
  }
  samples.sort((a, b) => a - b);
  return { mean: mean(xs), low: quantile(samples, 0.025), high: quantile(samples, 0.975), n: xs.length };
}

async function loadRun(dir) {
  const scorecard = JSON.parse(await readFile(path.join(dir, "scorecard.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "{}"));
  const villageValues = (scorecard.per_game || [])
    .filter((g) => g.completed)
    .map((g) => (g.winner === "village" ? 1 : 0));
  const wolvesValues = (scorecard.per_game || [])
    .filter((g) => g.completed)
    .map((g) => (g.winner === "wolves" || g.winner === "wolf" ? 1 : 0));
  return {
    dir,
    manifest,
    scorecard,
    ci: {
      village_winrate: bootstrapBinaryCi(villageValues),
      wolves_winrate: bootstrapBinaryCi(wolvesValues),
    },
  };
}

export async function discoverRuns(targets) {
  const dirs = [];
  for (const target of targets) {
    let info;
    try {
      info = await stat(target);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const scorecardPath = path.join(target, "scorecard.json");
      try {
        await stat(scorecardPath);
        dirs.push(target);
        continue;
      } catch {
        // maybe parent of run dirs
      }
      for (const name of await readdir(target)) {
        const child = path.join(target, name);
        try {
          const childInfo = await stat(child);
          if (!childInfo.isDirectory()) continue;
          await stat(path.join(child, "scorecard.json"));
          dirs.push(child);
        } catch {
          // ignore non-run children
        }
      }
    }
  }
  dirs.sort();
  return Promise.all(dirs.map(loadRun));
}

export function buildReport(runs) {
  const rows = runs.map((run) => {
    const sc = run.scorecard;
    return {
      run: run.manifest.run_id || path.basename(run.dir),
      scenario: run.manifest.scenario_id || run.manifest.profile_name || "",
      provider: sc.meta.providers.join(",") || run.manifest.provider || "",
      model: sc.meta.models.join(",") || run.manifest.model || "",
      games: sc.meta.game_count,
      completed: sc.meta.completed_game_count,
      valid_json_rate: sc.prompt_following.valid_json_rate,
      target_override_rate: sc.prompt_following.target_override_rate,
      village_winrate: sc.game_shape.village_winrate,
      village_winrate_ci: run.ci.village_winrate,
      deception_production_rate: sc.deception.deception_production_rate,
      deception_detection_f1: sc.deception.deception_detection_f1,
      town_vote_accuracy: sc.strategy?.town_vote_accuracy ?? 0,
      suspicion_gap: sc.trust_dynamics?.wolf_town_suspicion_gap ?? 0,
      p95_latency_ms: sc.performance.p95_latency_ms,
      total_tokens:
        sc.performance.total_prompt_tokens +
        sc.performance.total_completion_tokens +
        sc.performance.total_reasoning_tokens,
    };
  });
  return { generated_at: new Date().toISOString(), run_count: rows.length, rows };
}

export function formatMarkdown(report) {
  const lines = [];
  lines.push("# Werewolf Eval Comparison");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push(
    "| Run | Scenario | Provider | Games | JSON | Override | Village winrate | Town vote acc. | Deception F1 | Suspicion gap | p95 latency | Tokens |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of report.rows) {
    const ci = r.village_winrate_ci;
    const village = `${pct(r.village_winrate)} [${pct(ci.low)}, ${pct(ci.high)}]`;
    lines.push(
      `| ${r.run} | ${r.scenario} | ${r.provider} | ${r.completed}/${r.games} | ${pct(r.valid_json_rate)} | ${pct(r.target_override_rate)} | ${village} | ${pct(r.town_vote_accuracy)} | ${pct(r.deception_detection_f1)} | ${num(r.suspicion_gap, 3)} | ${r.p95_latency_ms} | ${r.total_tokens} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: eval/report.mjs <run-dir|runs-parent>... [--out report.md] [--json report.json]");
    process.exit(2);
  }
  const outIdx = args.indexOf("--out");
  const jsonIdx = args.indexOf("--json");
  const targets = args.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1 && i !== jsonIdx + 1);
  const runs = await discoverRuns(targets);
  if (runs.length === 0) {
    console.error("report: no run directories with scorecard.json found");
    process.exit(1);
  }
  const report = buildReport(runs);
  const markdown = formatMarkdown(report);
  if (outIdx >= 0) await writeFile(args[outIdx + 1], `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
  if (jsonIdx >= 0) await writeFile(args[jsonIdx + 1], `${JSON.stringify(report, null, 2)}\n`);
}

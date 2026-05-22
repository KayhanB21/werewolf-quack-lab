#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { aggregate } from "./aggregate.ts";

type Scorecard = ReturnType<typeof aggregate>;
type ConfidenceInterval = { mean: number; low: number; high: number; n: number };
type RunSummary = {
  dir: string;
  manifest: Record<string, unknown>;
  scorecard: Scorecard;
  gates: Record<string, unknown> | null;
  ci: {
    village_winrate: ConfidenceInterval;
    wolves_winrate: ConfidenceInterval;
  };
};
type ReportRow = {
  run: string;
  scenario: string;
  profile: string;
  provider: string;
  model: string;
  gates: string;
  games: number;
  completed: number;
  valid_json_rate: number;
  target_override_rate: number;
  village_winrate: number;
  delta_village_winrate: number;
  village_winrate_ci: ConfidenceInterval;
  deception_production_rate: number | null;
  deception_detection_f1: number | null;
  town_vote_accuracy: number;
  suspicion_gap: number;
  p95_latency_ms: number;
  total_tokens: number;
};
type ComparisonReport = {
  generated_at: string;
  run_count: number;
  rows: ReportRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function pct(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function num(n: unknown, digits = 2): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

function seededRand(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function bootstrapBinaryCi(
  values: number[],
  { iterations = 500, seed = 0x51f15e }: { iterations?: number; seed?: number } = {},
): ConfidenceInterval {
  const xs = values.filter((v) => v === 0 || v === 1);
  if (xs.length === 0) return { mean: 0, low: 0, high: 0, n: 0 };
  const rand = seededRand(seed);
  const samples: number[] = [];
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

async function loadRun(dir: string): Promise<RunSummary> {
  const scorecard = JSON.parse(await readFile(path.join(dir, "scorecard.json"), "utf8")) as Scorecard;
  const parsedManifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8").catch(() => "{}")) as unknown;
  const manifest = isRecord(parsedManifest) ? parsedManifest : {};
  const parsedGates = JSON.parse(await readFile(path.join(dir, "gates.json"), "utf8").catch(() => "null")) as unknown;
  const gates = isRecord(parsedGates) ? parsedGates : null;
  const villageValues = (scorecard.per_game || [])
    .filter((g: Scorecard["per_game"][number]) => g.completed)
    .map((g: Scorecard["per_game"][number]) => (g.winner === "village" ? 1 : 0));
  const wolvesValues = (scorecard.per_game || [])
    .filter((g: Scorecard["per_game"][number]) => g.completed)
    .map((g: Scorecard["per_game"][number]) => (g.winner === "wolves" || g.winner === "wolf" ? 1 : 0));
  return {
    dir,
    manifest,
    scorecard,
    gates,
    ci: {
      village_winrate: bootstrapBinaryCi(villageValues),
      wolves_winrate: bootstrapBinaryCi(wolvesValues),
    },
  };
}

export async function discoverRuns(targets: string[]): Promise<RunSummary[]> {
  const dirs: string[] = [];
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

export function buildReport(runs: RunSummary[]): ComparisonReport {
  const baseVillageWinrate = runs[0]?.scorecard.game_shape.village_winrate ?? 0;
  const rows = runs.map((run) => {
    const sc = run.scorecard;
    const gatesPass = typeof run.gates?.pass === "boolean" ? (run.gates.pass ? "pass" : "fail") : "n/a";
    return {
      run: str(run.manifest.run_id || path.basename(run.dir)),
      scenario: str(run.manifest.scenario_id || run.manifest.profile_name || ""),
      profile: str(run.manifest.profile_name || ""),
      provider: str(sc.meta.providers.join(",") || run.manifest.provider || ""),
      model: str(sc.meta.models.join(",") || run.manifest.model || ""),
      gates: gatesPass,
      games: sc.meta.game_count,
      completed: sc.meta.completed_game_count,
      valid_json_rate: sc.prompt_following.valid_json_rate,
      target_override_rate: sc.prompt_following.target_override_rate,
      village_winrate: sc.game_shape.village_winrate,
      delta_village_winrate: sc.game_shape.village_winrate - baseVillageWinrate,
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

export function formatMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push("# Werewolf Eval Comparison");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push("");
  lines.push(
    "| Run | Scenario | Provider | Gates | Games | JSON | Override | Village winrate | Delta | Town vote acc. | Deception F1 | Suspicion gap | p95 latency | Tokens |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of report.rows) {
    const ci = r.village_winrate_ci;
    const village = `${pct(r.village_winrate)} [${pct(ci.low)}, ${pct(ci.high)}]`;
    const delta = `${r.delta_village_winrate >= 0 ? "+" : ""}${pct(r.delta_village_winrate)}`;
    lines.push(
      `| ${r.run} | ${r.scenario} | ${r.provider} | ${r.gates} | ${r.completed}/${r.games} | ${pct(r.valid_json_rate)} | ${pct(r.target_override_rate)} | ${village} | ${delta} | ${pct(r.town_vote_accuracy)} | ${pct(r.deception_detection_f1)} | ${num(r.suspicion_gap, 3)} | ${r.p95_latency_ms} | ${r.total_tokens} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: eval/report.ts <run-dir|runs-parent>... [--out report.md] [--json report.json]");
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
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  if (outPath) await writeFile(outPath, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}

#!/usr/bin/env node
// Hard and soft regression gates for eval scorecards.
//
// Hard gates fail the run (exit non-zero). Soft gates only warn.
//
// Profiles can override defaults via a `gates` block, e.g.:
//   "gates": {
//     "valid_json_rate_min": 0.85,
//     "action_in_phase_rate_min": 0.95,
//     "http_error_rate_max": 0.10,
//     "skip": false
//   }
// The stub profile sets stricter floors because the scripted path is
// deterministic; hosted-model profiles loosen them.

import { readFile, writeFile } from "node:fs/promises";

export const DEFAULT_GATES = Object.freeze({
  valid_json_rate_min: 0.85,
  action_in_phase_rate_min: 0.95,
  http_error_rate_max: 0.10,
  incomplete_rate_max: 0.20,
  belief_emit_rate_min: 0.0,
  village_winrate_band: null,
  avg_rounds_band: null,
  skip: false,
});

// Derive default soft bands from a committed baseline scorecard.
// Tolerances mirror the eval-plan: ±0.20 for winrate, ±2 rounds, ±0.15 for
// belief_emit. A profile.gates entry always wins over a derived band.
export function deriveBandsFromBaseline(baseline) {
  if (!baseline || typeof baseline !== "object") return {};
  const out = {};
  const village = baseline.game_shape?.village_winrate;
  if (typeof village === "number") out.village_winrate_band = [village, 0.2];
  const rounds = baseline.game_shape?.avg_rounds;
  if (typeof rounds === "number") out.avg_rounds_band = [rounds, 2];
  const belief = baseline.belief_quality?.belief_emit_rate;
  if (typeof belief === "number") out.belief_emit_rate_min = Math.max(0, belief - 0.15);
  return out;
}

function gte(actual, floor) {
  return typeof actual === "number" && actual >= floor;
}
function lte(actual, ceiling) {
  return typeof actual === "number" && actual <= ceiling;
}

function bandFailure(label, actual, band) {
  if (!band || typeof actual !== "number") return null;
  const [center, tolerance] = band;
  if (Math.abs(actual - center) <= tolerance) return null;
  return { label, actual, expected: center, tolerance };
}

export function evaluateGates(scorecard, profileGates, opts = {}) {
  const derived = opts.baseline ? deriveBandsFromBaseline(opts.baseline) : {};
  // precedence: profile > derived-from-baseline > defaults
  const gates = { ...DEFAULT_GATES, ...derived, ...(profileGates || {}) };
  if (gates.skip) {
    return { pass: true, skipped: true, hard_failures: [], soft_warnings: [], gates };
  }

  const pf = scorecard.prompt_following || {};
  const gs = scorecard.game_shape || {};
  const bq = scorecard.belief_quality || {};

  const hard_failures = [];
  const soft_warnings = [];

  if (!gte(pf.valid_json_rate, gates.valid_json_rate_min)) {
    hard_failures.push({
      label: "valid_json_rate_min",
      actual: pf.valid_json_rate,
      threshold: gates.valid_json_rate_min,
    });
  }
  if (!gte(pf.action_in_phase_rate, gates.action_in_phase_rate_min)) {
    hard_failures.push({
      label: "action_in_phase_rate_min",
      actual: pf.action_in_phase_rate,
      threshold: gates.action_in_phase_rate_min,
    });
  }
  if (!lte(pf.http_error_rate, gates.http_error_rate_max)) {
    hard_failures.push({
      label: "http_error_rate_max",
      actual: pf.http_error_rate,
      threshold: gates.http_error_rate_max,
    });
  }
  if (!lte(gs.incomplete_rate, gates.incomplete_rate_max)) {
    hard_failures.push({
      label: "incomplete_rate_max",
      actual: gs.incomplete_rate,
      threshold: gates.incomplete_rate_max,
    });
  }

  if (gates.belief_emit_rate_min > 0 && !gte(bq.belief_emit_rate, gates.belief_emit_rate_min)) {
    soft_warnings.push({
      label: "belief_emit_rate_min",
      actual: bq.belief_emit_rate,
      threshold: gates.belief_emit_rate_min,
    });
  }

  const villageBand = bandFailure("village_winrate_band", gs.village_winrate, gates.village_winrate_band);
  if (villageBand) soft_warnings.push(villageBand);
  const roundsBand = bandFailure("avg_rounds_band", gs.avg_rounds, gates.avg_rounds_band);
  if (roundsBand) soft_warnings.push(roundsBand);

  return { pass: hard_failures.length === 0, skipped: false, hard_failures, soft_warnings, gates };
}

export function formatGateReport(report) {
  if (report.skipped) return "gates: skipped (profile sets gates.skip = true)";
  const lines = [];
  lines.push(`gates: ${report.pass ? "PASS" : "FAIL"} (${report.hard_failures.length} hard, ${report.soft_warnings.length} soft)`);
  for (const h of report.hard_failures) {
    lines.push(`  HARD ${h.label}: actual=${formatNum(h.actual)} threshold=${formatNum(h.threshold)}`);
  }
  for (const s of report.soft_warnings) {
    if ("threshold" in s) {
      lines.push(`  soft ${s.label}: actual=${formatNum(s.actual)} threshold=${formatNum(s.threshold)}`);
    } else {
      lines.push(`  soft ${s.label}: actual=${formatNum(s.actual)} expected=${formatNum(s.expected)} ±${formatNum(s.tolerance)}`);
    }
  }
  return lines.join("\n");
}

function formatNum(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "usage: gates.mjs <scorecard.json> [--profile profile.json] [--baseline baseline.json] [--out report.json]",
    );
    process.exit(2);
  }
  const scorecardPath = args.find((a) => !a.startsWith("--"));
  const profileIdx = args.indexOf("--profile");
  const baselineIdx = args.indexOf("--baseline");
  const outIdx = args.indexOf("--out");

  const scorecard = JSON.parse(await readFile(scorecardPath, "utf8"));
  const profile = profileIdx >= 0 ? JSON.parse(await readFile(args[profileIdx + 1], "utf8")) : {};
  const baseline = baselineIdx >= 0 ? JSON.parse(await readFile(args[baselineIdx + 1], "utf8")) : null;
  const report = evaluateGates(scorecard, profile.gates, { baseline });

  if (outIdx >= 0) {
    await writeFile(args[outIdx + 1], `${JSON.stringify(report, null, 2)}\n`);
  }
  console.error(formatGateReport(report));
  process.exit(report.pass ? 0 : 1);
}

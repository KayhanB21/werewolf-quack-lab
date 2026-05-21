#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const KNOWN_PARSE_PATHS = ["stub", "object", "text", "http-error", "pending"];

export function parseGameLog(jsonlText) {
  const events = [];
  if (!jsonlText) return events;
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt && typeof evt === "object" && typeof evt.kind === "string") {
        events.push(evt);
      }
    } catch {
      // skip malformed lines silently — log corruption shouldn't crash the eval
    }
  }
  return events;
}

export async function loadGameLogs(target) {
  const info = await stat(target);
  const files = [];
  if (info.isDirectory()) {
    for (const name of await readdir(target)) {
      if (name.endsWith(".jsonl")) {
        files.push(path.join(target, name));
      }
    }
    files.sort();
  } else {
    files.push(target);
  }
  const games = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const events = parseGameLog(text);
    if (events.length > 0) {
      games.push({ path: file, events });
    }
  }
  return games;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function mean(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function rate(numerator, denominator) {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

function bumpHist(hist, key) {
  const k = key || "(empty)";
  hist[k] = (hist[k] || 0) + 1;
}

// Coerce any numeric input to a finite, non-negative number. Used at the
// turn-stats boundary so that hostile or buggy upstream values (NaN,
// Infinity, negatives) cannot poison aggregate metrics.
function safeNonNegative(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function summarizeGame(events) {
  const out = {
    game_id: "",
    provider: "",
    model: "",
    players: [],
    roles: {},
    turn_stats: [],
    rounds_played: 0,
    winner: "",
    reason: "",
    lynch_count: 0,
    no_lynch_count: 0,
    wolf_kill_count: 0,
    wolf_saved_count: 0,
    no_kill_count: 0,
    seer_learns: [],
    seer_targeted_wolf_count: 0,
    seer_targeted_total: 0,
    completed: false,
  };

  for (const evt of events) {
    switch (evt.kind) {
      case "game-start":
        out.game_id = String(evt.game_id || "");
        out.provider = String(evt.provider || "");
        out.model = String(evt.model || "");
        if (Array.isArray(evt.players)) {
          out.players = evt.players.map((p) => ({ id: String(p.id), role: String(p.role) }));
          for (const p of out.players) {
            out.roles[p.id] = p.role;
          }
        }
        break;
      case "turn-stats":
        out.turn_stats.push(evt);
        break;
      case "round-start":
        out.rounds_played = Math.max(out.rounds_played, Number(evt.round) || 0);
        break;
      case "lynch":
        out.lynch_count += 1;
        break;
      case "no-lynch":
        out.no_lynch_count += 1;
        break;
      case "wolf-kill":
        out.wolf_kill_count += 1;
        break;
      case "wolf-saved":
        out.wolf_saved_count += 1;
        break;
      case "no-kill":
        out.no_kill_count += 1;
        break;
      case "seer-learn": {
        out.seer_learns.push(evt);
        const targetRole = out.roles[evt.target] || evt.role || "";
        out.seer_targeted_total += 1;
        if (targetRole === "wolf") out.seer_targeted_wolf_count += 1;
        break;
      }
      case "game-end":
        out.winner = String(evt.winner || "");
        out.reason = String(evt.reason || "");
        out.completed = true;
        if (typeof evt.rounds === "number") {
          out.rounds_played = evt.rounds;
        }
        break;
      default:
        // ignore unknown event kinds for forward-compatibility
        break;
    }
  }

  return out;
}

export function aggregate(games) {
  const scorecard = {
    meta: {
      generated_at: new Date().toISOString(),
      game_count: games.length,
      completed_game_count: 0,
      providers: new Set(),
      models: new Set(),
    },
    prompt_following: {
      total_turns: 0,
      valid_json_rate: 0,
      action_in_phase_rate: 0,
      http_error_rate: 0,
      parse_path_histogram: {},
      finish_reason_histogram: {},
      raw_action_histogram: {},
    },
    game_shape: {
      village_winrate: 0,
      wolves_winrate: 0,
      incomplete_rate: 0,
      avg_rounds: 0,
      rounds_histogram: {},
      lynch_rate_per_day: 0,
      night_saved_rate: 0,
      no_kill_rate: 0,
    },
    belief_quality: {
      belief_emit_rate: 0,
      avg_suspicions_per_turn: 0,
      avg_knowledge_per_turn: 0,
      seer_targeting_wolf_rate: 0,
    },
    performance: {
      avg_latency_ms: 0,
      p50_latency_ms: 0,
      p95_latency_ms: 0,
      avg_prompt_tokens: 0,
      avg_completion_tokens: 0,
      avg_reasoning_tokens: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_reasoning_tokens: 0,
    },
    per_game: [],
  };

  const validJson = [];
  const inPhase = [];
  const httpErrors = [];
  const latencies = [];
  const promptTokens = [];
  const completionTokens = [];
  const reasoningTokens = [];
  const suspicionsPerTurn = [];
  const knowledgePerTurn = [];
  const beliefEmitFlags = [];

  let totalDays = 0;
  let totalNights = 0;
  let villageWins = 0;
  let wolfWins = 0;
  let completed = 0;
  let totalRoundsCompleted = 0;
  let seerWolf = 0;
  let seerTotal = 0;

  for (const { events, path: gamePath } of games) {
    const game = summarizeGame(events);
    if (game.provider) scorecard.meta.providers.add(game.provider);
    if (game.model) scorecard.meta.models.add(game.model);
    if (game.completed) {
      completed += 1;
      totalRoundsCompleted += game.rounds_played;
      bumpHist(scorecard.game_shape.rounds_histogram, String(game.rounds_played));
      if (game.winner === "village") villageWins += 1;
      else if (game.winner === "wolves" || game.winner === "wolf") wolfWins += 1;
    }
    totalDays += game.lynch_count + game.no_lynch_count;
    totalNights += game.wolf_kill_count + game.wolf_saved_count + game.no_kill_count;
    seerTotal += game.seer_targeted_total;
    seerWolf += game.seer_targeted_wolf_count;

    for (const ts of game.turn_stats) {
      scorecard.prompt_following.total_turns += 1;
      validJson.push(ts.valid_json === true ? 1 : 0);
      inPhase.push(ts.action_in_phase === true ? 1 : 0);
      httpErrors.push(ts.parse_path === "http-error" || ts.http_status === "error" ? 1 : 0);
      bumpHist(scorecard.prompt_following.parse_path_histogram, ts.parse_path);
      bumpHist(scorecard.prompt_following.finish_reason_histogram, ts.finish_reason);
      bumpHist(scorecard.prompt_following.raw_action_histogram, ts.raw_action || ts.normalized_action);

      const lat = safeNonNegative(ts.latency_ms);
      if (lat > 0) latencies.push(lat);
      const pt = safeNonNegative(ts.tokens?.prompt);
      const ct = safeNonNegative(ts.tokens?.completion);
      const rt = safeNonNegative(ts.tokens?.reasoning);
      if (pt > 0 || ct > 0 || rt > 0) {
        promptTokens.push(pt);
        completionTokens.push(ct);
        reasoningTokens.push(rt);
      }
      const sc = safeNonNegative(ts.suspicions_count);
      const kc = safeNonNegative(ts.knowledge_count);
      suspicionsPerTurn.push(sc);
      knowledgePerTurn.push(kc);
      beliefEmitFlags.push(sc + kc > 0 ? 1 : 0);
    }

    scorecard.per_game.push({
      path: gamePath,
      game_id: game.game_id,
      provider: game.provider,
      model: game.model,
      completed: game.completed,
      winner: game.winner,
      reason: game.reason,
      rounds: game.rounds_played,
      lynches: game.lynch_count,
      no_lynches: game.no_lynch_count,
      wolf_kills: game.wolf_kill_count,
      wolf_saved: game.wolf_saved_count,
      no_kill: game.no_kill_count,
      seer_learns: game.seer_learns.length,
      seer_targeted_wolf: game.seer_targeted_wolf_count,
      turn_count: game.turn_stats.length,
    });
  }

  scorecard.meta.completed_game_count = completed;
  scorecard.meta.providers = [...scorecard.meta.providers];
  scorecard.meta.models = [...scorecard.meta.models];

  scorecard.prompt_following.valid_json_rate = rate(validJson.reduce((a, b) => a + b, 0), validJson.length);
  scorecard.prompt_following.action_in_phase_rate = rate(inPhase.reduce((a, b) => a + b, 0), inPhase.length);
  scorecard.prompt_following.http_error_rate = rate(httpErrors.reduce((a, b) => a + b, 0), httpErrors.length);

  scorecard.game_shape.village_winrate = rate(villageWins, completed);
  scorecard.game_shape.wolves_winrate = rate(wolfWins, completed);
  scorecard.game_shape.incomplete_rate = rate(games.length - completed, games.length);
  scorecard.game_shape.avg_rounds = completed > 0 ? totalRoundsCompleted / completed : 0;
  scorecard.game_shape.lynch_rate_per_day = rate(
    scorecard.per_game.reduce((a, g) => a + g.lynches, 0),
    totalDays,
  );
  scorecard.game_shape.night_saved_rate = rate(
    scorecard.per_game.reduce((a, g) => a + g.wolf_saved, 0),
    totalNights,
  );
  scorecard.game_shape.no_kill_rate = rate(
    scorecard.per_game.reduce((a, g) => a + g.no_kill, 0),
    totalNights,
  );

  scorecard.belief_quality.belief_emit_rate = rate(
    beliefEmitFlags.reduce((a, b) => a + b, 0),
    beliefEmitFlags.length,
  );
  scorecard.belief_quality.avg_suspicions_per_turn = mean(suspicionsPerTurn);
  scorecard.belief_quality.avg_knowledge_per_turn = mean(knowledgePerTurn);
  scorecard.belief_quality.seer_targeting_wolf_rate = rate(seerWolf, seerTotal);

  const sortedLat = latencies.slice().sort((a, b) => a - b);
  scorecard.performance.avg_latency_ms = Math.round(mean(latencies));
  scorecard.performance.p50_latency_ms = Math.round(quantile(sortedLat, 0.5));
  scorecard.performance.p95_latency_ms = Math.round(quantile(sortedLat, 0.95));
  scorecard.performance.avg_prompt_tokens = Math.round(mean(promptTokens));
  scorecard.performance.avg_completion_tokens = Math.round(mean(completionTokens));
  scorecard.performance.avg_reasoning_tokens = Math.round(mean(reasoningTokens));
  scorecard.performance.total_prompt_tokens = promptTokens.reduce((a, b) => a + b, 0);
  scorecard.performance.total_completion_tokens = completionTokens.reduce((a, b) => a + b, 0);
  scorecard.performance.total_reasoning_tokens = reasoningTokens.reduce((a, b) => a + b, 0);

  return scorecard;
}

export function formatScorecardSummary(scorecard) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const lines = [];
  lines.push(`games: ${scorecard.meta.completed_game_count}/${scorecard.meta.game_count} completed`);
  lines.push(`providers: ${scorecard.meta.providers.join(", ") || "(none)"}`);
  lines.push(`models: ${scorecard.meta.models.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("prompt-following:");
  lines.push(`  valid_json_rate     = ${pct(scorecard.prompt_following.valid_json_rate)}`);
  lines.push(`  action_in_phase     = ${pct(scorecard.prompt_following.action_in_phase_rate)}`);
  lines.push(`  http_error_rate     = ${pct(scorecard.prompt_following.http_error_rate)}`);
  lines.push(`  parse_paths         = ${JSON.stringify(scorecard.prompt_following.parse_path_histogram)}`);
  lines.push("game-shape:");
  lines.push(`  village_winrate     = ${pct(scorecard.game_shape.village_winrate)}`);
  lines.push(`  wolves_winrate      = ${pct(scorecard.game_shape.wolves_winrate)}`);
  lines.push(`  incomplete_rate     = ${pct(scorecard.game_shape.incomplete_rate)}`);
  lines.push(`  avg_rounds          = ${scorecard.game_shape.avg_rounds.toFixed(2)}`);
  lines.push(`  night_saved_rate    = ${pct(scorecard.game_shape.night_saved_rate)}`);
  lines.push(`  no_kill_rate        = ${pct(scorecard.game_shape.no_kill_rate)}`);
  lines.push("belief-quality:");
  lines.push(`  belief_emit_rate    = ${pct(scorecard.belief_quality.belief_emit_rate)}`);
  lines.push(`  seer_targets_wolf   = ${pct(scorecard.belief_quality.seer_targeting_wolf_rate)}`);
  lines.push("performance:");
  lines.push(`  avg_latency_ms      = ${scorecard.performance.avg_latency_ms}`);
  lines.push(`  p95_latency_ms      = ${scorecard.performance.p95_latency_ms}`);
  lines.push(`  avg_prompt_tokens   = ${scorecard.performance.avg_prompt_tokens}`);
  lines.push(`  avg_completion_tk   = ${scorecard.performance.avg_completion_tokens}`);
  lines.push(`  avg_reasoning_tk    = ${scorecard.performance.avg_reasoning_tokens}`);
  return lines.join("\n");
}

export { KNOWN_PARSE_PATHS };

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: eval-aggregate.mjs <path-to-jsonl-or-dir> [--out scorecard.json] [--summary-only]");
    process.exit(2);
  }
  const targetIdx = args.findIndex((a) => !a.startsWith("--"));
  const target = args[targetIdx];
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const summaryOnly = args.includes("--summary-only");

  const games = await loadGameLogs(target);
  if (games.length === 0) {
    console.error(`no game logs found at ${target}`);
    process.exit(1);
  }
  const scorecard = aggregate(games);
  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(scorecard, null, 2)}\n`);
    console.error(`wrote ${outPath}`);
  } else if (!summaryOnly) {
    process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  }
  console.error("");
  console.error(formatScorecardSummary(scorecard));
}

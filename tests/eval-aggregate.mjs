#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregate,
  formatScorecardSummary,
  loadGameLogs,
  parseGameLog,
  summarizeGame,
} from "../eval/aggregate.mjs";

// === unit: parseGameLog ===
assert.deepEqual(parseGameLog(""), []);
assert.deepEqual(parseGameLog("\n   \n"), []);
const parsed = parseGameLog(
  [
    '{"ts":"2026-05-19T00:00:00Z","kind":"game-start","game_id":"g1","provider":"stub"}',
    "not json",
    '{"kind":"round-start","round":1}',
    "",
    '{"missing":"kind"}',
  ].join("\n"),
);
assert.equal(parsed.length, 2);
assert.equal(parsed[0].kind, "game-start");
assert.equal(parsed[1].round, 1);

// === unit: summarizeGame ===
const fixtureEvents = [
  {
    ts: "2026-05-19T00:00:00Z",
    kind: "game-start",
    game_id: "g1",
    provider: "omlx",
    model: "qwen",
    players: [
      { id: "p1", role: "wolf" },
      { id: "p2", role: "wolf" },
      { id: "p3", role: "seer" },
      { id: "p4", role: "doctor" },
      { id: "p5", role: "villager" },
    ],
  },
  { kind: "round-start", round: 1, alive: ["p1", "p2", "p3", "p4", "p5"] },
  {
    kind: "turn-stats",
    agent: "p1",
    role: "wolf",
    phase: "day",
    round: 1,
    provider: "omlx",
    model: "qwen",
    parse_path: "object",
    valid_json: true,
    raw_action: "speak",
    normalized_action: "speak",
    action_in_phase: true,
    finish_reason: "stop",
    http_status: "200",
    tokens: { prompt: 600, completion: 200, reasoning: 80 },
    latency_ms: 3000,
    suspicions_count: 1,
    knowledge_count: 0,
  },
  {
    kind: "turn-stats",
    agent: "p3",
    role: "seer",
    phase: "day",
    round: 1,
    provider: "omlx",
    model: "qwen",
    parse_path: "text",
    valid_json: false,
    raw_action: "speak",
    normalized_action: "speak",
    action_in_phase: true,
    finish_reason: "length",
    http_status: "200",
    tokens: { prompt: 600, completion: 260, reasoning: 0 },
    latency_ms: 9000,
    suspicions_count: 0,
    knowledge_count: 0,
  },
  { kind: "seer-learn", round: 1, agent: "p3", target: "p1", role: "wolf" },
  { kind: "wolf-kill", round: 1, target: "p5", role: "villager" },
  { kind: "no-lynch", round: 1, tied: ["p1", "p2"], votes: 2 },
  { kind: "round-start", round: 2, alive: ["p1", "p2", "p3", "p4"] },
  { kind: "wolf-saved", round: 2, target: "p3" },
  { kind: "lynch", round: 2, target: "p1", votes: 3, revealed_role: "wolf" },
  { kind: "game-end", winner: "village", reason: "all wolves eliminated", rounds: 2 },
];
const summary = summarizeGame(fixtureEvents);
assert.equal(summary.game_id, "g1");
assert.equal(summary.provider, "omlx");
assert.equal(summary.players.length, 5);
assert.equal(summary.roles.p1, "wolf");
assert.equal(summary.turn_stats.length, 2);
assert.equal(summary.lynch_count, 1);
assert.equal(summary.no_lynch_count, 1);
assert.equal(summary.wolf_kill_count, 1);
assert.equal(summary.wolf_saved_count, 1);
assert.equal(summary.no_kill_count, 0);
assert.equal(summary.seer_targeted_total, 1);
assert.equal(summary.seer_targeted_wolf_count, 1);
assert.equal(summary.winner, "village");
assert.equal(summary.rounds_played, 2);
assert.equal(summary.completed, true);

// === unit: aggregate with two games ===
const incompleteEvents = [
  { kind: "game-start", game_id: "g2", provider: "omlx", model: "qwen", players: [{ id: "p1", role: "wolf" }, { id: "p2", role: "villager" }] },
  { kind: "round-start", round: 1, alive: ["p1", "p2"] },
  {
    kind: "turn-stats",
    agent: "p1",
    role: "wolf",
    phase: "day",
    round: 1,
    provider: "omlx",
    model: "qwen",
    parse_path: "http-error",
    valid_json: false,
    raw_action: "",
    normalized_action: "speak",
    action_in_phase: true,
    finish_reason: "",
    http_status: "error",
    tokens: { prompt: 0, completion: 0, reasoning: 0 },
    latency_ms: 30000,
    suspicions_count: 0,
    knowledge_count: 0,
  },
];

const stubWinForWolves = [
  { kind: "game-start", game_id: "g3", provider: "stub", model: "stub-werewolf-v1", players: [{ id: "p1", role: "wolf" }, { id: "p2", role: "villager" }] },
  { kind: "round-start", round: 1, alive: ["p1", "p2"] },
  {
    kind: "turn-stats",
    agent: "p1",
    role: "wolf",
    phase: "day",
    round: 1,
    provider: "stub",
    model: "stub",
    parse_path: "stub",
    valid_json: true,
    raw_action: "speak",
    normalized_action: "speak",
    action_in_phase: true,
    finish_reason: "",
    http_status: "",
    tokens: { prompt: 0, completion: 0, reasoning: 0 },
    latency_ms: 5,
    suspicions_count: 0,
    knowledge_count: 1,
  },
  { kind: "wolf-kill", round: 1, target: "p2", role: "villager" },
  { kind: "game-end", winner: "wolves", reason: "wolves outnumber villagers", rounds: 1 },
];

const games = [
  { path: "g1.jsonl", events: fixtureEvents },
  { path: "g2.jsonl", events: incompleteEvents },
  { path: "g3.jsonl", events: stubWinForWolves },
];
const scorecard = aggregate(games);

assert.equal(scorecard.meta.game_count, 3);
assert.equal(scorecard.meta.completed_game_count, 2);
assert.deepEqual(scorecard.meta.providers.sort(), ["omlx", "stub"]);

// prompt-following over 4 turns total: g1=2, g2=1, g3=1
assert.equal(scorecard.prompt_following.total_turns, 4);
// valid_json: g1[0]=true, g1[1]=false, g2=false, g3=true → 2/4
assert.equal(scorecard.prompt_following.valid_json_rate, 0.5);
// action_in_phase: all 4 are true
assert.equal(scorecard.prompt_following.action_in_phase_rate, 1);
// http_error_rate: 1/4
assert.equal(scorecard.prompt_following.http_error_rate, 0.25);
// parse_path histogram
assert.deepEqual(scorecard.prompt_following.parse_path_histogram, {
  object: 1,
  text: 1,
  "http-error": 1,
  stub: 1,
});

// game-shape: 2 completed (g1=village, g3=wolves). 1 incomplete (g2)
assert.equal(scorecard.game_shape.village_winrate, 0.5);
assert.equal(scorecard.game_shape.wolves_winrate, 0.5);
assert.equal(scorecard.game_shape.incomplete_rate, 1 / 3);
// avg_rounds over completed: (2 + 1) / 2 = 1.5
assert.equal(scorecard.game_shape.avg_rounds, 1.5);
// nights: g1 has 2 night events (kill, saved), g3 has 1 (kill), g2 has 0
// total nights = 3, saved = 1
assert.equal(scorecard.game_shape.night_saved_rate, 1 / 3);
// days: g1 has 2 day-results (no-lynch + lynch), g3 has 0 visible, g2 has 0
// lynches total = 1 (g1), totalDays = 2
assert.equal(scorecard.game_shape.lynch_rate_per_day, 0.5);

// belief_quality: 4 turns, 1 turn with suspicions or knowledge => 0.25? Actually g1[0] has 1 suspicion, g3 has 1 knowledge → 2/4
assert.equal(scorecard.belief_quality.belief_emit_rate, 0.5);
// seer targets wolf: 1/1
assert.equal(scorecard.belief_quality.seer_targeting_wolf_rate, 1);

// performance: latencies > 0: 3000, 9000, 30000, 5 → avg = (3000+9000+30000+5)/4 = 10501.25, p50 = 9000
assert.equal(scorecard.performance.avg_latency_ms, 10501);
assert.equal(scorecard.performance.p50_latency_ms, 9000);
// tokens > 0 from g1[0] and g1[1]: prompts [600, 600] avg 600
assert.equal(scorecard.performance.avg_prompt_tokens, 600);
assert.equal(scorecard.performance.total_prompt_tokens, 1200);
assert.equal(scorecard.performance.total_reasoning_tokens, 80);

// per_game
assert.equal(scorecard.per_game.length, 3);
assert.equal(scorecard.per_game[0].winner, "village");
assert.equal(scorecard.per_game[1].completed, false);
assert.equal(scorecard.per_game[2].winner, "wolves");

// summary string is non-empty and includes key labels
const summaryString = formatScorecardSummary(scorecard);
assert.match(summaryString, /games: 2\/3 completed/);
assert.match(summaryString, /valid_json_rate     = 50\.0%/);
assert.match(summaryString, /village_winrate     = 50\.0%/);
assert.match(summaryString, /avg_latency_ms      = 10501/);

// === edge case: empty input ===
const emptySc = aggregate([]);
assert.equal(emptySc.meta.game_count, 0);
assert.equal(emptySc.prompt_following.total_turns, 0);
assert.equal(emptySc.prompt_following.valid_json_rate, 0);
assert.equal(emptySc.game_shape.village_winrate, 0);
assert.equal(emptySc.performance.avg_latency_ms, 0);

// === edge case: a game with zero turn-stats and just a game-start ===
const noTurns = aggregate([
  { path: "g.jsonl", events: [{ kind: "game-start", game_id: "x", provider: "stub", model: "s", players: [] }] },
]);
assert.equal(noTurns.prompt_following.total_turns, 0);
assert.equal(noTurns.meta.providers.length, 1);
assert.equal(noTurns.game_shape.incomplete_rate, 1);

// === edge case: malformed turn-stats values (missing tokens, non-bool valid_json) ===
const badTurn = aggregate([
  {
    path: "bad.jsonl",
    events: [
      { kind: "game-start", game_id: "b", provider: "stub", model: "s", players: [] },
      { kind: "turn-stats", agent: "p1", parse_path: "object", valid_json: "yes", action_in_phase: 1 },
      { kind: "game-end", winner: "village", reason: "x", rounds: 1 },
    ],
  },
]);
// non-boolean valid_json should NOT count as true (=== check)
assert.equal(badTurn.prompt_following.valid_json_rate, 0);
// non-boolean action_in_phase should NOT count as true
assert.equal(badTurn.prompt_following.action_in_phase_rate, 0);
assert.equal(badTurn.prompt_following.parse_path_histogram.object, 1);

// === filesystem integration: write and reload ===
const tmpDir = await mkdtemp(join(tmpdir(), "eval-agg-"));
try {
  await writeFile(
    join(tmpDir, "game-a.jsonl"),
    fixtureEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await writeFile(
    join(tmpDir, "game-b.jsonl"),
    incompleteEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await writeFile(join(tmpDir, "ignore.txt"), "not jsonl");
  const loaded = await loadGameLogs(tmpDir);
  assert.equal(loaded.length, 2);
  const dirSc = aggregate(loaded);
  assert.equal(dirSc.meta.game_count, 2);
  assert.equal(dirSc.meta.completed_game_count, 1);

  // single-file load
  const singleLoaded = await loadGameLogs(join(tmpDir, "game-a.jsonl"));
  assert.equal(singleLoaded.length, 1);
  assert.equal(singleLoaded[0].events.length, fixtureEvents.length);
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log("ok - eval-aggregate metrics and IO");

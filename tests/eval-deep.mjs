#!/usr/bin/env node
// Deep / multi-step edge case tests for the eval framework.
//
// Each section here is a multi-step scenario that exercises a real failure
// mode the simple unit tests can't catch. When something here breaks, it
// almost always points at a real bug in the aggregator / gates / runner,
// not at the test fixture.
//
// Sections:
//   1. Lifecycle mutation isolation
//   2. Concurrency race under randomized server delays
//   3. Hostile numeric inputs (NaN / Infinity / negative) clamp to 0
//   4. Orchestrator restart: two game-start events in one log
//   5. game-end before game-start (truncated / out-of-order log)
//   6. Durable log file deleted after server reported success
//   7. Malformed NDJSON lines interspersed with valid result events
//   8. Three-layer gate precedence (defaults <- baseline-derived <- profile)

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  loadGameLogs,
  parseGameLog,
  summarizeGame,
} from "../eval/aggregate.mjs";
import { evaluateGates } from "../eval/gates.mjs";
import { runProfile } from "../eval/run.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(ROOT, "eval", "fixtures");

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}
function assertAllNumbersFinite(obj, pathPrefix = "") {
  for (const [k, v] of Object.entries(obj)) {
    const p = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      assertAllNumbersFinite(v, p);
    } else if (typeof v === "number") {
      assert.ok(isFiniteNumber(v), `${p} is non-finite: ${v}`);
    }
  }
}

// ===========================================================================
// 1. Lifecycle mutation isolation
//
// Goal: changing the winner of one game must shift game-shape metrics but
// must NOT shift prompt-following / performance / belief metrics, since
// those derive from turn-stats events only.
// ===========================================================================
{
  const villageWin = parseGameLog(await readFile(join(FIXTURES_DIR, "village-win.jsonl"), "utf8"));
  const wolfWin = parseGameLog(await readFile(join(FIXTURES_DIR, "wolf-win.jsonl"), "utf8"));

  const baselineSc = aggregate([
    { path: "v.jsonl", events: villageWin },
    { path: "w.jsonl", events: wolfWin },
  ]);

  // Mutate ONLY the game-end of village-win to flip winner → wolves
  const villageWinFlipped = villageWin.map((e) =>
    e.kind === "game-end" ? { ...e, winner: "wolves" } : e,
  );
  const mutatedSc = aggregate([
    { path: "v.jsonl", events: villageWinFlipped },
    { path: "w.jsonl", events: wolfWin },
  ]);

  // game-shape changed
  assert.equal(baselineSc.game_shape.village_winrate, 0.5);
  assert.equal(baselineSc.game_shape.wolves_winrate, 0.5);
  assert.equal(mutatedSc.game_shape.village_winrate, 0);
  assert.equal(mutatedSc.game_shape.wolves_winrate, 1);

  // per_game[0].winner reflects mutation
  assert.equal(mutatedSc.per_game[0].winner, "wolves");

  // prompt-following invariant under winner flip
  assert.deepEqual(mutatedSc.prompt_following, baselineSc.prompt_following);

  // performance invariant
  assert.deepEqual(mutatedSc.performance, baselineSc.performance);

  // belief invariant
  assert.deepEqual(mutatedSc.belief_quality, baselineSc.belief_quality);

  console.log("ok  1. lifecycle mutation isolates game-shape from other sections");
}

// ===========================================================================
// 2. Concurrency race under randomized server delays
//
// Goal: with concurrency=4 and 12 games, responses arrive out of order. The
// runner's worker pool must still produce results[i] keyed by the original
// gameIndex, not by arrival order.
// ===========================================================================
{
  const tmp = await mkdtemp(join(tmpdir(), "eval-deep-conc-"));
  try {
    // pre-write 12 distinct durable logs so each game can be distinguished
    const logPaths = [];
    for (let i = 0; i < 12; i += 1) {
      const p = join(tmp, `log-${i}.jsonl`);
      const events = [
        { kind: "game-start", game_id: `g${i}`, provider: "stub", model: "s", players: [{ id: "p1", role: "wolf" }] },
        { kind: "game-end", winner: "village", reason: "x", rounds: 1 },
      ];
      await writeFile(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      logPaths.push(p);
    }

    // Track the order the server saw requests in.
    let requestSeq = 0;
    const requestOrder = [];

    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        // The body doesn't carry gameIndex (it's the same payload N times),
        // so we map by request-arrival order — the worker pool dispatches
        // queue items sequentially per worker, but across workers ordering
        // is non-deterministic. We just need to make sure every gameIndex
        // gets exactly one log assigned.
        const seq = requestSeq++;
        requestOrder.push(seq);
        // randomized response delay so arrival order differs from
        // dispatch order across the 4 concurrent workers
        const delayMs = Math.floor(Math.random() * 50);
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.write(`${JSON.stringify({ type: "start" })}\n`);
          res.write(
            `${JSON.stringify({
              type: "stdout",
              data: `[${JSON.stringify({
                winner: "village",
                reason: "x",
                rounds: 1,
                alive: [],
                eliminated: [],
                history: [],
                durable_log: logPaths[seq % logPaths.length],
              })}]\n`,
            })}\n`,
          );
          res.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
          res.end();
          // adjust parsed so eslint doesn't complain (no-op)
          void parsed;
        }, delayMs);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const profile = {
      name: "race",
      provider: "stub",
      model: "stub-werewolf-v1",
      game_count: 12,
      concurrency: 4,
      players: [
        { id: "p1", role: "wolf" },
        { id: "p2", role: "seer" },
        { id: "p3", role: "doctor" },
      ],
    };
    const outDir = join(tmp, "out");
    const result = await runProfile(profile, { server: `http://127.0.0.1:${port}`, outDir });
    server.close();

    assert.equal(result.results.length, 12);
    // EVERY result slot is populated (no dropped or shifted indices)
    for (let i = 0; i < 12; i += 1) {
      assert.ok(result.results[i], `results[${i}] is undefined`);
      assert.equal(result.results[i].gameIndex, i, `results[${i}].gameIndex must equal ${i}`);
      assert.equal(result.results[i].ok, true);
    }
    // requests arrived in some order (at least one out-of-order pair across 12 with random delay)
    assert.equal(requestOrder.length, 12);

    // scorecard sees all 12 games
    assert.equal(result.scorecard.meta.game_count, 12);
    assert.equal(result.scorecard.meta.completed_game_count, 12);

    console.log("ok  2. concurrency race preserves results[idx].gameIndex == idx");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// 3. Hostile numeric inputs are clamped at the boundary
//
// Goal: no NaN / Infinity / negative value can escape into the scorecard,
// regardless of what upstream emits.
// ===========================================================================
{
  const hostileEvents = [
    { kind: "game-start", game_id: "h", provider: "p", model: "m", players: [{ id: "a", role: "wolf" }] },
    {
      kind: "turn-stats",
      agent: "a",
      role: "wolf",
      phase: "day",
      round: 1,
      provider: "p",
      model: "m",
      parse_path: "object",
      valid_json: true,
      raw_action: "speak",
      normalized_action: "speak",
      action_in_phase: true,
      finish_reason: "stop",
      http_status: "200",
      tokens: { prompt: NaN, completion: -1, reasoning: Infinity },
      latency_ms: Infinity,
      suspicions_count: -5,
      knowledge_count: NaN,
    },
    {
      kind: "turn-stats",
      agent: "a",
      role: "wolf",
      phase: "day",
      round: 1,
      provider: "p",
      model: "m",
      parse_path: "object",
      valid_json: true,
      raw_action: "speak",
      normalized_action: "speak",
      action_in_phase: true,
      finish_reason: "stop",
      http_status: "200",
      tokens: null,
      latency_ms: "not a number",
      suspicions_count: "abc",
      knowledge_count: undefined,
    },
    { kind: "game-end", winner: "village", reason: "x", rounds: 1 },
  ];

  const sc = aggregate([{ path: "h.jsonl", events: hostileEvents }]);

  // every numeric in performance / belief_quality is finite and non-negative
  assert.ok(isFiniteNumber(sc.performance.avg_latency_ms));
  assert.equal(sc.performance.avg_latency_ms, 0, "no latency >0 survived clamp");
  assert.equal(sc.performance.avg_prompt_tokens, 0);
  assert.equal(sc.performance.total_completion_tokens, 0);
  assert.equal(sc.belief_quality.avg_suspicions_per_turn, 0);
  assert.equal(sc.belief_quality.avg_knowledge_per_turn, 0);
  assert.equal(sc.belief_quality.belief_emit_rate, 0);

  // global scan for any rogue NaN / Infinity
  assertAllNumbersFinite(sc);

  console.log("ok  3. hostile numerics (NaN/Infinity/negative/strings) clamp to 0");
}

// ===========================================================================
// 4. Orchestrator restart: two game-start events in one log
//
// Goal: when an orchestrator restarts mid-game, the durable log may receive
// a second game-start. The aggregator should treat the latest game-start as
// authoritative (so the final provider/model reflect the restart) and must
// not double-count rounds.
// ===========================================================================
{
  const events = [
    { kind: "game-start", game_id: "x", provider: "omlx", model: "qwen-old", players: [{ id: "a", role: "wolf" }, { id: "b", role: "villager" }] },
    { kind: "round-start", round: 1, alive: ["a", "b"] },
    { kind: "game-start", game_id: "x", provider: "openai", model: "gpt-4o-mini", players: [{ id: "a", role: "wolf" }, { id: "b", role: "villager" }] },
    { kind: "round-start", round: 2, alive: ["a", "b"] },
    { kind: "game-end", winner: "village", reason: "restart-completed", rounds: 2 },
  ];

  const summary = summarizeGame(events);
  // latest game-start wins
  assert.equal(summary.provider, "openai");
  assert.equal(summary.model, "gpt-4o-mini");
  // rounds_played comes from game-end's `rounds` field (authoritative), and round-starts only bump if higher
  assert.equal(summary.rounds_played, 2, "rounds_played reflects game-end, not sum of round-starts");

  const sc = aggregate([{ path: "x.jsonl", events }]);
  assert.equal(sc.meta.completed_game_count, 1);
  // providers/models sets contain only the WINNING (latest) entries — game-start
  // overwrites are intentionally lossy. If we ever want the history we'll need
  // a different event kind.
  assert.deepEqual(sc.meta.providers, ["openai"]);
  assert.deepEqual(sc.meta.models, ["gpt-4o-mini"]);

  console.log("ok  4. multiple game-start events: latest wins, rounds not double-counted");
}

// ===========================================================================
// 5. game-end before game-start (truncated / out-of-order log)
//
// Goal: a log where game-end appears before game-start (because of crash
// recovery, late-arriving events, or concatenation) must still produce a
// correct summary. summarizeGame is built from event counts, not order, so
// this should already pass — locking it in.
// ===========================================================================
{
  const events = [
    { kind: "game-end", winner: "wolves", reason: "wolves outnumber", rounds: 3 },
    { kind: "round-start", round: 1, alive: ["a", "b"] },
    { kind: "wolf-kill", round: 1, target: "b", role: "villager" },
    { kind: "game-start", game_id: "ooo", provider: "stub", model: "s", players: [{ id: "a", role: "wolf" }, { id: "b", role: "villager" }] },
  ];

  const summary = summarizeGame(events);
  assert.equal(summary.completed, true);
  assert.equal(summary.winner, "wolves");
  assert.equal(summary.rounds_played, 3);
  assert.equal(summary.game_id, "ooo");
  assert.equal(summary.wolf_kill_count, 1);

  console.log("ok  5. game-end before game-start still produces correct summary");
}

// ===========================================================================
// 6. Durable log file deleted after server reported success
//
// Goal: server returns ok with a durable_log path that doesn't exist on disk
// (deleted between report and copy, or the lab cleaned up). Runner should
// record copy_error per game and aggregate only the games whose logs WERE
// copyable.
// ===========================================================================
{
  const tmp = await mkdtemp(join(tmpdir(), "eval-deep-missing-"));
  try {
    // Game 0: real log exists. Game 1: nonexistent path.
    const realLog = join(tmp, "real.jsonl");
    await writeFile(
      realLog,
      [
        { kind: "game-start", game_id: "real", provider: "stub", model: "s", players: [{ id: "p1", role: "wolf" }] },
        { kind: "game-end", winner: "village", reason: "x", rounds: 1 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const ghostLog = join(tmp, "ghost-does-not-exist.jsonl");

    let n = 0;
    const server = createServer((_req, res) => {
      const path = n === 0 ? realLog : ghostLog;
      n += 1;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "start" })}\n`);
      res.write(
        `${JSON.stringify({
          type: "stdout",
          data: `[${JSON.stringify({
            winner: "village",
            reason: "x",
            rounds: 1,
            alive: [],
            eliminated: [],
            history: [],
            durable_log: path,
          })}]\n`,
        })}\n`,
      );
      res.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const result = await runProfile(
      {
        name: "missing-log",
        provider: "stub",
        model: "stub-werewolf-v1",
        game_count: 2,
        concurrency: 1,
        players: [
          { id: "p1", role: "wolf" },
          { id: "p2", role: "seer" },
          { id: "p3", role: "doctor" },
        ],
      },
      { server: `http://127.0.0.1:${port}`, outDir: join(tmp, "out") },
    );
    server.close();

    // both server calls reported ok=true
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].ok, true);
    // but result[1] should carry copy_error
    assert.ok(
      typeof result.results[1].copy_error === "string" && result.results[1].copy_error.length > 0,
      `expected copy_error on result[1], got: ${JSON.stringify(result.results[1])}`,
    );
    assert.equal(result.results[0].copy_error, undefined);

    // scorecard reflects only the 1 game that was actually loaded
    assert.equal(result.scorecard.meta.game_count, 1);
    assert.equal(result.scorecard.meta.completed_game_count, 1);

    console.log("ok  6. missing durable log: per-game copy_error, partial scorecard");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// 7. Malformed NDJSON lines interspersed with valid result events
//
// Goal: the server (or a hostile proxy) may inject non-JSON lines between
// valid events. The runner's extractors must skip garbage and still find the
// durable_log path + done event.
// ===========================================================================
{
  const tmp = await mkdtemp(join(tmpdir(), "eval-deep-malformed-"));
  try {
    const realLog = join(tmp, "real.jsonl");
    await writeFile(
      realLog,
      [
        { kind: "game-start", game_id: "mal", provider: "stub", model: "s", players: [{ id: "p1", role: "wolf" }] },
        { kind: "game-end", winner: "wolves", reason: "x", rounds: 1 },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );

    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      // valid start
      res.write(`${JSON.stringify({ type: "start" })}\n`);
      // garbage line
      res.write("totally not json garbage line\n");
      // partial JSON that fails to parse
      res.write('{"type": "stdout", "data": "unterminated\n');
      // empty line
      res.write("\n");
      // valid result event
      res.write(
        `${JSON.stringify({
          type: "stdout",
          data: `[${JSON.stringify({
            winner: "wolves",
            reason: "x",
            rounds: 1,
            alive: [],
            eliminated: [],
            history: [],
            durable_log: realLog,
          })}]\n`,
        })}\n`,
      );
      // more garbage
      res.write("more garbage\n");
      // valid done
      res.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const result = await runProfile(
      {
        name: "malformed",
        provider: "stub",
        model: "stub-werewolf-v1",
        game_count: 1,
        concurrency: 1,
        players: [
          { id: "p1", role: "wolf" },
          { id: "p2", role: "seer" },
          { id: "p3", role: "doctor" },
        ],
      },
      { server: `http://127.0.0.1:${port}`, outDir: join(tmp, "out") },
    );
    server.close();

    assert.equal(result.results[0].ok, true, `garbage must not block extraction: ${JSON.stringify(result.results[0])}`);
    assert.equal(result.results[0].durable, realLog);
    assert.equal(result.scorecard.meta.completed_game_count, 1);
    assert.equal(result.scorecard.game_shape.wolves_winrate, 1);

    console.log("ok  7. malformed NDJSON noise does not block extractDurableLogPath / extractDoneOk");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ===========================================================================
// 8. Three-layer gate precedence: defaults <- baseline-derived <- profile
//
// Goal: lock in that
//   - a profile-explicit value beats a baseline-derived band
//   - a baseline-derived band beats a default
//   - explicit null in the profile DELETES a baseline-derived band
//   - skip:true in profile wins over everything
// ===========================================================================
{
  function sc(overrides = {}) {
    return {
      prompt_following: {
        valid_json_rate: 1,
        action_in_phase_rate: 1,
        http_error_rate: 0,
        ...(overrides.prompt_following || {}),
      },
      game_shape: {
        incomplete_rate: 0,
        village_winrate: 0.5,
        avg_rounds: 4,
        ...(overrides.game_shape || {}),
      },
      belief_quality: {
        belief_emit_rate: 0.5,
        ...(overrides.belief_quality || {}),
      },
    };
  }

  // 8a. Baseline alone derives a band that triggers a soft warning.
  {
    const baseline = { game_shape: { village_winrate: 0.5, avg_rounds: 4 }, belief_quality: { belief_emit_rate: 0.5 } };
    const r = evaluateGates(sc({ game_shape: { village_winrate: 0.95 } }), undefined, { baseline });
    assert.ok(r.soft_warnings.some((w) => w.label === "village_winrate_band"));
  }

  // 8b. Profile explicitly sets the band, beating baseline-derived
  {
    const baseline = { game_shape: { village_winrate: 0.5 } };
    // baseline would say [0.5, 0.2] (so 0.95 warns). Profile widens to [0.5, 0.5] (so 0.95 OK).
    const r = evaluateGates(
      sc({ game_shape: { village_winrate: 0.95 } }),
      { village_winrate_band: [0.5, 0.5] },
      { baseline },
    );
    assert.equal(r.soft_warnings.length, 0, `profile band must override derived: ${JSON.stringify(r.soft_warnings)}`);
  }

  // 8c. Profile-explicit `null` DELETES the baseline-derived band entirely
  {
    const baseline = { game_shape: { village_winrate: 0.5 } };
    const r = evaluateGates(
      sc({ game_shape: { village_winrate: 0.95 } }),
      { village_winrate_band: null },
      { baseline },
    );
    assert.equal(r.gates.village_winrate_band, null);
    assert.equal(r.soft_warnings.length, 0, "explicit null deletes the band");
  }

  // 8d. Baseline-derived belief floor triggers soft warning when score below
  {
    const baseline = { belief_quality: { belief_emit_rate: 0.8 } };
    // derived floor = 0.8 - 0.15 = 0.65
    const r = evaluateGates(sc({ belief_quality: { belief_emit_rate: 0.4 } }), undefined, { baseline });
    assert.ok(r.soft_warnings.some((w) => w.label === "belief_emit_rate_min"));
    // and the *threshold* in the warning equals the derived floor
    const warn = r.soft_warnings.find((w) => w.label === "belief_emit_rate_min");
    assert.ok(Math.abs(warn.threshold - 0.65) < 1e-9);
  }

  // 8e. skip:true in profile beats both baseline AND default hard floors
  {
    const baseline = { game_shape: { village_winrate: 0.5 } };
    const r = evaluateGates(
      sc({ prompt_following: { valid_json_rate: 0 }, game_shape: { village_winrate: 0.99 } }),
      { skip: true },
      { baseline },
    );
    assert.equal(r.skipped, true);
    assert.equal(r.pass, true);
    assert.equal(r.hard_failures.length, 0);
  }

  // 8f. Baseline raises NO bands when its scorecard lacks those fields
  {
    const baseline = {}; // empty
    const r = evaluateGates(sc({ game_shape: { village_winrate: 0.95 } }), undefined, { baseline });
    assert.equal(r.soft_warnings.filter((w) => w.label === "village_winrate_band").length, 0);
  }

  console.log("ok  8. three-layer gate precedence (default <- derived <- profile, incl. null delete)");
}

// ===========================================================================
// Cross-cutting check: every committed fixture loads, summarizes, and
// aggregates without producing non-finite numbers.
// ===========================================================================
{
  const all = await loadGameLogs(FIXTURES_DIR);
  for (const game of all) {
    const summary = summarizeGame(game.events);
    assert.ok(summary.game_id, `fixture ${game.path} missing game-start`);
  }
  const sc = aggregate(all);
  assertAllNumbersFinite(sc);
  console.log("ok  9. committed fixtures produce finite-only scorecards");
}

console.log("");
console.log("ok - eval-deep: 9 multi-step scenarios");

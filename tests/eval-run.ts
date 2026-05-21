#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  buildRunRequestBody,
  extractDoneOk,
  extractDurableLogPath,
  hashProfile,
  runProfile,
  validateProfile,
} from "../eval/run.ts";

async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return (address as AddressInfo).port;
}

// === validateProfile ===
assert.throws(() => validateProfile(null), /must be an object/);
assert.throws(() => validateProfile({}), /missing required field: name/);
assert.throws(
  () => validateProfile({ name: "x", provider: "stub", game_count: 0, players: [] }),
  /game_count must be a positive integer/,
);
assert.throws(
  () => validateProfile({ name: "x", provider: "stub", game_count: 1, players: [{ id: "a", role: "wolf" }] }),
  /at least 3 players/,
);
assert.throws(
  () => validateProfile({
    name: "x",
    provider: "stub",
    game_count: 1,
    players: [
      { id: "a", role: "wolf" },
      { id: "b", role: "villager" },
      { id: "c", role: "villager" },
    ],
  }),
  /must include role: seer/,
);
assert.throws(
  () => validateProfile({
    name: "x",
    provider: "stub",
    game_count: 1,
    concurrency: 99,
    players: [
      { id: "a", role: "wolf" },
      { id: "b", role: "seer" },
      { id: "c", role: "doctor" },
    ],
  }),
  /concurrency must be an integer in \[1, 8\]/,
);

const validated = validateProfile({
  name: "x",
  provider: "omlx",
  model: "qwen",
  base_url: "http://localhost:8000/v1",
  api_key_env: "OMLX_API_KEY",
  game_count: 5,
  thinking_budget: 400,
  players: [
    { id: "a", role: "wolf" },
    { id: "b", role: "seer" },
    { id: "c", role: "doctor" },
    { id: "d", role: "villager" },
  ],
});
assert.equal(validated.concurrency, 1);
assert.equal(validated.max_rounds, 8);
assert.equal(validated.wolf_rotation_cap, 3);
assert.equal(validated.thinking_budget, 400);
assert.equal(validated.temperature, 0.2);
assert.equal(validated.max_tokens, 260);

assert.throws(
  () => validateProfile({
    name: "x",
    provider: "stub",
    game_count: 1,
    wolf_rotation_cap: 99,
    players: [
      { id: "a", role: "wolf" },
      { id: "b", role: "seer" },
      { id: "c", role: "doctor" },
    ],
  }),
  /wolf_rotation_cap must be an integer in \[1, 6\]/,
);

const capProfile = validateProfile({
  name: "y",
  provider: "stub",
  game_count: 1,
  wolf_rotation_cap: 5,
  players: [
    { id: "a", role: "wolf" },
    { id: "b", role: "seer" },
    { id: "c", role: "doctor" },
  ],
});
assert.equal(capProfile.wolf_rotation_cap, 5);
assert.equal(hashProfile({ b: 2, a: 1 }), hashProfile({ a: 1, b: 2 }));
assert.notEqual(hashProfile({ a: 1 }), hashProfile({ a: 2 }));

// === buildRunRequestBody ===
const body = buildRunRequestBody(validated, "secret");
assert.equal(body.action, "playGame");
assert.equal(body.provider, "omlx");
assert.equal(body.model, "qwen");
assert.equal(body.apiKey, "secret");
assert.equal(body.thinkingBudget, 400);
assert.equal(body.maxRounds, 8);
assert.equal(body.wolfRotationCap, 3);
assert.deepEqual(body.players[0], { id: "a", role: "wolf" });

// === extractDurableLogPath ===
const sampleStream = [
  '{"type":"start","action":"playGame"}',
  '{"type":"stdout","data":"[referee] durable log: .generated/games/game-2026.jsonl\\n"}',
  '{"type":"stdout","data":"[{\\"winner\\":\\"village\\",\\"reason\\":\\"all wolves\\",\\"rounds\\":2,\\"alive\\":[],\\"eliminated\\":[],\\"history\\":[],\\"durable_log\\":\\".generated/games/game-2026.jsonl\\"}]\\n"}',
  '{"type":"done","ok":true}',
].join("\n");
assert.equal(extractDurableLogPath(sampleStream), ".generated/games/game-2026.jsonl");
assert.equal(extractDoneOk(sampleStream), true);

const failStream = [
  '{"type":"start","action":"playGame"}',
  '{"type":"stderr","data":"boom"}',
  '{"type":"done","ok":false}',
].join("\n");
assert.equal(extractDurableLogPath(failStream), null);
assert.equal(extractDoneOk(failStream), false);

assert.equal(extractDurableLogPath(""), null);
assert.equal(extractDoneOk(""), null);
assert.equal(extractDurableLogPath("garbage"), null);

// === integration: spin up a mock HTTP target that mimics /api/run ===
const tmpDir = await mkdtemp(join(tmpdir(), "eval-run-"));
try {
  // pre-write a fake durable log
  const fakeLog = join(tmpDir, "fake-game.jsonl");
  const events = [
    { ts: "2026-05-19T00:00:00Z", kind: "game-start", game_id: "fake", provider: "stub", model: "s", players: [{ id: "p1", role: "wolf" }, { id: "p2", role: "villager" }] },
    {
      ts: "2026-05-19T00:00:01Z",
      kind: "turn-stats",
      agent: "p1",
      role: "wolf",
      phase: "day",
      round: 1,
      provider: "stub",
      model: "s",
      parse_path: "stub",
      valid_json: true,
      raw_action: "speak",
      normalized_action: "speak",
      action_in_phase: true,
      finish_reason: "",
      http_status: "",
      tokens: { prompt: 0, completion: 0, reasoning: 0 },
      latency_ms: 2,
      suspicions_count: 0,
      knowledge_count: 0,
    },
    { ts: "2026-05-19T00:00:02Z", kind: "game-end", winner: "village", reason: "x", rounds: 1 },
  ];
  await writeFile(fakeLog, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  let postCount = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/run") {
      res.writeHead(404); res.end(); return;
    }
    postCount += 1;
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(`${JSON.stringify({ type: "start", action: "playGame" })}\n`);
    res.write(
      `${JSON.stringify({
        type: "stdout",
        data: `[${JSON.stringify({ winner: "village", reason: "all wolves", rounds: 1, alive: [], eliminated: [], history: [], durable_log: fakeLog })}]\n`,
      })}\n`,
    );
    res.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
    res.end();
  });
  const port = await listenOnRandomPort(server);

  const profile = {
    name: "mock-smoke",
    provider: "stub",
    model: "stub-werewolf-v1",
    game_count: 3,
    concurrency: 2,
    players: [
      { id: "p1", role: "wolf" },
      { id: "p2", role: "seer" },
      { id: "p3", role: "doctor" },
      { id: "p4", role: "villager" },
    ],
  };
  const outDir = join(tmpDir, "out");
  const result = await runProfile(profile, { server: `http://127.0.0.1:${port}`, outDir });

  server.close();

  assert.equal(postCount, 3, "should POST once per game");
  assert.equal(result.results.length, 3);
  for (const r of result.results) {
    assert.equal(r.ok, true);
    assert.equal(r.durable, fakeLog);
  }
  // scorecard exists and is sane
  assert.ok(result.scorecard);
  const scorecard = result.scorecard;
  assert.equal(scorecard.meta.game_count, 3);
  assert.equal(scorecard.meta.completed_game_count, 3);
  assert.equal(scorecard.game_shape.village_winrate, 1);

  // scorecard.json was written
  const written = JSON.parse(await readFile(join(outDir, "scorecard.json"), "utf8"));
  assert.equal(written.meta.game_count, 3);

  // gates were evaluated and gates.json was written
  assert.ok(result.gateReport, "runProfile returns a gateReport");
  assert.equal(result.gateReport.pass, true, "stub-mocked games hit every gate");
  const gatesWritten = JSON.parse(await readFile(join(outDir, "gates.json"), "utf8"));
  assert.equal(gatesWritten.pass, true);
  const manifestWritten = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifestWritten.profile_name, "mock-smoke");
  assert.equal(manifestWritten.scenario_id, "mock-smoke");
  assert.equal(manifestWritten.completed_games, 3);
  assert.ok(manifestWritten.profile_hash);
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

// === HTTP failure path ===
const failTmp = await mkdtemp(join(tmpdir(), "eval-run-fail-"));
try {
  const server = createServer((req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  const port = await listenOnRandomPort(server);

  const profile = {
    name: "fail",
    provider: "stub",
    model: "stub-werewolf-v1",
    game_count: 2,
    players: [
      { id: "p1", role: "wolf" },
      { id: "p2", role: "seer" },
      { id: "p3", role: "doctor" },
    ],
  };
  const result = await runProfile(profile, {
    server: `http://127.0.0.1:${port}`,
    outDir: join(failTmp, "out"),
  });
  server.close();
  assert.equal(result.results.length, 2);
  for (const r of result.results) {
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /HTTP 500/);
  }
  assert.equal(result.scorecard, null, "no scorecard when no games complete");
} finally {
  await rm(failTmp, { recursive: true, force: true });
}

// === gate failure flows through runProfile ===
{
  const tmpGate = await mkdtemp(join(tmpdir(), "eval-run-gate-"));
  try {
    const fakeLog = join(tmpGate, "fake.jsonl");
    // Construct a log that will FAIL the http_error_rate gate: 100% http-error.
    const events = [
      { kind: "game-start", game_id: "x", provider: "stub", model: "s", players: [{ id: "p1", role: "wolf" }] },
      {
        kind: "turn-stats",
        agent: "p1",
        role: "wolf",
        phase: "day",
        round: 1,
        provider: "stub",
        model: "s",
        parse_path: "http-error",
        valid_json: false,
        action_in_phase: false,
        http_status: "error",
        tokens: { prompt: 0, completion: 0, reasoning: 0 },
        latency_ms: 1,
        suspicions_count: 0,
        knowledge_count: 0,
      },
      { kind: "game-end", winner: "village", reason: "x", rounds: 1 },
    ];
    await writeFile(fakeLog, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "start" })}\n`);
      res.write(
        `${JSON.stringify({
          type: "stdout",
          data: `[${JSON.stringify({ winner: "village", reason: "x", rounds: 1, alive: [], eliminated: [], history: [], durable_log: fakeLog })}]\n`,
        })}\n`,
      );
      res.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
      res.end();
    });
    const port = await listenOnRandomPort(server);

    const profile = {
      name: "gate-fail",
      provider: "stub",
      model: "stub-werewolf-v1",
      game_count: 1,
      players: [
        { id: "p1", role: "wolf" },
        { id: "p2", role: "seer" },
        { id: "p3", role: "doctor" },
      ],
    };
    const result = await runProfile(profile, { server: `http://127.0.0.1:${port}`, outDir: join(tmpGate, "out") });
    server.close();
    assert.ok(result.gateReport);
    const gateReport = result.gateReport;
    assert.equal(gateReport.pass, false);
    assert.ok(
      gateReport.hard_failures.some((h) => h.label === "http_error_rate_max"),
      `expected http_error_rate_max in hard_failures, got: ${JSON.stringify(gateReport.hard_failures)}`,
    );

    // profile-level skip overrides
    const skipProfile = { ...profile, name: "gate-skip", gates: { skip: true } };
    const server2 = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "start" })}\n`);
      res.write(
        `${JSON.stringify({
          type: "stdout",
          data: `[${JSON.stringify({ winner: "village", reason: "x", rounds: 1, alive: [], eliminated: [], history: [], durable_log: fakeLog })}]\n`,
        })}\n`,
      );
      res.write(`${JSON.stringify({ type: "done", ok: true })}\n`);
      res.end();
    });
    const port2 = await listenOnRandomPort(server2);
    const skipResult = await runProfile(skipProfile, { server: `http://127.0.0.1:${port2}`, outDir: join(tmpGate, "out2") });
    server2.close();
    assert.ok(skipResult.gateReport);
    assert.equal(skipResult.gateReport.skipped, true);
    assert.equal(skipResult.gateReport.pass, true);
  } finally {
    await rm(tmpGate, { recursive: true, force: true });
  }
}

console.log("ok - eval-run profile validation and HTTP orchestration");

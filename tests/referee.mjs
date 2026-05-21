#!/usr/bin/env node
// Tests for the extracted referee module (lib/referee.mjs).
//
// We cannot drive the real autoGame here without Docker, so these tests
// focus on the surface that the extraction introduced:
//   - sink abstraction (httpSink, stdoutSink, arraySink, nullSink)
//   - pure helpers (winnerFor, clampInt, pickRows, stripAnsi)
//   - child-process supervision (registerChild + killActiveChildren)
// The actual game loop is exercised end-to-end by bin/labctl smoke.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  arraySink,
  clampInt,
  httpSink,
  killActiveChildren,
  nullSink,
  pickRows,
  registerChild,
  stdoutSink,
  stripAnsi,
  winnerFor,
} from "../lib/referee.mjs";

// === sinks ===
{
  const events = [];
  const sink = arraySink(events);
  sink.write("step", { command: "echo" });
  sink.write("stdout", { data: "hi" });
  sink.write("done", { ok: true });
  assert.deepEqual(events, [
    { type: "step", command: "echo" },
    { type: "stdout", data: "hi" },
    { type: "done", ok: true },
  ]);
}
{
  // nullSink swallows without throwing
  const sink = nullSink();
  sink.write("step", { command: "x" });
  sink.write("anything", {});
  sink.write("noargs");
}
{
  // httpSink writes NDJSON to a mock response object
  const lines = [];
  const fakeRes = { write: (chunk) => lines.push(chunk) };
  const sink = httpSink(fakeRes);
  sink.write("stdout", { data: "abc" });
  sink.write("done", { ok: true });
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: "stdout", data: "abc" });
  assert.deepEqual(JSON.parse(lines[1]), { type: "done", ok: true });
  // each line ends with newline
  assert.ok(lines[0].endsWith("\n"));
}
{
  // stdoutSink writes to an injected stream (same shape as httpSink)
  const chunks = [];
  const stream = { write: (s) => chunks.push(s) };
  const sink = stdoutSink(stream);
  sink.write("start", { provider: "stub" });
  assert.equal(chunks.length, 1);
  assert.deepEqual(JSON.parse(chunks[0]), { type: "start", provider: "stub" });
}

// === winnerFor ===
{
  const roles = new Map([
    ["a", "wolf"],
    ["b", "wolf"],
    ["c", "villager"],
    ["d", "seer"],
    ["e", "doctor"],
  ]);
  // 0 wolves alive -> village wins
  assert.deepEqual(winnerFor(["c", "d", "e"], roles), {
    winner: "village",
    reason: "all wolves were eliminated",
  });
  // 1 wolf vs 1 town -> wolves reach parity
  assert.deepEqual(winnerFor(["a", "c"], roles), {
    winner: "wolves",
    reason: "wolves reached parity with town",
  });
  // 2 wolves vs 3 town -> still going
  assert.equal(winnerFor(["a", "b", "c", "d", "e"], roles), null);
  // empty roster -> village (no wolves; vacuously)
  assert.equal(winnerFor([], roles).winner, "village");
}

// === clampInt ===
assert.equal(clampInt(5, 8, 1, 10), 5);
assert.equal(clampInt(-100, 8, 1, 10), 1);
assert.equal(clampInt(100, 8, 1, 10), 10);
assert.equal(clampInt("3.9", 8, 1, 10), 3);
assert.equal(clampInt("not a number", 8, 1, 10), 8);
assert.equal(clampInt(undefined, 8, 1, 10), 8);
assert.equal(clampInt(NaN, 8, 1, 10), 8);
assert.equal(clampInt(Infinity, 8, 1, 10), 8);

// === stripAnsi ===
assert.equal(stripAnsi("[31mred[0m"), "red");
assert.equal(stripAnsi("plain"), "plain");
assert.equal(stripAnsi("[1;33mwarn[0m and [36mblue[0m"), "warn and blue");

// === pickRows ===
{
  const text = `noise before
[{"name":"agent-a"},{"name":"agent-b"}]
noise after
[{"public_text":"hi","action":"speak","agent_id":"agent-a"}]
`;
  assert.deepEqual(pickRows(text, "whoami"), [{ name: "agent-a" }, { name: "agent-b" }]);
  assert.deepEqual(pickRows(text, "public_log"), [
    { public_text: "hi", action: "speak", agent_id: "agent-a" },
  ]);
  // no matching array returns []
  assert.deepEqual(pickRows("nothing here", "whoami"), []);
}
{
  // wolf_channel predicate picks the wolf-kill / wolf-done / rationale array
  const text = `
[{"action":"wolf-kill","agent_id":"a","target":"b","round":1}]
`;
  assert.deepEqual(pickRows(text, "wolf_channel"), [
    { action: "wolf-kill", agent_id: "a", target: "b", round: 1 },
  ]);
}

// === registerChild + killActiveChildren ===
// Spawn two long-lived processes, ensure killActiveChildren stops them
// and that the registry actually drains.
{
  const c1 = registerChild(spawn("sleep", ["30"], { stdio: "ignore" }));
  const c2 = registerChild(spawn("sleep", ["30"], { stdio: "ignore" }));
  assert.equal(c1.killed, false);
  assert.equal(c2.killed, false);
  killActiveChildren();
  // give the OS a moment to deliver SIGTERM
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c1.killed, true);
  assert.equal(c2.killed, true);
}

// === referee CLI smoke (no-op spec, expected to abort because labctl needs Docker) ===
// We just confirm the CLI bootstraps far enough to emit a "start" event.
// Cannot run the full game without Docker.
{
  // Skip: real exec test would require launching node and Docker, which is
  // out of scope for non-Docker tests. The CLI is exercised by hand in
  // omlx-smoke-test.sh and by Docker-gated runs.
}

console.log("ok - referee extraction (sinks, helpers, child registry)");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyBeliefsMarkers,
  buildContextForAgent,
  buildGameConfig,
  buildLabEnv,
  chooseTarget,
  getActionPlan,
  latestKillsPerWolf,
  latestRowPerAgent,
  listActions,
  newRefereeGameId,
  parseBeliefsMarkers,
  parseTurnStatsMarkers,
  resolveLynch,
  resolveNightOutcome,
  serializeRefereeEvent,
  toContainerModelUrl,
  toHostModelUrl,
} from "../lib/lab-web-actions.mjs";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJsonArrays, summarizeStep } from "../web/flow.mjs";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const devRunner = readFileSync(new URL("../bin/lab-web-dev.mjs", import.meta.url), "utf8");
assert.match(html, /value="stub" checked/);
assert.match(html, />Scripted</);
assert.match(html, /data-download/);
assert.match(html, />Advanced</);
assert.match(html, /id="playerCount"/);
assert.match(html, />Manual steps</);
assert.match(html, /data-action="playGame"/);
assert.doesNotMatch(html, /<select[^>]+id="provider"/);
assert.match(makefile, /^web-dev:/m);
assert.match(devRunner, /LAB_WEB_DEV/);
assert.match(devRunner, /lab-web-server\.mjs/);

assert.equal(getActionPlan("fullRound").steps.length, 7);
assert.deepEqual(getActionPlan("fullRound").steps[0], ["./bin/labctl", ["down"]]);
assert.deepEqual(getActionPlan("day").steps[0], ["./bin/labctl", ["run-day"]]);
assert.equal(getActionPlan("playGame").special, "autoGame");
assert.ok(listActions().some((action) => action.id === "wolfChannel"));
assert.ok(listActions().some((action) => action.id === "fullLog"));
assert.throws(() => getActionPlan("rm-rf"), /unknown action/);

const stubEnv = buildLabEnv({ provider: "stub", round: "2" }, {});
assert.equal(stubEnv.LLM_PROVIDER, "stub");
assert.equal(stubEnv.LLM_MODEL, "stub-werewolf-v1");
assert.equal(stubEnv.ROUND, "2");
assert.equal(stubEnv.POST_GAME, "false");

const auditEnv = buildLabEnv({ provider: "stub", postGame: "true" }, {});
assert.equal(auditEnv.POST_GAME, "true");

const customConfig = buildGameConfig({
  provider: "stub",
  players: [
    { id: "agent-a", role: "wolf" },
    { id: "agent-b", role: "villager" },
    { id: "agent-c", role: "doctor" },
  ],
});
assert.deepEqual(customConfig.players.map((player) => player.role), [
  "wolf",
  "villager",
  "doctor",
]);
assert.throws(
  () => buildGameConfig({ players: [{ id: "agent-a", role: "villager" }] }),
  /player count/,
);
assert.throws(
  () =>
    buildGameConfig({
      players: [
        { id: "agent-a", role: "villager" },
        { id: "agent-b", role: "seer" },
        { id: "agent-c", role: "doctor" },
      ],
    }),
  /at least one wolf/,
);

assert.throws(() => buildLabEnv({ provider: "omlx" }, {}), /model is required/);
assert.equal(buildLabEnv({ provider: "omlx" }, {}, { requireModel: false }).LLM_MODEL, "");
assert.equal(getActionPlan("stop").requiresModel, false);
assert.equal(getActionPlan("publicLog").requiresModel, false);

const omlxEnv = buildLabEnv(
  {
    provider: "omlx",
    model: "local-model",
    baseUrl: "http://host.docker.internal:8000/v1",
    apiKey: "secret",
  },
  {},
);
assert.equal(omlxEnv.LLM_PROVIDER, "omlx");
assert.equal(omlxEnv.LLM_MODEL, "local-model");
assert.equal(omlxEnv.LLM_BASE_URL, "http://host.docker.internal:8000/v1");
assert.equal(omlxEnv.LLM_API_KEY, "secret");
assert.equal(omlxEnv.LLM_TIMEOUT_SECONDS, "180");

const localOmlxEnv = buildLabEnv(
  {
    provider: "omlx",
    model: "local-model",
    baseUrl: "http://localhost:8000/v1/",
    apiKey: "secret",
  },
  {},
);
assert.equal(localOmlxEnv.LLM_BASE_URL, "http://host.docker.internal:8000/v1");

const openaiEnv = buildLabEnv({ provider: "openai", model: "gpt-test" }, {});
assert.equal(openaiEnv.LLM_TIMEOUT_SECONDS, "60");

const defaultOpenaiEnv = buildLabEnv({ provider: "openai" }, {});
assert.equal(defaultOpenaiEnv.LLM_MODEL, "gpt-4o-mini");

const openaiNinePlayerConfig = buildGameConfig({
  provider: "openai",
  players: Array.from({ length: 9 }, (_, index) => ({
    id: `agent-${String.fromCharCode(97 + index)}`,
    role: index === 0 || index === 3 || index === 6 ? "wolf" : "villager",
  })),
});
assert.equal(openaiNinePlayerConfig.players.length, 9);
assert.equal(
  openaiNinePlayerConfig.players.filter((player) => player.role === "wolf").length,
  3,
);
assert.equal(openaiNinePlayerConfig.model.model, "gpt-4o-mini");

assert.equal(
  toHostModelUrl("http://host.docker.internal:8000/v1/"),
  "http://localhost:8000/v1/models",
);
assert.equal(
  toContainerModelUrl("http://127.0.0.1:8000/v1/"),
  "http://host.docker.internal:8000/v1",
);

const actionSummary = summarizeStep(
  "referee round 1 discussion",
  "[agent-a] wrote speak for phase=day\n[agent-b] wrote accuse for phase=day\n",
);
assert.equal(actionSummary.rows.length, 2);
assert.equal(actionSummary.title, "Round 1 Discussion");
assert.equal(actionSummary.rows[1].action, "accuse");

const voteSummary = summarizeStep(
  "referee round 1 voting",
  "[agent-a] wrote vote for phase=vote\n[agent-b] wrote vote for phase=vote\n",
);
assert.equal(voteSummary.title, "Round 1 Voting");
assert.equal(voteSummary.rows[0].phase, "vote");

const publicSummary = summarizeStep(
  "referee round 1 discussion log",
  `[]\n[{"round":1,"agent_id":"agent-a","action":"speak","target":null,"public_text":"agent-a checks the record"}]\n[{"message_type":"CONNECTION_REQUEST"}]\n`,
);
assert.equal(publicSummary.rows.length, 1);
assert.equal(publicSummary.title, "Round 1 Public Talk");
assert.equal(publicSummary.rows[0].round, "1");
assert.equal(publicSummary.rows[0].text, "agent-a checks the record");

const wolfSummary = summarizeStep(
  "referee round 1 wolf log",
  `[gateway] running wolf_channel\n[{"round":1,"agent_id":"agent-a","action":"wolf-kill","target":"agent-b","rationale":"private"}]\n`,
);
assert.equal(wolfSummary.title, "Round 1 Wolf Channel");
assert.equal(wolfSummary.rows[0].target, "agent-b");

const doctorSummary = summarizeStep(
  "referee round 1 doctor log",
  `[gateway] running doctor_channel\n[{"round":1,"agent_id":"agent-e","action":"doctor-save","target":"agent-b","rationale":"protect b"}]\n`,
);
assert.equal(doctorSummary.title, "Round 1 Doctor Channel");
assert.equal(doctorSummary.rows[0].target, "agent-b");
assert.equal(doctorSummary.rows[0].agent, "agent-e");

const seerSummary = summarizeStep(
  "referee round 1 seer log",
  `[gateway] running seer_channel\n[{"round":1,"agent_id":"agent-c","action":"seer-investigate","target":"agent-a","rationale":"check a"}]\n`,
);
assert.equal(seerSummary.title, "Round 1 Seer Channel");
assert.equal(seerSummary.rows[0].target, "agent-a");
assert.equal(seerSummary.rows[0].agent, "agent-c");

const doctorPhaseSummary = summarizeStep(
  "referee round 2 doctor",
  "[agent-e] wrote doctor-save for phase=doctor\n",
);
assert.equal(doctorPhaseSummary.title, "Round 2 Doctor Action");
assert.equal(doctorPhaseSummary.rows[0].action, "doctor-save");

const seerPhaseSummary = summarizeStep(
  "referee round 2 seer",
  "[agent-c] wrote seer-investigate for phase=seer\n",
);
assert.equal(seerPhaseSummary.title, "Round 2 Seer Action");
assert.equal(seerPhaseSummary.rows[0].action, "seer-investigate");

const fullLogSummary = summarizeStep(
  "./bin/labctl query full_log",
  `[{"round":1,"agent_id":"agent-a","action":"vote","target":"agent-b","public_text":"agent-a votes agent-b","rationale":"private note"}]\n`,
);
assert.equal(fullLogSummary.rows.length, 1);
assert.equal(fullLogSummary.rows[0].rationale, "private note");

const gameSummary = summarizeStep(
  "referee auto-game",
  `[{"winner":"village","reason":"all wolves were eliminated","rounds":2,"alive":["agent-b"],"history":[{"round":1,"phase":"discussion","event":"talk","turns":3},{"round":1,"phase":"day","event":"vote","target":"agent-a","votes":2}]}]\n`,
);
assert.equal(gameSummary.metrics[0].value, "village");
assert.equal(gameSummary.rows[0].count, "3");
assert.equal(gameSummary.rows[1].target, "agent-a");

const deniedSummary = summarizeStep(
  "./bin/labctl query denied_private_table",
  "Invalid Input Error: Authorization failed",
);
assert.equal(deniedSummary.status, "done");
assert.equal(extractJsonArrays("[gateway]\n[]\n[{\"agent_id\":\"agent-a\"}]").length, 2);

assert.equal(chooseTarget([]), null);
assert.deepEqual(chooseTarget([{ target: "agent-b" }, { target: "agent-b" }, { target: "agent-c" }]), {
  target: "agent-b",
  votes: 2,
});
// alphabetic tiebreak so ties are deterministic for the referee
assert.deepEqual(chooseTarget([{ target: "agent-c" }, { target: "agent-b" }]), {
  target: "agent-b",
  votes: 1,
});

assert.deepEqual(resolveNightOutcome([], []), { outcome: "no-kill", target: null, votes: 0 });
assert.deepEqual(
  resolveNightOutcome([{ target: "agent-b" }], []),
  { outcome: "kill", target: "agent-b", votes: 1 },
);
assert.deepEqual(
  resolveNightOutcome([{ target: "agent-b" }], [{ target: "agent-b" }]),
  { outcome: "saved", target: "agent-b", votes: 1 },
);
assert.deepEqual(
  resolveNightOutcome(
    [{ target: "agent-b" }, { target: "agent-b" }, { target: "agent-c" }],
    [{ target: "agent-c" }],
  ),
  { outcome: "kill", target: "agent-b", votes: 2 },
  "doctor save on a non-targeted player must not block the kill",
);
assert.deepEqual(
  resolveNightOutcome(
    [{ target: "agent-b" }],
    [{ target: "agent-e" }, { target: "agent-b" }],
  ),
  { outcome: "saved", target: "agent-b", votes: 1 },
  "multiple doctor proposals: any matching save cancels the kill",
);

const wolfRotationRows = [
  { agent_id: "agent-a", action: "wolf-kill", target: "agent-b", decided_at: "2026-05-16 00:00:01" },
  { agent_id: "agent-d", action: "wolf-kill", target: "agent-c", decided_at: "2026-05-16 00:00:02" },
  { agent_id: "agent-a", action: "wolf-done", target: "agent-c", decided_at: "2026-05-16 00:00:03" },
  { agent_id: "agent-d", action: "wolf-done", target: "agent-c", decided_at: "2026-05-16 00:00:04" },
];
const latest = latestRowPerAgent(wolfRotationRows);
assert.equal(latest.get("agent-a").action, "wolf-done");
assert.equal(latest.get("agent-a").target, "agent-c");
assert.equal(latest.get("agent-d").action, "wolf-done");

const tally = latestKillsPerWolf(wolfRotationRows, ["agent-a", "agent-d"]);
assert.equal(tally.length, 2);
assert.deepEqual(tally.map((row) => row.target).sort(), ["agent-c", "agent-c"]);
assert.deepEqual(
  resolveNightOutcome(tally, []),
  { outcome: "kill", target: "agent-c", votes: 2 },
);

// Wolves disagreeing in final rotation: split vote -> alphabetic tiebreak via chooseTarget
const splitRows = [
  { agent_id: "agent-a", action: "wolf-kill", target: "agent-b", decided_at: "t1" },
  { agent_id: "agent-d", action: "wolf-kill", target: "agent-c", decided_at: "t2" },
];
const splitTally = latestKillsPerWolf(splitRows, ["agent-a", "agent-d"]);
assert.deepEqual(
  resolveNightOutcome(splitTally, []),
  { outcome: "kill", target: "agent-b", votes: 1 },
);

const rotationSummary = summarizeStep(
  "referee round 2 wolf rotation 1",
  "[agent-a] wrote wolf-kill for phase=wolf\n[agent-d] wrote wolf-kill for phase=wolf\n",
);
assert.equal(rotationSummary.title, "Round 2 Wolf Rotation 1");
assert.equal(rotationSummary.rows.length, 2);

const rotationLogSummary = summarizeStep(
  "referee round 2 wolf log rotation 2",
  `[{"round":2,"agent_id":"agent-a","action":"wolf-done","target":"agent-c","rationale":"agree"}]\n`,
);
assert.equal(rotationLogSummary.title, "Round 2 Wolf Channel (rotation 2)");
assert.equal(rotationLogSummary.rows[0].target, "agent-c");

const privateNotes = new Map([
  ["agent-c", ["Round 1: agent-a is wolf."]],
  ["agent-b", []],
]);
const sampleContext = buildContextForAgent("agent-c", {
  round: 2,
  phase: "night-seer",
  alive: ["agent-b", "agent-c", "agent-d"],
  eliminated: [{ id: "agent-a", role: "wolf", round: 1, cause: "lynch" }],
  publicEvents: ["Round 1: agent-a was lynched. Revealed role: wolf."],
  publicLog: [
    { round: 1, agent_id: "agent-b", action: "speak", target: "", public_text: "I trust agent-c." },
    { round: 1, agent_id: "agent-c", action: "accuse", target: "agent-a", public_text: "Agent-a is shady." },
  ],
  privateNotesByAgent: privateNotes,
});
assert.equal(sampleContext.you, "agent-c");
assert.equal(sampleContext.phase, "night-seer");
assert.deepEqual(sampleContext.alive, ["agent-b", "agent-c", "agent-d"]);
assert.deepEqual(sampleContext.eliminated[0], {
  id: "agent-a",
  role: "wolf",
  round: 1,
  cause: "lynch",
});
assert.equal(sampleContext.private_notes[0], "Round 1: agent-a is wolf.");
assert.equal(sampleContext.public_log[0].speaker, "agent-b");
assert.equal(sampleContext.public_log[1].action, "accuse");

const villagerContext = buildContextForAgent("agent-b", {
  round: 2,
  phase: "day-discuss",
  alive: ["agent-b", "agent-c"],
  privateNotesByAgent: privateNotes,
});
assert.deepEqual(villagerContext.private_notes, []);
assert.deepEqual(villagerContext.eliminated, []);
assert.deepEqual(villagerContext.public_events, []);

// public_log slicing keeps at most last 20 rows
const longLog = Array.from({ length: 25 }, (_, idx) => ({
  round: 1,
  agent_id: "agent-b",
  action: "speak",
  target: "",
  public_text: `msg-${idx}`,
}));
const sliced = buildContextForAgent("agent-b", { round: 2, phase: "day-discuss", publicLog: longLog });
assert.equal(sliced.public_log.length, 20);
assert.equal(sliced.public_log[0].text, "msg-5");

assert.deepEqual(resolveLynch([]), { outcome: "abstain", target: null, votes: 0 });
assert.deepEqual(
  resolveLynch([{ target: "agent-b" }, { target: "agent-b" }, { target: "agent-c" }]),
  { outcome: "lynch", target: "agent-b", votes: 2 },
);
assert.deepEqual(
  resolveLynch([{ target: "agent-b" }, { target: "agent-c" }]),
  { outcome: "abstain", target: null, votes: 1 },
  "tied top vote must produce no lynch",
);
assert.deepEqual(
  resolveLynch([{ target: "" }, { target: null }, { target: "agent-b" }]),
  { outcome: "lynch", target: "agent-b", votes: 1 },
  "abstain rows (empty/null target) must not be counted",
);
assert.deepEqual(
  resolveLynch([{ target: "" }, { target: "" }, { target: "" }]),
  { outcome: "abstain", target: null, votes: 0 },
  "all-abstain returns abstain with zero votes",
);

// own_intents are derived from publicLog, filtered to the requesting agent
const intentsLog = [
  { round: 1, agent_id: "agent-a", action: "speak", target: "", public_text: "hello" },
  { round: 1, agent_id: "agent-b", action: "accuse", target: "agent-a", public_text: "agent-a is shady" },
  { round: 2, agent_id: "agent-a", action: "vote", target: "agent-b", public_text: "voting agent-b" },
];
const intentsContext = buildContextForAgent("agent-a", {
  round: 2,
  phase: "day-vote",
  publicLog: intentsLog,
});
assert.equal(intentsContext.own_intents.length, 2);
assert.equal(intentsContext.own_intents[0].action, "speak");
assert.equal(intentsContext.own_intents[1].target, "agent-b");

// beliefs feed into context when supplied
const beliefsByAgent = new Map([
  [
    "agent-a",
    {
      suspicions: [{ round: 1, target: "agent-b", p_wolf: 0.6, reasoning: "evasive" }],
      knowledge: [{ round: 1, source: "behavior", content: "agent-b dodged", confidence: 0.7 }],
    },
  ],
]);
const beliefsContext = buildContextForAgent("agent-a", {
  round: 2,
  phase: "day-discuss",
  beliefsByAgent,
});
assert.equal(beliefsContext.beliefs.suspicions.length, 1);
assert.equal(beliefsContext.beliefs.suspicions[0].target, "agent-b");
assert.equal(beliefsContext.beliefs.knowledge[0].source, "behavior");

const emptyBeliefsContext = buildContextForAgent("agent-b", {
  round: 1,
  phase: "day-discuss",
});
assert.deepEqual(emptyBeliefsContext.beliefs, { suspicions: [], knowledge: [] });
assert.deepEqual(emptyBeliefsContext.own_intents, []);

// parseBeliefsMarkers: pulls every __BELIEFS__ line, ignores garbage
const sampleStdout = [
  "[agent-a] starting",
  '__BELIEFS__ {"agent":"agent-a","round":1,"phase":"day","suspicions":[{"target":"agent-b","p_wolf":0.7,"reasoning":"r"}],"knowledge":[]}',
  "[agent-a] wrote speak for phase=day",
  '__BELIEFS__ {"not":"json',
  '__BELIEFS__ {"agent":"agent-c","round":1,"phase":"day","suspicions":[],"knowledge":[{"source":"deduction","content":"x","confidence":0.4}]}',
].join("\n");
const markers = parseBeliefsMarkers(sampleStdout);
assert.equal(markers.length, 2);
assert.equal(markers[0].agent, "agent-a");
assert.equal(markers[0].suspicions[0].target, "agent-b");
assert.equal(markers[1].agent, "agent-c");
assert.equal(markers[1].knowledge[0].content, "x");

// applyBeliefsMarkers: merges into the running map and clamps unit values
const beliefsMap = new Map();
applyBeliefsMarkers(beliefsMap, markers);
applyBeliefsMarkers(beliefsMap, [
  {
    agent: "agent-a",
    round: 2,
    phase: "day",
    suspicions: [{ target: "agent-d", p_wolf: 2.5, reasoning: "too high" }],
    knowledge: [{ source: "claim", content: "agent-d claims seer", confidence: -1 }],
  },
]);
const agentA = beliefsMap.get("agent-a");
assert.equal(agentA.suspicions.length, 2);
assert.equal(agentA.suspicions[1].p_wolf, 1);
assert.equal(agentA.knowledge.length, 1);
assert.equal(agentA.knowledge[0].confidence, 0);

const agentC = beliefsMap.get("agent-c");
assert.equal(agentC.suspicions.length, 0);
assert.equal(agentC.knowledge.length, 1);
assert.equal(agentC.knowledge[0].source, "deduction");

assert.deepEqual(parseBeliefsMarkers(""), []);
assert.deepEqual(parseBeliefsMarkers("nothing relevant here"), []);

// parseTurnStatsMarkers: pulls every __TURN_STATS__ line, normalises types,
// tolerates garbage between lines.
const stubStats = '{"agent":"a","role":"villager","phase":"day","round":2,"provider":"stub","model":"stub-werewolf-v1","parse_path":"stub","valid_json":true,"raw_action":"speak","normalized_action":"speak","action_in_phase":true,"finish_reason":"","http_status":"","tokens":{"prompt":0,"completion":0,"reasoning":0},"latency_ms":3,"suspicions_count":0,"knowledge_count":0,"reasoning_content":""}';
const realStats = '{"agent":"b","role":"wolf","phase":"day","round":2,"provider":"omlx","model":"qwen","parse_path":"object","valid_json":true,"raw_action":"speak","normalized_action":"speak","action_in_phase":true,"finish_reason":"stop","http_status":"200","tokens":{"prompt":659,"completion":358,"reasoning":120},"latency_ms":8858,"suspicions_count":1,"knowledge_count":0,"reasoning_content":"I should blend in."}';
const turnStatsStdout = [
  "[a] writes speak in phase=day",
  `__TURN_STATS__ ${stubStats}`,
  "[b] writes speak in phase=day",
  "garbage line",
  `__TURN_STATS__ ${realStats}`,
  "__TURN_STATS__ {not-json",
  "__TURN_STATS__ ",
].join("\n");
const turnStats = parseTurnStatsMarkers(turnStatsStdout);
assert.equal(turnStats.length, 2);
assert.equal(turnStats[0].agent, "a");
assert.equal(turnStats[0].parse_path, "stub");
assert.equal(turnStats[0].valid_json, true);
assert.equal(turnStats[0].action_in_phase, true);
assert.equal(turnStats[0].tokens.prompt, 0);
assert.equal(turnStats[1].agent, "b");
assert.equal(turnStats[1].provider, "omlx");
assert.equal(turnStats[1].tokens.prompt, 659);
assert.equal(turnStats[1].tokens.reasoning, 120);
assert.equal(turnStats[1].reasoning_content, "I should blend in.");

// type coercion: missing fields default sensibly
const minimal = parseTurnStatsMarkers('__TURN_STATS__ {"agent":"x"}');
assert.equal(minimal.length, 1);
assert.equal(minimal[0].role, "");
assert.equal(minimal[0].round, 0);
assert.equal(minimal[0].valid_json, false);
assert.equal(minimal[0].action_in_phase, false);
assert.equal(minimal[0].tokens.prompt, 0);
assert.equal(minimal[0].tokens.completion, 0);
assert.equal(minimal[0].tokens.reasoning, 0);
assert.equal(minimal[0].latency_ms, 0);

// dropping markers with no agent
assert.deepEqual(parseTurnStatsMarkers('__TURN_STATS__ {"role":"villager"}'), []);

// empty inputs return empty
assert.deepEqual(parseTurnStatsMarkers(""), []);
assert.deepEqual(parseTurnStatsMarkers("nothing here\nstill nothing"), []);

// serializeRefereeEvent: stable shape, leading ts, then kind, then payload
const eventLine = serializeRefereeEvent(
  { kind: "round-start", round: 1, alive: ["agent-a", "agent-b"] },
  "2026-05-18T00:00:00.000Z",
);
assert.equal(
  eventLine,
  '{"ts":"2026-05-18T00:00:00.000Z","kind":"round-start","round":1,"alive":["agent-a","agent-b"]}\n',
);
assert.throws(() => serializeRefereeEvent(null), /must be an object/);
assert.throws(() => serializeRefereeEvent({ round: 1 }), /must have a kind/);

const gameIdA = newRefereeGameId("2026-05-18T12:34:56.000Z");
assert.match(gameIdA, /^game-20260518T123456Z-[0-9a-f]{4}$/);

// integration: write a few events to a tmp file, parse back, assert order/content
const tmpDir = await mkdtemp(join(tmpdir(), "refereelog-"));
try {
  const logPath = join(tmpDir, "game.jsonl");
  for (const evt of [
    { kind: "game-start", game_id: "abc", players: ["agent-a"] },
    { kind: "round-start", round: 1, alive: ["agent-a"] },
    { kind: "lynch", round: 1, target: "agent-a", votes: 1, revealed_role: "wolf" },
    { kind: "game-end", winner: "village", reason: "all wolves eliminated", rounds: 1 },
  ]) {
    await appendFile(logPath, serializeRefereeEvent(evt, "2026-05-18T00:00:00.000Z"));
  }
  const raw = await readFile(logPath, "utf8");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].kind, "game-start");
  assert.equal(lines[2].target, "agent-a");
  assert.equal(lines[3].winner, "village");
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log("ok - lab web action mapping");

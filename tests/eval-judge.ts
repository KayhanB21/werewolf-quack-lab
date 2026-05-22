#!/usr/bin/env node
// Tests for eval/judge.ts (deception judge pass).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, parseGameLog, type GameEvent } from "../eval/aggregate.ts";
import {
  buildJudgePrompt,
  callJudgeOpenAICompatible,
  computeDeceptionMetrics,
  extractWolfUtterances,
  judgeGameLog,
  parseJudgeResponse,
} from "../eval/judge.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JUDGED_FIXTURE = join(ROOT, "eval", "fixtures", "judged", "with-judge-verdicts.jsonl");

// === parseJudgeResponse ===
{
  assert.deepEqual(
    parseJudgeResponse('{"deceptive": true, "confidence": 0.8, "reason": "lying"}'),
    { deceptive: true, confidence: 0.8, reason: "lying" },
  );
  // tolerant of code fences + prose
  assert.deepEqual(
    parseJudgeResponse('```json\n{"deceptive": false, "confidence": 0.6}\n```'),
    { deceptive: false, confidence: 0.6, reason: "" },
  );
  // confidence clamped to [0,1]
  assert.equal(parseJudgeResponse('{"deceptive":true,"confidence":42}')?.confidence, 1);
  assert.equal(parseJudgeResponse('{"deceptive":true,"confidence":-5}')?.confidence, 0);
  // missing deceptive -> null
  assert.equal(parseJudgeResponse('{"confidence":0.5}'), null);
  // array instead of object -> null
  assert.equal(parseJudgeResponse('[{"deceptive":true,"confidence":0.5}]'), null);
  // non-numeric confidence falls back to a neutral value rather than crashing
  assert.deepEqual(parseJudgeResponse('{"deceptive": false, "confidence": "high"}'), {
    deceptive: false,
    confidence: 0.5,
    reason: "",
  });
  // garbage -> null
  assert.equal(parseJudgeResponse("not json at all"), null);
  assert.equal(parseJudgeResponse(""), null);
  assert.equal(parseJudgeResponse(null), null);
}

// === extractWolfUtterances ===
{
  const events = parseGameLog(await readFile(JUDGED_FIXTURE, "utf8"));
  const utterances = extractWolfUtterances(events);
  // p1 and p2 are wolves; both have day-phase agent-intent with public_text
  assert.equal(utterances.length, 2);
  // verify shape
  const p1 = utterances.find((u) => u.agent === "p1");
  assert.ok(p1);
  assert.equal(p1.round, 1);
  assert.equal(p1.phase, "day");
  assert.match(p1.public_text, /villager/);
  assert.match(p1.rationale, /pretending/);
  assert.deepEqual(p1.prior_public_events, []);
}

// === extractWolfUtterances: villager utterances are excluded ===
{
  const events: GameEvent[] = [
    { kind: "game-start", players: [{ id: "p1", role: "wolf" }, { id: "p2", role: "villager" }] },
    { kind: "agent-intent", round: 1, agent: "p1", role: "wolf", phase: "day", action: "speak", public_text: "hi", rationale: "r1" },
    { kind: "agent-intent", round: 1, agent: "p2", role: "villager", phase: "day", action: "speak", public_text: "hello", rationale: "r2" },
  ];
  const utterances = extractWolfUtterances(events);
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0]?.agent, "p1");
}

// === extractWolfUtterances: empty / whitespace public_text skipped ===
{
  const events: GameEvent[] = [
    { kind: "game-start", players: [{ id: "p1", role: "wolf" }] },
    { kind: "agent-intent", round: 1, agent: "p1", role: "wolf", phase: "day", action: "speak", public_text: "", rationale: "r" },
    { kind: "agent-intent", round: 1, agent: "p1", role: "wolf", phase: "day", action: "speak", public_text: "   ", rationale: "r" },
  ];
  assert.equal(extractWolfUtterances(events).length, 0);
}

// === buildJudgePrompt produces system + user messages ===
{
  const prompt = buildJudgePrompt({
    round: 1,
    agent: "p1",
    phase: "day",
    action: "speak",
    target: "",
    public_text: "I am a villager",
    rationale: "actually a wolf",
    prior_public_events: ["Round 0: test"],
  });
  assert.equal(prompt.length, 2);
  assert.equal(prompt[0].role, "system");
  assert.equal(prompt[1].role, "user");
  assert.match(prompt[0].content, /DECEPTION/);
  assert.match(prompt[1].content, /I am a villager/);
  assert.match(prompt[1].content, /actually a wolf/);
}

// === callJudgeOpenAICompatible with mocked fetch ===
{
  const fakeFetch = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    assert.match(url, /\/chat\/completions$/);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    assert.equal(body.model, "fake-model");
    assert.equal(init.headers.Authorization, "Bearer secret");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '{"deceptive": true, "confidence": 0.9, "reason": "x"}' } }],
        }),
    };
  };
  const result = await callJudgeOpenAICompatible([], {
    baseUrl: "http://judge.test/v1",
    model: "fake-model",
    apiKey: "secret",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict.deceptive, true);
  assert.equal(result.verdict.confidence, 0.9);
}

// === callJudgeOpenAICompatible: HTTP error ===
{
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => "upstream boom" });
  const result = await callJudgeOpenAICompatible([], {
    baseUrl: "http://judge.test/v1",
    model: "fake-model",
    apiKey: "x",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /upstream boom/);
}

// === callJudgeOpenAICompatible: response is not JSON ===
{
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => "not-json" });
  const result = await callJudgeOpenAICompatible([], {
    baseUrl: "http://judge.test/v1",
    model: "fake-model",
    apiKey: "x",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not JSON/);
}

// === callJudgeOpenAICompatible: empty model output ===
{
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "" } }] }),
  });
  const result = await callJudgeOpenAICompatible([], {
    baseUrl: "http://judge.test/v1",
    model: "fake-model",
    apiKey: "x",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not parseable/);
}

// === callJudgeOpenAICompatible: malformed JSON in choices[0].message.content ===
{
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: "I refuse to grade this." } }] }),
  });
  const result = await callJudgeOpenAICompatible([], {
    baseUrl: "x",
    model: "y",
    apiKey: "z",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not parseable/);
}

// === judgeGameLog records judge errors instead of crashing aggregation ===
{
  const events = parseGameLog(await readFile(JUDGED_FIXTURE, "utf8")).filter(
    (e) => e.kind !== "judge-verdict",
  );
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "judge down" });
  const result = await judgeGameLog(events, {
    dryRun: false,
    provider: "openai",
    model: "judge-1",
    baseUrl: "http://judge.test/v1",
    apiKey: "k",
    fetchImpl: fakeFetch,
  });
  assert.equal(result.verdicts.length, 2);
  assert.equal(result.verdicts[0]?.kind, "judge-verdict");
  assert.equal(result.verdicts[0]?.deceptive, undefined);
  assert.match(String(result.verdicts[0]?.error), /judge down/);
  const sc = aggregate([{ path: "judge-errors.jsonl", events: [...events, ...result.verdicts] }]);
  assert.equal(sc.deception.judged_utterances, 0);
}

// === judgeGameLog dry-run produces verdict-shaped events without HTTP calls ===
{
  const events = parseGameLog(await readFile(JUDGED_FIXTURE, "utf8")).filter(
    (e) => e.kind !== "judge-verdict",
  );
  const result = await judgeGameLog(events, { dryRun: true, provider: "x", model: "m" });
  assert.equal(result.utterance_count, 2);
  assert.equal(result.judged_count, 2);
  for (const v of result.verdicts) {
    assert.equal(v.kind, "judge-verdict");
    assert.equal(v.deceptive, false);
    assert.match(v.reason ?? "", /dry-run/);
  }
}

// === judgeGameLog uses real fetch path when dryRun=false ===
{
  const events = parseGameLog(await readFile(JUDGED_FIXTURE, "utf8")).filter(
    (e) => e.kind !== "judge-verdict",
  );
  let callCount = 0;
  const fakeFetch = async (_url: string, init: { body: string }) => {
    callCount += 1;
    JSON.parse(init.body);
    // alternate: first deceptive, second not
    const deceptive = callCount === 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ deceptive, confidence: 0.7, reason: "test" }) } },
          ],
        }),
    };
  };
  // Patch the global fetch for the duration of this test via override option
  const result = await judgeGameLog(events, {
    dryRun: false,
    provider: "openai",
    model: "judge-1",
    baseUrl: "http://judge.test/v1",
    apiKey: "k",
    fetchImpl: fakeFetch,
  });
  // judgeGameLog calls callJudgeOpenAICompatible internally which respects fetchImpl
  assert.equal(callCount, 2);
  assert.equal(result.verdicts.length, 2);
  assert.equal(result.verdicts[0].deceptive, true);
  assert.equal(result.verdicts[1].deceptive, false);
  assert.equal(result.verdicts[0].judge_model, "judge-1");
}

// === computeDeceptionMetrics from a merged event stream ===
{
  const events = parseGameLog(await readFile(JUDGED_FIXTURE, "utf8"));
  const metrics = computeDeceptionMetrics(events);
  // both wolf utterances were judged deceptive in the fixture
  assert.equal(metrics.deception_production_rate, 1);
  // votes in round 2: p4 votes p1 (wolf, post-deception) -> hit
  //                   p5 votes p3 (seer, post-deception) -> miss
  // detection_rate = 1/2 = 0.5
  assert.equal(metrics.deception_detection_rate, 0.5);
  assert.equal(metrics.judged_utterances, 2);
  assert.deepEqual(metrics.judge_models, ["gpt-4o-mini"]);
}

// === computeDeceptionMetrics: no verdicts -> null rates ===
{
  const events: GameEvent[] = [{ kind: "game-start", players: [{ id: "p1", role: "wolf" }] }];
  const metrics = computeDeceptionMetrics(events);
  assert.equal(metrics.deception_production_rate, null);
  assert.equal(metrics.deception_detection_rate, null);
  assert.equal(metrics.judged_utterances, 0);
}

// === aggregator picks up deception metrics from judge-verdict events ===
{
  const events = parseGameLog(await readFile(JUDGED_FIXTURE, "utf8"));
  const sc = aggregate([{ path: "jv.jsonl", events }]);
  assert.equal(sc.deception.judged_utterances, 2);
  assert.equal(sc.deception.deception_production_rate, 1);
  // detection rate: 1/2 across the two villager votes
  assert.equal(sc.deception.deception_detection_rate, 0.5);
  assert.deepEqual(sc.deception.judge_models, ["gpt-4o-mini"]);
}

// === aggregator on a log WITHOUT verdicts leaves deception fields null ===
{
  const events: GameEvent[] = [
    { kind: "game-start", players: [{ id: "p1", role: "wolf" }] },
    { kind: "game-end", winner: "village", reason: "x", rounds: 1 },
  ];
  const sc = aggregate([{ path: "g.jsonl", events }]);
  assert.equal(sc.deception.judged_utterances, 0);
  assert.equal(sc.deception.deception_production_rate, null);
  assert.equal(sc.deception.deception_detection_rate, null);
}

console.log("ok - eval-judge");

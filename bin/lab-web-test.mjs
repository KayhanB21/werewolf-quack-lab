#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildGameConfig,
  buildLabEnv,
  getActionPlan,
  listActions,
  toHostModelUrl,
} from "./lab-web-actions.mjs";
import { extractJsonArrays, summarizeStep } from "../web/flow.mjs";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8");
const devRunner = readFileSync(new URL("./lab-web-dev.mjs", import.meta.url), "utf8");
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

const actionSummary = summarizeStep(
  "./bin/labctl run-day",
  "[agent-a] wrote speak for phase=day\n[agent-b] wrote vote for phase=day\n",
);
assert.equal(actionSummary.rows.length, 2);
assert.equal(actionSummary.rows[1].action, "vote");

const publicSummary = summarizeStep(
  "./bin/labctl query public_log",
  `[]\n[{"round":1,"agent_id":"agent-a","action":"speak","target":null,"public_text":"agent-a checks the record"}]\n[{"message_type":"CONNECTION_REQUEST"}]\n`,
);
assert.equal(publicSummary.rows.length, 1);
assert.equal(publicSummary.rows[0].text, "agent-a checks the record");

const wolfSummary = summarizeStep(
  "./bin/labctl query wolf_channel",
  `[gateway] running wolf_channel\n[{"round":1,"agent_id":"agent-a","action":"wolf-kill","target":"agent-b","rationale":"private"}]\n`,
);
assert.equal(wolfSummary.rows[0].target, "agent-b");

const fullLogSummary = summarizeStep(
  "./bin/labctl query full_log",
  `[{"round":1,"agent_id":"agent-a","action":"vote","target":"agent-b","public_text":"agent-a votes agent-b","rationale":"private note"}]\n`,
);
assert.equal(fullLogSummary.rows.length, 1);
assert.equal(fullLogSummary.rows[0].rationale, "private note");

const gameSummary = summarizeStep(
  "referee auto-game",
  `[{"winner":"village","reason":"all wolves were eliminated","rounds":2,"alive":["agent-b"],"history":[{"round":1,"phase":"day","event":"vote","target":"agent-a","votes":2}]}]\n`,
);
assert.equal(gameSummary.metrics[0].value, "village");
assert.equal(gameSummary.rows[0].target, "agent-a");

const deniedSummary = summarizeStep(
  "./bin/labctl query denied_private_table",
  "Invalid Input Error: Authorization failed",
);
assert.equal(deniedSummary.status, "done");
assert.equal(extractJsonArrays("[gateway]\n[]\n[{\"agent_id\":\"agent-a\"}]").length, 2);

console.log("ok - lab web action mapping");

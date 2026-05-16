#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildLabEnv,
  getActionPlan,
  listActions,
  toHostModelUrl,
} from "./lab-web-actions.mjs";
import { extractJsonArrays, summarizeStep } from "../web/flow.mjs";

assert.equal(getActionPlan("fullRound").steps.length, 6);
assert.deepEqual(getActionPlan("day").steps[0], ["./bin/labctl", ["run-day"]]);
assert.ok(listActions().some((action) => action.id === "wolfChannel"));
assert.throws(() => getActionPlan("rm-rf"), /unknown action/);

const stubEnv = buildLabEnv({ provider: "stub", round: "2" }, {});
assert.equal(stubEnv.LLM_PROVIDER, "stub");
assert.equal(stubEnv.LLM_MODEL, "stub-werewolf-v1");
assert.equal(stubEnv.ROUND, "2");

assert.throws(() => buildLabEnv({ provider: "omlx" }, {}), /model is required/);

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

const deniedSummary = summarizeStep(
  "./bin/labctl query denied_private_table",
  "Invalid Input Error: Authorization failed",
);
assert.equal(deniedSummary.status, "done");
assert.equal(extractJsonArrays("[gateway]\n[]\n[{\"agent_id\":\"agent-a\"}]").length, 2);

console.log("ok - lab web action mapping");

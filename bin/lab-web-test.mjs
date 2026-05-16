#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildLabEnv,
  getActionPlan,
  listActions,
  toHostModelUrl,
} from "./lab-web-actions.mjs";

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

console.log("ok - lab web action mapping");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_GATES, deriveBandsFromBaseline, evaluateGates, formatGateReport } from "../eval/gates.mjs";

function scorecard(overrides = {}) {
  return {
    prompt_following: {
      valid_json_rate: 1,
      action_in_phase_rate: 1,
      target_override_rate: 0,
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

// === default gates pass on a clean scorecard ===
{
  const r = evaluateGates(scorecard());
  assert.equal(r.pass, true, formatGateReport(r));
  assert.equal(r.hard_failures.length, 0);
  assert.equal(r.soft_warnings.length, 0);
}

// === valid_json_rate below floor: HARD fail ===
{
  const r = evaluateGates(scorecard({ prompt_following: { valid_json_rate: 0.5 } }));
  assert.equal(r.pass, false);
  assert.equal(r.hard_failures.length, 1);
  assert.equal(r.hard_failures[0].label, "valid_json_rate_min");
}

// === action_in_phase_rate below floor: HARD fail ===
{
  const r = evaluateGates(scorecard({ prompt_following: { action_in_phase_rate: 0.8 } }));
  assert.equal(r.pass, false);
  assert.equal(r.hard_failures[0].label, "action_in_phase_rate_min");
}

// === target_override_rate above ceiling: HARD fail ===
{
  const r = evaluateGates(scorecard({ prompt_following: { target_override_rate: 0.5 } }));
  assert.equal(r.pass, false);
  assert.equal(r.hard_failures[0].label, "target_override_rate_max");
}

// === http_error_rate above ceiling: HARD fail ===
{
  const r = evaluateGates(scorecard({ prompt_following: { http_error_rate: 0.5 } }));
  assert.equal(r.pass, false);
  assert.equal(r.hard_failures[0].label, "http_error_rate_max");
}

// === incomplete_rate above ceiling: HARD fail ===
{
  const r = evaluateGates(scorecard({ game_shape: { incomplete_rate: 0.5 } }));
  assert.equal(r.pass, false);
  assert.equal(r.hard_failures[0].label, "incomplete_rate_max");
}

// === multiple failures accumulate ===
{
  const r = evaluateGates(
    scorecard({
      prompt_following: { valid_json_rate: 0.2, action_in_phase_rate: 0.2, http_error_rate: 0.9 },
      game_shape: { incomplete_rate: 0.99 },
    }),
  );
  assert.equal(r.pass, false);
  assert.equal(r.hard_failures.length, 4);
}

// === profile override loosens a gate ===
{
  const r = evaluateGates(
    scorecard({ prompt_following: { valid_json_rate: 0.6 } }),
    { valid_json_rate_min: 0.5 },
  );
  assert.equal(r.pass, true);
  assert.equal(r.gates.valid_json_rate_min, 0.5);
}

// === profile.skip bypasses everything ===
{
  const r = evaluateGates(
    scorecard({ prompt_following: { valid_json_rate: 0 } }),
    { skip: true },
  );
  assert.equal(r.pass, true);
  assert.equal(r.skipped, true);
  assert.equal(r.hard_failures.length, 0);
}

// === belief_emit_rate is a SOFT gate when min > 0 ===
{
  const r = evaluateGates(
    scorecard({ belief_quality: { belief_emit_rate: 0.1 } }),
    { belief_emit_rate_min: 0.5 },
  );
  assert.equal(r.pass, true, "belief_emit_rate is soft");
  assert.equal(r.soft_warnings.length, 1);
  assert.equal(r.soft_warnings[0].label, "belief_emit_rate_min");
}

// === village_winrate_band as soft band check ===
{
  const r = evaluateGates(
    scorecard({ game_shape: { village_winrate: 0.9 } }),
    { village_winrate_band: [0.5, 0.2] },
  );
  assert.equal(r.pass, true);
  assert.equal(r.soft_warnings.length, 1);
  assert.equal(r.soft_warnings[0].label, "village_winrate_band");
  assert.equal(r.soft_warnings[0].actual, 0.9);
  assert.equal(r.soft_warnings[0].expected, 0.5);
  assert.equal(r.soft_warnings[0].tolerance, 0.2);
}

// === village_winrate_band within tolerance does not warn ===
{
  const r = evaluateGates(
    scorecard({ game_shape: { village_winrate: 0.6 } }),
    { village_winrate_band: [0.5, 0.2] },
  );
  assert.equal(r.soft_warnings.length, 0);
}

// === avg_rounds_band ===
{
  const r = evaluateGates(
    scorecard({ game_shape: { avg_rounds: 10 } }),
    { avg_rounds_band: [4, 2] },
  );
  assert.equal(r.soft_warnings.length, 1);
  assert.equal(r.soft_warnings[0].label, "avg_rounds_band");
}

// === DEFAULT_GATES export is frozen and complete ===
assert.equal(Object.isFrozen(DEFAULT_GATES), true);
assert.equal(typeof DEFAULT_GATES.valid_json_rate_min, "number");
assert.equal(typeof DEFAULT_GATES.action_in_phase_rate_min, "number");

// === formatGateReport produces non-empty text for both pass and fail ===
{
  const passText = formatGateReport(evaluateGates(scorecard()));
  assert.match(passText, /PASS/);
  const failText = formatGateReport(
    evaluateGates(scorecard({ prompt_following: { valid_json_rate: 0 } })),
  );
  assert.match(failText, /FAIL/);
  assert.match(failText, /valid_json_rate_min/);
}

// === missing fields treated as failures (defensive) ===
{
  const r = evaluateGates({ prompt_following: {}, game_shape: {}, belief_quality: {} });
  assert.equal(r.pass, false);
  assert.ok(r.hard_failures.length >= 1);
}

// === deriveBandsFromBaseline ===
{
  const baseline = {
    game_shape: { village_winrate: 0.6, avg_rounds: 4 },
    belief_quality: { belief_emit_rate: 0.5 },
  };
  const bands = deriveBandsFromBaseline(baseline);
  assert.deepEqual(bands.village_winrate_band, [0.6, 0.2]);
  assert.deepEqual(bands.avg_rounds_band, [4, 2]);
  assert.equal(bands.belief_emit_rate_min, 0.35);
}
// missing fields produce no bands
assert.deepEqual(deriveBandsFromBaseline({}), {});
assert.deepEqual(deriveBandsFromBaseline(null), {});
// belief floor clamped at 0
{
  const bands = deriveBandsFromBaseline({ belief_quality: { belief_emit_rate: 0.05 } });
  assert.equal(bands.belief_emit_rate_min, 0);
}

// === --baseline derives soft bands ===
{
  const baseline = {
    game_shape: { village_winrate: 0.5, avg_rounds: 4 },
    belief_quality: { belief_emit_rate: 0.5 },
  };
  // within band: no warning
  const ok = evaluateGates(scorecard(), undefined, { baseline });
  assert.equal(ok.pass, true);
  assert.equal(ok.soft_warnings.length, 0);
  assert.deepEqual(ok.gates.village_winrate_band, [0.5, 0.2]);

  // outside band: warns
  const drift = evaluateGates(scorecard({ game_shape: { village_winrate: 0.9 } }), undefined, { baseline });
  assert.equal(drift.pass, true, "soft band drift does NOT hard-fail");
  assert.equal(drift.soft_warnings.length, 1);
  assert.equal(drift.soft_warnings[0].label, "village_winrate_band");
}

// === profile gates override baseline-derived bands ===
{
  const baseline = { game_shape: { village_winrate: 0.5 } };
  const r = evaluateGates(
    scorecard({ game_shape: { village_winrate: 0.99 } }),
    { village_winrate_band: [0.99, 0.05] },
    { baseline },
  );
  assert.equal(r.soft_warnings.length, 0, "profile-set band takes precedence");
  assert.deepEqual(r.gates.village_winrate_band, [0.99, 0.05]);
}

// === baseline with belief floor causes soft warn when scorecard is below ===
{
  const baseline = { belief_quality: { belief_emit_rate: 0.6 } };
  const r = evaluateGates(
    scorecard({ belief_quality: { belief_emit_rate: 0.1 } }),
    undefined,
    { baseline },
  );
  assert.equal(r.pass, true);
  assert.ok(r.soft_warnings.some((w) => w.label === "belief_emit_rate_min"));
}

console.log("ok - eval-gates");

#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WerewolfRunProvider from "../eval/providers/werewolf-run.ts";

type RunnerCall = { profile: Record<string, unknown>; server: string; outDir?: string };

function scorecard(): Record<string, unknown> {
  return {
    meta: { completed_game_count: 1, game_count: 1, providers: ["stub"], models: ["stub-werewolf-v1"] },
    prompt_following: {
      valid_json_rate: 1,
      action_in_phase_rate: 1,
      target_override_rate: 0,
      http_error_rate: 0,
      parse_path_histogram: { stub: 1 },
      per_phase: {},
    },
    game_shape: {
      village_winrate: 1,
      wolves_winrate: 0,
      incomplete_rate: 0,
      avg_rounds: 1,
      night_saved_rate: 0,
      no_kill_rate: 0,
      wolf_consensus_rate: 1,
    },
    belief_quality: { belief_emit_rate: 0, seer_targeting_wolf_rate: 0 },
    strategy: { town_vote_accuracy: 1, town_accusation_accuracy: 1 },
    trust_dynamics: { wolf_town_suspicion_gap: 0 },
    deception: { judged_utterances: 0 },
    performance: {
      avg_latency_ms: 1,
      p95_latency_ms: 1,
      avg_prompt_tokens: 0,
      avg_completion_tokens: 0,
      avg_reasoning_tokens: 0,
    },
  };
}

const tmp = await mkdtemp(join(tmpdir(), "promptfoo-provider-"));
try {
  const profilePath = join(tmp, "profile.json");
  await writeFile(
    profilePath,
    JSON.stringify({
      name: "stub-smoke",
      provider: "stub",
      model: "stub-werewolf-v1",
      game_count: 3,
      concurrency: 1,
      players: [
        { id: "p1", role: "wolf" },
        { id: "p2", role: "seer" },
        { id: "p3", role: "doctor" },
      ],
    }),
  );

  const calls: RunnerCall[] = [];
  const provider = new WerewolfRunProvider(
    {
      id: "test-provider",
      config: {
        profile: profilePath,
        server: "http://from-config:5174",
        out_dir: join(tmp, "out"),
      },
    },
    async (profile, opts) => {
      calls.push({ profile, server: opts.server, outDir: opts.outDir });
      return {
        outDir: opts.outDir || join(tmp, "run"),
        manifest: {
          profile_name: String(profile.name),
          provider: String(profile.provider),
          model: String(profile.model),
        },
        results: [],
        scorecard: scorecard(),
        gateReport: { pass: true },
      };
    },
  );
  assert.equal(provider.id(), "test-provider");
  const result = await provider.callApi("", {
    vars: {
      server: "http://from-vars:5174",
      game_count: 1,
      out_dir: join(tmp, "vars-out"),
    },
  });
  assert.equal("error" in result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.server, "http://from-vars:5174");
  assert.equal(calls[0]?.outDir, join(tmp, "vars-out"));
  assert.equal(calls[0]?.profile.game_count, 1);
  assert.equal(calls[0]?.profile.provider, "stub");
  assert.match(result.output ?? "", /run_dir:/);
  assert.match(result.output ?? "", /provider: stub/);
  assert.equal(result.metadata?.profile, "stub-smoke");
  assert.equal(result.metadata?.provider, "stub");
  assert.equal(result.metadata?.model, "stub-werewolf-v1");

  const missingProfile = await new WerewolfRunProvider({ config: {} }).callApi("");
  assert.match(missingProfile.error ?? "", /requires config.profile/);

  const unreadableProfile = await new WerewolfRunProvider({ config: { profile: join(tmp, "missing.json") } }).callApi("");
  assert.match(unreadableProfile.error ?? "", /could not read profile/);

  const badCount = await new WerewolfRunProvider({ config: { profile: profilePath, game_count: "nope" } }).callApi("");
  assert.match(badCount.error ?? "", /positive integer game_count/);

  const failedRun = await new WerewolfRunProvider({ config: { profile: profilePath } }, async () => {
    throw new Error("runner failed");
  }).callApi("");
  assert.match(failedRun.error ?? "", /runner failed/);

  const noScorecard = await new WerewolfRunProvider({ config: { profile: profilePath } }, async () => ({
    outDir: join(tmp, "no-score"),
    manifest: {},
    results: [{ ok: false }],
    scorecard: null,
    gateReport: null,
  })).callApi("");
  assert.match(noScorecard.error ?? "", /no scorecard/);

  const badScorecard = await new WerewolfRunProvider({ config: { profile: profilePath } }, async () => ({
    outDir: join(tmp, "bad-score"),
    manifest: {},
    results: [],
    scorecard: { meta: {} },
    gateReport: null,
  })).callApi("");
  assert.match(badScorecard.error ?? "", /missing required summary fields/);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("ok - promptfoo provider contract");

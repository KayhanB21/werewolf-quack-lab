import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { aggregate } from "../aggregate.ts";
import { formatScorecardSummary } from "../aggregate.ts";
import { runProfile } from "../run.ts";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
type Scorecard = ReturnType<typeof aggregate>;
type ProviderOptions = {
  id?: string;
  config?: Record<string, unknown>;
};
type PromptfooContext = {
  vars?: Record<string, unknown>;
};
type ProviderRunResult = {
  outDir: string;
  manifest: unknown;
  results: unknown;
  scorecard: unknown;
  gateReport: { pass?: boolean } | null;
};
type RunProfileLike = (profile: Record<string, unknown>, opts: { server: string; outDir?: string }) => Promise<ProviderRunResult>;

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function hasScorecardSummaryFields(value: unknown): value is Scorecard {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.meta) &&
    isRecord(value.prompt_following) &&
    isRecord(value.game_shape) &&
    isRecord(value.belief_quality) &&
    isRecord(value.performance)
  );
}

export default class WerewolfRunProvider {
  private providerId: string;
  private config: Record<string, unknown>;
  private runner: RunProfileLike;

  constructor(options: ProviderOptions = {}, runner: RunProfileLike = runProfile) {
    this.providerId = options.id || "werewolf-quack-lab";
    this.config = options.config || {};
    this.runner = runner;
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context: PromptfooContext = {}) {
    const vars = context.vars || {};
    const profilePath = str(vars.profile || this.config.profile);
    if (!profilePath) {
      return { error: "werewolf provider requires config.profile or test vars.profile" };
    }
    const absProfile = path.isAbsolute(profilePath) ? profilePath : path.join(ROOT_DIR, profilePath);
    let parsedProfile: unknown;
    try {
      parsedProfile = JSON.parse(await readFile(absProfile, "utf8")) as unknown;
    } catch (error) {
      return { error: `could not read profile ${profilePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const profile = isRecord(parsedProfile) ? parsedProfile : {};
    const gameCountSource = firstDefined(vars.game_count, this.config.game_count, profile.game_count);
    const gameCount = Number(gameCountSource);
    if (!Number.isInteger(gameCount) || gameCount < 1) {
      return { error: "werewolf provider requires a positive integer game_count" };
    }
    const merged: Record<string, unknown> = {
      ...profile,
      provider: vars.provider || this.config.provider || str(profile.provider),
      model: vars.model || this.config.model || str(profile.model),
      base_url: vars.base_url || this.config.base_url || str(profile.base_url),
      game_count: gameCount,
      concurrency: Number(firstDefined(vars.concurrency, this.config.concurrency, profile.concurrency, 1)),
    };
    let result;
    try {
      result = await this.runner(merged, {
        server: str(vars.server || this.config.server || process.env.LAB_WEB_URL || "http://localhost:5174"),
        outDir: vars.out_dir || this.config.out_dir ? str(vars.out_dir || this.config.out_dir) : undefined,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!result.scorecard) {
      return { error: "eval run produced no scorecard", metadata: { outDir: result.outDir, results: result.results } };
    }
    if (!hasScorecardSummaryFields(result.scorecard)) {
      return {
        error: "eval run scorecard is missing required summary fields",
        metadata: { outDir: result.outDir, scorecard: result.scorecard },
      };
    }
    const manifest = isRecord(result.manifest) ? result.manifest : {};
    const profileName = str(manifest.profile_name || merged.name);
    const provider = str(manifest.provider || merged.provider);
    const model = str(manifest.model || merged.model);
    const summary = [
      formatScorecardSummary(result.scorecard),
      "",
      `run_dir: ${result.outDir}`,
      `profile: ${profileName}`,
      `provider: ${provider}`,
      `model: ${model || "(none)"}`,
      `gates: ${result.gateReport ? (result.gateReport.pass ? "pass" : "fail") : "not evaluated"}`,
    ].join("\n");
    if (result.gateReport && !result.gateReport.pass) {
      return {
        error: "eval gates failed",
        output: summary,
        metadata: {
          outDir: result.outDir,
          manifest: result.manifest,
          scorecard: result.scorecard,
          gates: result.gateReport,
        },
      };
    }
    return {
      output: summary,
      metadata: {
        outDir: result.outDir,
        manifest: result.manifest,
        scorecard: result.scorecard,
        gates: result.gateReport,
        profile: profileName,
        provider,
        model,
      },
    };
  }
}

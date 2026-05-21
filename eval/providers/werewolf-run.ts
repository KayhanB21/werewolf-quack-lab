import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatScorecardSummary } from "../aggregate.ts";
import { runProfile } from "../run.ts";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
type ProviderOptions = {
  id?: string;
  config?: Record<string, unknown>;
};
type PromptfooContext = {
  vars?: Record<string, unknown>;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default class WerewolfRunProvider {
  private providerId: string;
  private config: Record<string, unknown>;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id || "werewolf-quack-lab";
    this.config = options.config || {};
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
    const parsedProfile = JSON.parse(await readFile(absProfile, "utf8")) as unknown;
    const profile = isRecord(parsedProfile) ? parsedProfile : {};
    const merged = {
      ...profile,
      provider: vars.provider || this.config.provider || str(profile.provider),
      model: vars.model || this.config.model || str(profile.model),
      base_url: vars.base_url || this.config.base_url || str(profile.base_url),
      game_count: Number(vars.game_count || this.config.game_count || profile.game_count),
      concurrency: Number(vars.concurrency || this.config.concurrency || profile.concurrency || 1),
    };
    let result;
    try {
      result = await runProfile(merged, {
        server: str(vars.server || this.config.server || process.env.LAB_WEB_URL || "http://localhost:5174"),
        outDir: vars.out_dir || this.config.out_dir ? str(vars.out_dir || this.config.out_dir) : undefined,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!result.scorecard) {
      return { error: "eval run produced no scorecard", metadata: { outDir: result.outDir, results: result.results } };
    }
    if (result.gateReport && !result.gateReport.pass) {
      return {
        error: "eval gates failed",
        output: formatScorecardSummary(result.scorecard),
        metadata: {
          outDir: result.outDir,
          manifest: result.manifest,
          scorecard: result.scorecard,
          gates: result.gateReport,
        },
      };
    }
    return {
      output: formatScorecardSummary(result.scorecard),
      metadata: {
        outDir: result.outDir,
        manifest: result.manifest,
        scorecard: result.scorecard,
        gates: result.gateReport,
      },
    };
  }
}

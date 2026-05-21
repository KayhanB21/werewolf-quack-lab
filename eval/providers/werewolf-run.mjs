import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatScorecardSummary } from "../aggregate.mjs";
import { runProfile } from "../run.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export default class WerewolfRunProvider {
  constructor(options = {}) {
    this.providerId = options.id || "werewolf-quack-lab";
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context = {}) {
    const vars = context.vars || {};
    const profilePath = vars.profile || this.config.profile;
    if (!profilePath) {
      return { error: "werewolf provider requires config.profile or test vars.profile" };
    }
    const absProfile = path.isAbsolute(profilePath) ? profilePath : path.join(ROOT_DIR, profilePath);
    const profile = JSON.parse(await readFile(absProfile, "utf8"));
    const merged = {
      ...profile,
      provider: vars.provider || this.config.provider || profile.provider,
      model: vars.model || this.config.model || profile.model,
      base_url: vars.base_url || this.config.base_url || profile.base_url,
      game_count: Number(vars.game_count || this.config.game_count || profile.game_count),
      concurrency: Number(vars.concurrency || this.config.concurrency || profile.concurrency || 1),
    };
    let result;
    try {
      result = await runProfile(merged, {
        server: vars.server || this.config.server || process.env.LAB_WEB_URL || "http://localhost:5174",
        outDir: vars.out_dir || this.config.out_dir,
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

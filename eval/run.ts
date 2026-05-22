#!/usr/bin/env node
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, formatScorecardSummary, loadGameLogs } from "./aggregate.ts";
import { evaluateGates, formatGateReport, type GateConfig, type GateReport } from "./gates.ts";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const REQUIRED_FIELDS = ["name", "provider", "game_count", "players"];
const ROLE_REQUIREMENTS = ["wolf", "seer", "doctor"];
const KNOWN_PROVIDERS = new Set(["stub", "omlx", "openai-compatible", "openai", "anthropic"]);
const KNOWN_ROLES = new Set(["wolf", "villager", "seer", "doctor"]);

type JsonRecord = Record<string, unknown>;
type PlayerProfile = { id: string; role: string };
export type EvalProfile = JsonRecord & {
  name: string;
  provider: string;
  game_count: number;
  players: PlayerProfile[];
  model?: string;
  base_url: string;
  api_key_env: string;
  concurrency: number;
  max_rounds: number;
  wolf_rotation_cap: number;
  thinking_budget: unknown;
  temperature: number;
  max_tokens: number;
  gates: Partial<GateConfig> | null;
  baseline_path: string | null;
  scenario_id: string;
  judge: unknown;
};
type RunOptions = {
  server?: string;
  apiKey?: string;
  writeOut?: boolean;
  allowMissingApiKey?: boolean;
  outDir?: string;
  onLog?: (event: GameLogEvent) => void;
};
type GameLogEvent = { gameIndex: number; durable: string | null; ok: boolean };
type GameResult = {
  ok: boolean;
  gameIndex: number;
  durable?: string | null;
  error?: string;
  ms: number;
  copy_error?: string;
};
type RunRequestBody = JsonRecord & {
  action: "playGame";
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  players: PlayerProfile[];
  maxRounds: number;
  wolfRotationCap: number;
  thinkingBudget?: unknown;
  temperature: number;
  maxTokens: number;
};
type RunManifest = {
  run_id: string;
  started_at: string;
  completed_at?: string;
  completed_games?: number;
  profile_name: string;
  scenario_id: string;
  profile_hash: string;
  git_commit: string;
  server: string;
  provider: string;
  model: string;
  base_url_class: string;
  game_count: number;
  concurrency: number;
  max_rounds: number;
  wolf_rotation_cap: number;
  thinking_budget: unknown;
  temperature: number;
  max_tokens: number;
  generation_settings: {
    thinking_budget: unknown;
    temperature: number;
    max_tokens: number;
  };
  players: PlayerProfile[];
  judge: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashProfile(profile: unknown): string {
  return createHash("sha256").update(stableStringify(profile)).digest("hex").slice(0, 16);
}

async function gitCommit(): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT_DIR }, (error, stdout) => {
      if (error) resolve("");
      else resolve(stdout.trim());
    });
  });
}

function urlHost(value: unknown): string {
  if (!value) return "";
  try {
    return new URL(str(value)).host;
  } catch {
    return String(value);
  }
}

function assertUrl(value: string, field: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error(`profile.${field} must be a valid http(s) URL`);
  }
}

function assertFiniteRange(value: number, field: string, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`profile.${field} must be a number in [${min}, ${max}]`);
  }
}

export function validateProfile(profile: unknown): EvalProfile {
  if (!profile || typeof profile !== "object") {
    throw new Error("profile must be an object");
  }
  const raw = profile as JsonRecord;
  for (const f of REQUIRED_FIELDS) {
    if (raw[f] === undefined || raw[f] === null) {
      throw new Error(`profile missing required field: ${f}`);
    }
  }
  const provider = str(raw.provider);
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`profile.provider must be one of: ${[...KNOWN_PROVIDERS].join(", ")}`);
  }
  if (!Number.isInteger(raw.game_count) || Number(raw.game_count) < 1) {
    throw new Error("profile.game_count must be a positive integer");
  }
  if (!Array.isArray(raw.players) || raw.players.length < 3) {
    throw new Error("profile.players must list at least 3 players");
  }
  const players = raw.players.filter(isRecord).map((p) => ({ id: str(p.id), role: str(p.role) }));
  if (players.length !== raw.players.length) {
    throw new Error("profile.players entries must be objects");
  }
  const ids = new Set<string>();
  for (const player of players) {
    if (!player.id) throw new Error("profile.players entries must have non-empty id");
    if (ids.has(player.id)) throw new Error(`profile.players contains duplicate id: ${player.id}`);
    ids.add(player.id);
    if (!KNOWN_ROLES.has(player.role)) {
      throw new Error(`profile.players role for ${player.id} must be one of: ${[...KNOWN_ROLES].join(", ")}`);
    }
  }
  const roleSet = new Set(players.map((p) => p.role));
  for (const r of ROLE_REQUIREMENTS) {
    if (!roleSet.has(r)) {
      throw new Error(`profile.players must include role: ${r}`);
    }
  }
  if (![...roleSet].some((role) => role !== "wolf")) {
    throw new Error("profile.players must include at least one town role");
  }
  const conc = Number(raw.concurrency ?? 1);
  if (!Number.isInteger(conc) || conc < 1 || conc > 8) {
    throw new Error("profile.concurrency must be an integer in [1, 8]");
  }
  const maxRounds = Number(raw.max_rounds ?? 8);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
    throw new Error("profile.max_rounds must be an integer in [1, 50]");
  }
  const wolfCap = Number(raw.wolf_rotation_cap ?? 3);
  if (!Number.isInteger(wolfCap) || wolfCap < 1 || wolfCap > 6) {
    throw new Error("profile.wolf_rotation_cap must be an integer in [1, 6]");
  }
  const thinkingBudget = raw.thinking_budget ?? null;
  if (
    thinkingBudget !== null &&
    (!Number.isInteger(thinkingBudget) || Number(thinkingBudget) < 0 || Number(thinkingBudget) > 32000)
  ) {
    throw new Error("profile.thinking_budget must be null or an integer in [0, 32000]");
  }
  const temperature = Number(raw.temperature ?? 0.2);
  assertFiniteRange(temperature, "temperature", 0, 2);
  const maxTokens = Number(raw.max_tokens ?? 260);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32000) {
    throw new Error("profile.max_tokens must be an integer in [1, 32000]");
  }
  const baseUrl = str(raw.base_url);
  if (provider !== "stub") {
    if (!baseUrl) throw new Error("profile.base_url is required for live providers");
    assertUrl(baseUrl, "base_url");
  } else if (baseUrl) {
    assertUrl(baseUrl, "base_url");
  }
  const apiKeyEnv = str(raw.api_key_env);
  if (provider === "omlx" && !apiKeyEnv) {
    throw new Error("profile.api_key_env is required for OMLX profiles");
  }
  return {
    ...raw,
    name: str(raw.name),
    provider,
    game_count: Number(raw.game_count),
    players,
    model: raw.model === undefined ? undefined : str(raw.model),
    concurrency: Number(conc),
    max_rounds: maxRounds,
    wolf_rotation_cap: Number(wolfCap),
    thinking_budget: thinkingBudget,
    temperature,
    max_tokens: maxTokens,
    base_url: baseUrl,
    api_key_env: apiKeyEnv,
    gates: isRecord(raw.gates) ? raw.gates as Partial<GateConfig> : null,
    baseline_path: typeof raw.baseline_path === "string" ? raw.baseline_path : null,
    scenario_id: str(raw.scenario_id ?? raw.name),
    judge: raw.judge ?? null,
  };
}

export function buildRunRequestBody(profile: EvalProfile, apiKey: string): RunRequestBody {
  return {
    action: "playGame",
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.base_url || undefined,
    apiKey: apiKey || undefined,
    players: profile.players,
    maxRounds: profile.max_rounds,
    wolfRotationCap: profile.wolf_rotation_cap,
    thinkingBudget: profile.thinking_budget ?? undefined,
    temperature: profile.temperature,
    maxTokens: profile.max_tokens,
  };
}

// Pure: scan an NDJSON stream string for the durable_log path inside the
// autoGame's stdout result event. Returns relative path or null.
export function extractDurableLogPath(ndjson: string): string | null {
  if (!ndjson) return null;
  for (const line of ndjson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt: unknown = JSON.parse(trimmed);
      if (!isRecord(evt) || evt.type !== "stdout" || typeof evt.data !== "string") continue;
      // result is emitted as JSON.stringify([result]) by runAutoGame
      const start = evt.data.indexOf("[{");
      if (start < 0) continue;
      const slice = evt.data.slice(start);
      const parsed: unknown = JSON.parse(slice);
      const first = Array.isArray(parsed) ? parsed[0] : undefined;
      if (isRecord(first) && first.durable_log) {
        return String(first.durable_log);
      }
    } catch {
      // ignore non-JSON noise
    }
  }
  return null;
}

// Pure: scan the stream for {type: "done", ok: bool}; returns true|false|null.
export function extractDoneOk(ndjson: string): boolean | null {
  if (!ndjson) return null;
  for (const line of ndjson.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt: unknown = JSON.parse(trimmed);
      if (isRecord(evt) && evt.type === "done") return evt.ok === true;
    } catch {
      // ignore
    }
  }
  return null;
}

export async function streamNdjsonToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk);
  }
  return text;
}

async function postOneGame(
  { profile, apiKey, server, gameIndex, onLog }: {
    profile: EvalProfile;
    apiKey: string;
    server: string;
    gameIndex: number;
    onLog?: (event: GameLogEvent) => void;
  },
): Promise<GameResult> {
  const body = buildRunRequestBody(profile, apiKey);
  const url = `${server.replace(/\/$/, "")}/api/run`;
  const startMs = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return {
      ok: false,
      gameIndex,
      error: `HTTP ${res.status}: ${await res.text().catch(() => "")}`.slice(0, 500),
      ms: Date.now() - startMs,
    };
  }
  const text = await streamNdjsonToText(res.body);
  const durable = extractDurableLogPath(text);
  const ok = extractDoneOk(text) === true && Boolean(durable);
  if (onLog) onLog({ gameIndex, durable, ok });
  return { ok, gameIndex, durable, ms: Date.now() - startMs };
}

export async function runProfile(profile: unknown, opts: RunOptions = {}) {
  const validated = validateProfile(profile);
  const server = opts.server || "http://localhost:5174";
  const apiKey = opts.apiKey || (validated.api_key_env ? process.env[validated.api_key_env] || "" : "");
  const writeOut = opts.writeOut !== false;
  const startedAt = new Date().toISOString();

  if (validated.api_key_env && !apiKey && opts.allowMissingApiKey !== true) {
    throw new Error(
      `${validated.name} requires ${validated.api_key_env}; set it in the environment that runs eval/run.ts or starts the web server`,
    );
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = opts.outDir || path.join(ROOT_DIR, "eval", "runs", `${validated.name}-${stamp}`);
  if (writeOut) await mkdir(outDir, { recursive: true });
  const manifest: RunManifest = {
    run_id: `${validated.name}-${stamp}`,
    started_at: startedAt,
    profile_name: validated.name,
    scenario_id: validated.scenario_id,
    profile_hash: hashProfile(validated),
    git_commit: await gitCommit(),
    server,
    provider: validated.provider,
    model: validated.model || "",
    base_url_class: urlHost(validated.base_url),
    game_count: validated.game_count,
    concurrency: validated.concurrency,
    max_rounds: validated.max_rounds,
    wolf_rotation_cap: validated.wolf_rotation_cap,
    thinking_budget: validated.thinking_budget,
    temperature: validated.temperature,
    max_tokens: validated.max_tokens,
    generation_settings: {
      thinking_budget: validated.thinking_budget,
      temperature: validated.temperature,
      max_tokens: validated.max_tokens,
    },
    players: validated.players,
    judge: validated.judge,
  };
  if (writeOut) {
    await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const queue = [...Array(validated.game_count).keys()];
  const results: Array<GameResult | undefined> = new Array(validated.game_count);
  const concurrency = Math.min(validated.concurrency, queue.length);

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const idx = queue.shift();
      if (idx === undefined) return;
      results[idx] = await postOneGame({ profile: validated, apiKey, server, gameIndex: idx, onLog: opts.onLog });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const finalResults: GameResult[] = results.map((result, index) =>
    result ?? { ok: false, gameIndex: index, error: "worker did not produce a result", ms: 0 },
  );

  const collectedLogs: string[] = [];
  for (const r of finalResults) {
    if (!r || !r.durable) continue;
    const absSrc = path.isAbsolute(r.durable) ? r.durable : path.join(ROOT_DIR, r.durable);
    if (writeOut) {
      const dest = path.join(outDir, `game-${String(r.gameIndex).padStart(3, "0")}.jsonl`);
      try {
        await copyFile(absSrc, dest);
        collectedLogs.push(dest);
      } catch (error) {
        r.copy_error = errorMessage(error);
      }
    } else {
      collectedLogs.push(absSrc);
    }
  }

  let scorecard: ReturnType<typeof aggregate> | null = null;
  let gateReport: GateReport | null = null;
  if (collectedLogs.length > 0) {
    const games = await loadGameLogs(writeOut ? outDir : collectedLogs[0]);
    scorecard = aggregate(games);
    let baseline = null;
    if (validated.baseline_path) {
      const absBaseline = path.isAbsolute(validated.baseline_path)
        ? validated.baseline_path
        : path.join(ROOT_DIR, validated.baseline_path);
      try {
        baseline = JSON.parse(await readFile(absBaseline, "utf8"));
      } catch (error) {
        console.error(`[eval-run] baseline_path ${validated.baseline_path}: ${errorMessage(error)}`);
      }
    }
    gateReport = evaluateGates(scorecard, validated.gates, { baseline });
    if (writeOut) {
      await writeFile(path.join(outDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
      await writeFile(path.join(outDir, "gates.json"), `${JSON.stringify(gateReport, null, 2)}\n`);
    }
  }

  if (writeOut) {
    manifest.completed_at = new Date().toISOString();
    manifest.completed_games = scorecard?.meta?.completed_game_count ?? 0;
    await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { profile: validated, results: finalResults, scorecard, gateReport, outDir, manifest };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: eval-run.ts <profile.json> [--server URL] [--out DIR]");
    process.exit(2);
  }
  const profilePath = args.find((a) => !a.startsWith("--"));
  const serverIdx = args.indexOf("--server");
  const outIdx = args.indexOf("--out");
  const server = serverIdx >= 0 ? args[serverIdx + 1] : undefined;
  const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (!profilePath) throw new Error("missing profile path");
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as unknown;

  const profileRecord = isRecord(profile) ? profile : {};
  console.error(`[eval-run] profile=${str(profileRecord.name)} games=${str(profileRecord.game_count)} concurrency=${str(profileRecord.concurrency ?? 1)}`);
  const onLog = ({ gameIndex, ok, durable }: GameLogEvent): void => {
    console.error(`[eval-run] game ${gameIndex + 1}: ${ok ? "ok" : "FAIL"} log=${durable || "(none)"}`);
  };
  const result = await runProfile(profile, { server, outDir, onLog });
  console.error(`[eval-run] wrote ${result.outDir}`);
  if (result.scorecard) {
    console.error("");
    console.error(formatScorecardSummary(result.scorecard));
    if (result.gateReport) {
      console.error("");
      console.error(formatGateReport(result.gateReport));
      if (!result.gateReport.pass) process.exit(1);
    }
  } else {
    console.error("[eval-run] no game logs collected. see results above");
    process.exit(1);
  }
}

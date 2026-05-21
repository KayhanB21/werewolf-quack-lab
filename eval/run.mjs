#!/usr/bin/env node
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, formatScorecardSummary, loadGameLogs } from "./aggregate.mjs";
import { evaluateGates, formatGateReport } from "./gates.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const REQUIRED_FIELDS = ["name", "provider", "game_count", "players"];
const ROLE_REQUIREMENTS = ["wolf", "seer", "doctor"];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashProfile(profile) {
  return createHash("sha256").update(stableStringify(profile)).digest("hex").slice(0, 16);
}

async function gitCommit() {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT_DIR }, (error, stdout) => {
      if (error) resolve("");
      else resolve(stdout.trim());
    });
  });
}

function urlHost(value) {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return String(value);
  }
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("profile must be an object");
  }
  for (const f of REQUIRED_FIELDS) {
    if (profile[f] === undefined || profile[f] === null) {
      throw new Error(`profile missing required field: ${f}`);
    }
  }
  if (!Number.isInteger(profile.game_count) || profile.game_count < 1) {
    throw new Error("profile.game_count must be a positive integer");
  }
  if (!Array.isArray(profile.players) || profile.players.length < 3) {
    throw new Error("profile.players must list at least 3 players");
  }
  const roleSet = new Set(profile.players.map((p) => p.role));
  for (const r of ROLE_REQUIREMENTS) {
    if (!roleSet.has(r)) {
      throw new Error(`profile.players must include role: ${r}`);
    }
  }
  const conc = profile.concurrency ?? 1;
  if (!Number.isInteger(conc) || conc < 1 || conc > 8) {
    throw new Error("profile.concurrency must be an integer in [1, 8]");
  }
  const wolfCap = profile.wolf_rotation_cap ?? 3;
  if (!Number.isInteger(wolfCap) || wolfCap < 1 || wolfCap > 6) {
    throw new Error("profile.wolf_rotation_cap must be an integer in [1, 6]");
  }
  return {
    ...profile,
    concurrency: conc,
    max_rounds: profile.max_rounds ?? 8,
    wolf_rotation_cap: wolfCap,
    thinking_budget: profile.thinking_budget ?? null,
    temperature: profile.temperature ?? 0.2,
    max_tokens: profile.max_tokens ?? 260,
    base_url: profile.base_url ?? "",
    api_key_env: profile.api_key_env ?? "",
    gates: profile.gates ?? null,
    baseline_path: profile.baseline_path ?? null,
    scenario_id: profile.scenario_id ?? profile.name,
    judge: profile.judge ?? null,
  };
}

export function buildRunRequestBody(profile, apiKey) {
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
export function extractDurableLogPath(ndjson) {
  if (!ndjson) return null;
  for (const line of ndjson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type !== "stdout" || typeof evt.data !== "string") continue;
      // result is emitted as JSON.stringify([result]) by runAutoGame
      const start = evt.data.indexOf("[{");
      if (start < 0) continue;
      const slice = evt.data.slice(start);
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed) && parsed[0]?.durable_log) {
        return String(parsed[0].durable_log);
      }
    } catch {
      // ignore non-JSON noise
    }
  }
  return null;
}

// Pure: scan the stream for {type: "done", ok: bool}; returns true|false|null.
export function extractDoneOk(ndjson) {
  if (!ndjson) return null;
  for (const line of ndjson.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === "done") return evt.ok === true;
    } catch {
      // ignore
    }
  }
  return null;
}

export async function streamNdjsonToText(stream) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk);
  }
  return text;
}

async function postOneGame({ profile, apiKey, server, gameIndex, onLog }) {
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

export async function runProfile(profile, opts = {}) {
  const validated = validateProfile(profile);
  const server = opts.server || "http://localhost:5174";
  const apiKey = opts.apiKey || (validated.api_key_env ? process.env[validated.api_key_env] || "" : "");
  const writeOut = opts.writeOut !== false;
  const startedAt = new Date().toISOString();

  if (validated.api_key_env && !apiKey && opts.allowMissingApiKey !== true) {
    throw new Error(
      `${validated.name} requires ${validated.api_key_env}; set it in the environment that runs eval/run.mjs or starts the web server`,
    );
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const outDir = opts.outDir || path.join(ROOT_DIR, "eval", "runs", `${validated.name}-${stamp}`);
  if (writeOut) await mkdir(outDir, { recursive: true });
  const manifest = {
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
    players: validated.players,
    judge: validated.judge,
  };
  if (writeOut) {
    await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const queue = [...Array(validated.game_count).keys()];
  const results = new Array(validated.game_count);
  const concurrency = Math.min(validated.concurrency, queue.length);

  const worker = async () => {
    while (queue.length > 0) {
      const idx = queue.shift();
      if (idx === undefined) return;
      results[idx] = await postOneGame({ profile: validated, apiKey, server, gameIndex: idx, onLog: opts.onLog });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const collectedLogs = [];
  for (const r of results) {
    if (!r || !r.durable) continue;
    const absSrc = path.isAbsolute(r.durable) ? r.durable : path.join(ROOT_DIR, r.durable);
    if (writeOut) {
      const dest = path.join(outDir, `game-${String(r.gameIndex).padStart(3, "0")}.jsonl`);
      try {
        await copyFile(absSrc, dest);
        collectedLogs.push(dest);
      } catch (error) {
        r.copy_error = error.message;
      }
    } else {
      collectedLogs.push(absSrc);
    }
  }

  let scorecard = null;
  let gateReport = null;
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
        console.error(`[eval-run] baseline_path ${validated.baseline_path}: ${error.message}`);
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

  return { profile: validated, results, scorecard, gateReport, outDir, manifest };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: eval-run.mjs <profile.json> [--server URL] [--out DIR]");
    process.exit(2);
  }
  const profilePath = args.find((a) => !a.startsWith("--"));
  const serverIdx = args.indexOf("--server");
  const outIdx = args.indexOf("--out");
  const server = serverIdx >= 0 ? args[serverIdx + 1] : undefined;
  const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const profile = JSON.parse(await readFile(profilePath, "utf8"));

  console.error(`[eval-run] profile=${profile.name} games=${profile.game_count} concurrency=${profile.concurrency ?? 1}`);
  const onLog = ({ gameIndex, ok, durable }) => {
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

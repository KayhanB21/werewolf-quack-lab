// Werewolf Quack Lab referee / orchestrator.
//
// Pulled out of bin/lab-web-server.ts so the game loop can be driven from
// either the HTTP server (NDJSON streaming sink) or a CLI (stdout NDJSON
// sink). Same code path, same durable log, same exit semantics — only the
// sink differs.
//
// Sink contract:
//   sink.write(type, payload)   -> emits { type, ...payload } as one event
// HTTP sink writes to res. CLI sink writes to stdout. Mock sinks (in tests)
// can collect events into an array. The contract is intentionally tiny.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyBeliefsMarkers,
  buildContextForAgent,
  buildGameConfig,
  latestKillsPerWolf,
  latestRowPerAgent,
  newRefereeGameId,
  parseBeliefsMarkers,
  parseIntentMarkers,
  parseTurnStatsMarkers,
  resolveLynch,
  resolveNightOutcome,
  serializeRefereeEvent,
  type LabEnv,
  type LabInput,
} from "./lab-web-actions.ts";
import { extractJsonArrays } from "../web/flow.ts";

export const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const GENERATED_DIR = path.join(ROOT_DIR, ".generated");

// ===========================================================================
// Process tracking. One shared registry so the HTTP server's SIGTERM handler
// can reach every child the orchestrator spawned, even ones started inside
// runAutoGame.
// ===========================================================================
type JsonRecord = Record<string, unknown>;
type Row = JsonRecord & {
  agent_id?: string;
  action?: string;
  target?: string;
  round?: number | string;
  rationale?: string;
  public_text?: string;
};
export type Sink = { write(type: string, payload?: JsonRecord): void };
export type AbortControl = { onAbort: (() => void) | null };
type RunResult = { code: number; stdout: string; stderr: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const activeChildren = new Set<ChildProcess>();

export function registerChild(child: ChildProcess): ChildProcess {
  activeChildren.add(child);
  child.on("close", () => {
    activeChildren.delete(child);
  });
  return child;
}

export function killActiveChildren(): void {
  for (const child of activeChildren) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

export function stripAnsi(text: unknown): string {
  return String(text).replace(/\[[0-9;]*m/g, "");
}

// ===========================================================================
// Sink helpers.
// ===========================================================================

// A null sink — useful for tests that don't care about event emission.
export function nullSink(): Sink {
  return { write() {} };
}

// Collect every event into an array. Test convenience.
export function arraySink(target: JsonRecord[]): Sink {
  return { write: (type, payload = {}) => target.push({ type, ...payload }) };
}

// Adapt a Node http response into a sink. Each event becomes one NDJSON line.
export function httpSink(res: { write(chunk: string): unknown }): Sink {
  return {
    write(type, payload = {}) {
      res.write(`${JSON.stringify({ type, ...payload })}\n`);
    },
  };
}

// Adapt stdout into a sink (used by the CLI entry).
export function stdoutSink(stream: { write(chunk: string): unknown } = process.stdout): Sink {
  return {
    write(type, payload = {}) {
      stream.write(`${JSON.stringify({ type, ...payload })}\n`);
    },
  };
}

// ===========================================================================
// Child-process wrappers. shouldAbort is { onAbort: fn|null } — set to a
// stop callback while the child is alive so external code can SIGTERM it.
// ===========================================================================

export async function runStep(command: string, args: string[], env: LabEnv, sink: Sink, shouldAbort?: AbortControl): Promise<number> {
  sink.write("step", { command: [command, ...args].join(" ") });
  return new Promise((resolve) => {
    const child = registerChild(spawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    const stop = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (shouldAbort) shouldAbort.onAbort = stop;

    child.stdout?.on("data", (chunk: Buffer) => {
      sink.write("stdout", { data: stripAnsi(chunk.toString("utf8")) });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      sink.write("stderr", { data: stripAnsi(chunk.toString("utf8")) });
    });
    child.on("error", (error) => {
      sink.write("error", { message: error.message });
      resolve(1);
    });
    child.on("close", (code, signal) => {
      if (shouldAbort) shouldAbort.onAbort = null;
      sink.write("exit", { code, signal });
      resolve(code ?? 1);
    });
  });
}

export async function runStepCapture(command: string, args: string[], env: LabEnv, sink: Sink, shouldAbort?: AbortControl): Promise<RunResult> {
  sink.write("step", { command: [command, ...args].join(" ") });
  return new Promise((resolve) => {
    const child = registerChild(spawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let stdout = "";
    let stderr = "";
    const stop = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (shouldAbort) shouldAbort.onAbort = stop;

    child.stdout?.on("data", (chunk: Buffer) => {
      const data = stripAnsi(chunk.toString("utf8"));
      stdout += data;
      sink.write("stdout", { data });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const data = stripAnsi(chunk.toString("utf8"));
      stderr += data;
      sink.write("stderr", { data });
    });
    child.on("error", (error) => {
      stderr += errorMessage(error);
      sink.write("error", { message: errorMessage(error) });
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      if (shouldAbort) shouldAbort.onAbort = null;
      sink.write("exit", { code, signal });
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function runBufferedStep(command: string, args: string[], env: LabEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = registerChild(spawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += stripAnsi(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stripAnsi(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      stderr += errorMessage(error);
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ===========================================================================
// Query helpers. pickRows is the rule for which JSON array in the labctl
// query output is the "interesting" one.
// ===========================================================================

export function pickRows(raw: string, queryName: string): Row[] {
  const arrays = extractJsonArrays(raw)
    .filter(Array.isArray)
    .map((rows) => rows.filter(isRecord) as Row[]);
  const predicates: Record<string, (row: Row) => unknown> = {
    whoami: (row: Row) => row.name,
    public_log: (row: Row) => row.public_text,
    wolf_channel: (row: Row) => row.action === "wolf-kill" || row.action === "wolf-done" || row.rationale,
    seer_channel: (row: Row) => row.action === "seer-investigate" || row.rationale,
    doctor_channel: (row: Row) => row.action === "doctor-save" || row.rationale,
    full_log: (row: Row) => row.public_text || row.rationale,
  } satisfies Record<string, (row: Row) => unknown>;
  const predicate = predicates[queryName] ?? (() => true);
  return arrays.find((rows) => rows.some((row) => row && typeof row === "object" && predicate(row))) || [];
}

export async function runFilteredQuery(
  command: string,
  queryName: string,
  env: LabEnv,
  sink: Sink,
  predicate: (row: Row) => boolean,
): Promise<{ code: number; rows: Row[] }> {
  sink.write("step", { command });
  const result = await runBufferedStep("./bin/labctl", ["query", queryName], env);

  if (result.code !== 0) {
    sink.write("stderr", { data: `${result.stdout}${result.stderr}` });
    sink.write("exit", { code: result.code, signal: null });
    return { code: result.code, rows: [] };
  }

  const rows = pickRows(result.stdout, queryName).filter(predicate);
  sink.write("stdout", { data: `${JSON.stringify(rows)}\n` });
  sink.write("exit", { code: 0, signal: null });
  return { code: 0, rows };
}

// ===========================================================================
// Win condition.
// ===========================================================================

export function winnerFor(alive: string[], roles: Map<string, string>): { winner: string; reason: string } | null {
  const wolves = alive.filter((id) => roles.get(id) === "wolf").length;
  const town = alive.length - wolves;
  if (wolves === 0) {
    return { winner: "village", reason: "all wolves were eliminated" };
  }
  if (wolves >= town) {
    return { winner: "wolves", reason: "wolves reached parity with town" };
  }
  return null;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// ===========================================================================
// Agent invocation. Runs the labctl run-agent step for each id, then parses
// __BELIEFS__ and __TURN_STATS__ markers out of stdout and feeds them into
// the supplied beliefs map + durable log writer.
// ===========================================================================

export async function runAgentPhase(
  command: string,
  ids: string[],
  phase: string,
  envOrFn: LabEnv | ((id: string) => LabEnv),
  sink: Sink,
  shouldAbort: AbortControl,
  isClosed?: () => boolean,
  beliefsByAgent?: Map<string, { suspicions: JsonRecord[]; knowledge: JsonRecord[] }>,
  logEvent?: (event: JsonRecord) => Promise<void>,
): Promise<boolean> {
  sink.write("step", { command });
  const getEnv = typeof envOrFn === "function" ? envOrFn : () => envOrFn;

  for (const id of ids) {
    if (isClosed && isClosed()) return false;
    const { code, stdout } = await runStepCapture(
      "./bin/labctl",
      ["run-agent", id, phase],
      getEnv(id),
      sink,
      shouldAbort,
    );
    const beliefMarkers = parseBeliefsMarkers(stdout);
    if (beliefsByAgent) {
      applyBeliefsMarkers(beliefsByAgent, beliefMarkers);
    }
    if (logEvent) {
      for (const belief of beliefMarkers) {
        await logEvent({ kind: "belief", ...belief });
      }
      for (const stats of parseTurnStatsMarkers(stdout)) {
        await logEvent({ kind: "turn-stats", ...stats });
      }
      for (const intent of parseIntentMarkers(stdout)) {
        await logEvent({ kind: "agent-intent", ...intent });
        if (intent.public_text && intent.public_text.trim()) {
          const safeAgent = intent.agent.replace(/[^a-zA-Z0-9_-]/g, "_");
          const safePhase = intent.phase.replace(/[^a-zA-Z0-9_-]/g, "_");
          await logEvent({
            kind: "statement",
            statement_id: `r${intent.round}-${safePhase}-${safeAgent}`,
            agent: intent.agent,
            role: intent.role,
            phase: intent.phase,
            round: intent.round,
            action: intent.action,
            target: intent.target,
            text: intent.public_text,
            rationale: intent.rationale,
          });
        }
      }
    }
    if (code !== 0) {
      sink.write("exit", { code, signal: null });
      return false;
    }
  }

  sink.write("exit", { code: 0, signal: null });
  return true;
}

// ===========================================================================
// runAutoGame: the full referee loop. Returns true on success, false if the
// run aborted before completion. Always emits a final "exit" event with
// code: 0 on success so downstream consumers see a clean end of stream.
// ===========================================================================

export async function runAutoGame(
  body: LabInput,
  env: LabEnv,
  sink: Sink,
  controls: { shouldAbort?: AbortControl; isClosed?: () => boolean } = {},
): Promise<boolean> {
  const shouldAbort = controls.shouldAbort ?? { onAbort: null };
  const isClosed = controls.isClosed ?? (() => false);

  const gameConfig = buildGameConfig(body);
  const players = gameConfig.players;
  const roles = new Map(players.map((player) => [player.id, player.role]));
  const history: JsonRecord[] = [];
  const eliminated: Array<{ id: string; role: string; round: number; phase: string; cause: string }> = [];
  const publicLog: Row[] = [];
  const publicEvents: string[] = [];
  const privateNotesByAgent = new Map<string, unknown[]>(players.map((player) => [player.id, []]));
  const beliefsByAgent = new Map(
    players.map((player) => [player.id, { suspicions: [], knowledge: [] }]),
  );
  let alive = players.map((player) => player.id);
  let winner = "";
  let reason = "";
  const maxRounds = clampInt(body.maxRounds, 8, 1, 20);
  const wolfRotationCap = clampInt(body.wolfRotationCap, 3, 1, 6);

  const gameId = newRefereeGameId();
  const gamesDir = path.join(GENERATED_DIR, "games");
  const logPath = path.join(gamesDir, `${gameId}.jsonl`);
  await mkdir(gamesDir, { recursive: true });
  const logEvent = async (event: JsonRecord) => {
    try {
      await appendFile(logPath, serializeRefereeEvent(event));
    } catch (error) {
      sink.write("stderr", {
        data: `[referee] failed to append durable log: ${errorMessage(error)}\n`,
      });
    }
  };
  await logEvent({
    kind: "game-start",
    game_id: gameId,
    players: players.map((player) => ({ id: player.id, role: player.role })),
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL,
    max_rounds: maxRounds,
  });
  sink.write("stdout", { data: `[referee] durable log: ${path.relative(ROOT_DIR, logPath)}\n` });

  function envForId(phase: string, round: number, base: LabEnv, extra: Partial<LabEnv> = {}) {
    return (id: string): LabEnv => ({
      ...base,
      ...extra,
      ACTIVE_PLAYER_IDS: alive.join(","),
      CONTEXT_JSON: JSON.stringify(
        buildContextForAgent(id, {
          round,
          phase,
          alive,
          eliminated,
          publicEvents,
          publicLog,
          privateNotesByAgent,
          beliefsByAgent,
        }),
      ),
    });
  }

  const setupSteps: Array<[string, string[]]> = [
    ["./bin/labctl", ["down"]],
    ["./bin/labctl", ["up"]],
  ];
  for (const [command, args] of setupSteps) {
    if (isClosed()) return false;
    const result = await runStep(command, args, env, sink, shouldAbort);
    if (result !== 0) return false;
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundEnv = { ...env, ROUND: String(round) };
    await logEvent({ kind: "round-start", round, alive: alive.slice() });
    sink.write("stdout", {
      data: `[referee] round ${round} starts with ${alive.join(", ")}\n`,
    });

    const discussionOk = await runAgentPhase(
      `referee round ${round} discussion`,
      alive,
      "day",
      envForId("day-discuss", round, roundEnv),
      sink,
      shouldAbort,
      isClosed,
      beliefsByAgent,
      logEvent,
    );
    if (!discussionOk) return false;

    const discussionLog = await runFilteredQuery(
      `referee round ${round} discussion log`,
      "public_log",
      roundEnv,
      sink,
      (row) =>
        Number(row.round) === round &&
        row.action !== "vote" &&
        alive.includes(String(row.agent_id || "")),
    );
    if (discussionLog.code !== 0) return false;
    publicLog.push(...discussionLog.rows);
    history.push({
      round,
      phase: "discussion",
      event: "talk",
      turns: discussionLog.rows.length,
    });

    const voteOk = await runAgentPhase(
      `referee round ${round} voting`,
      alive,
      "vote",
      envForId("day-vote", round, roundEnv),
      sink,
      shouldAbort,
      isClosed,
      beliefsByAgent,
      logEvent,
    );
    if (!voteOk) return false;

    const dayLog = await runFilteredQuery(
      `referee round ${round} vote log`,
      "public_log",
      roundEnv,
      sink,
      (row) =>
        Number(row.round) === round &&
        row.action === "vote" &&
        alive.includes(String(row.agent_id || "")) &&
        alive.includes(String(row.target || "")),
    );
    if (dayLog.code !== 0) return false;
    publicLog.push(...dayLog.rows);

    const lynch = resolveLynch(dayLog.rows);
    if (lynch.outcome === "lynch") {
      const target = lynch.target;
      alive = alive.filter((id) => id !== target);
      const revealedRole = roles.get(target) || "unknown";
      eliminated.push({
        id: target,
        role: revealedRole,
        round,
        phase: "day",
        cause: "lynch",
      });
      const announcement = `Round ${round}: ${target} was lynched (${lynch.votes} vote(s)). Revealed role: ${revealedRole}.`;
      publicEvents.push(announcement);
      await runBufferedStep(
        "./bin/labctl",
        ["ref-reveal", target, String(round), announcement],
        roundEnv,
      );
      await runBufferedStep(
        "./bin/labctl",
        ["ref-elim", target, String(round), revealedRole, "lynch"],
        roundEnv,
      );
      history.push({
        round,
        phase: "day",
        event: "vote",
        target,
        votes: lynch.votes,
      });
      await logEvent({
        kind: "lynch",
        round,
        target,
        votes: lynch.votes,
        revealed_role: revealedRole,
      });
      sink.write("stdout", {
        data: `[referee] day ${round}: ${lynch.target} eliminated by ${lynch.votes} vote(s); revealed role: ${revealedRole}\n`,
      });
    } else {
      const tied = lynch.votes > 0;
      const note = tied
        ? `Round ${round}: vote ended in a tie at ${lynch.votes} (no lynch).`
        : `Round ${round}: vote ended with no lynch.`;
      history.push({ round, phase: "day", event: tied ? "tie" : "no-elimination" });
      publicEvents.push(note);
      await logEvent({ kind: "no-lynch", round, tied, votes: lynch.votes });
      sink.write("stdout", { data: `[referee] ${note}\n` });
    }

    const dayWin = winnerFor(alive, roles);
    if (dayWin) {
      winner = dayWin.winner;
      reason = dayWin.reason;
      break;
    }

    const liveWolves = alive.filter((id) => roles.get(id) === "wolf");
    const wolfRotationRows: Row[] = [];
    let wolfConsensusRotation = wolfRotationCap;
    let wolfConsensusReached = false;
    for (let rotation = 1; rotation <= wolfRotationCap; rotation += 1) {
      const wolfEnv = envForId("night-wolf", round, roundEnv, {
        WOLF_CHANNEL_JSON: JSON.stringify(wolfRotationRows),
      });
      const wolfOk = await runAgentPhase(
        `referee round ${round} wolf rotation ${rotation}`,
        liveWolves,
        "wolf",
        wolfEnv,
        sink,
        shouldAbort,
        isClosed,
        beliefsByAgent,
        logEvent,
      );
      if (!wolfOk) return false;

      const rotationLog = await runFilteredQuery(
        `referee round ${round} wolf log rotation ${rotation}`,
        "wolf_channel",
        roundEnv,
        sink,
        (row) =>
          Number(row.round) === round &&
          (row.action === "wolf-kill" || row.action === "wolf-done") &&
          alive.includes(String(row.agent_id || "")) &&
          alive.includes(String(row.target || "")),
      );
      if (rotationLog.code !== 0) return false;
      wolfRotationRows.splice(0, wolfRotationRows.length, ...rotationLog.rows);

      const latestByWolf = latestRowPerAgent(wolfRotationRows);
      const allDone =
        liveWolves.length > 0 &&
        liveWolves.every((id) => latestByWolf.get(id)?.action === "wolf-done");
      if (allDone) {
        wolfConsensusRotation = rotation;
        wolfConsensusReached = true;
        sink.write("stdout", {
          data: `[referee] night ${round}: wolf consensus reached after rotation ${rotation}\n`,
        });
        break;
      }
    }

    const wolfLog = { rows: latestKillsPerWolf(wolfRotationRows, liveWolves) };
    await logEvent({
      kind: "wolf-consensus",
      round,
      rotations: wolfConsensusRotation,
      reached: wolfConsensusReached,
      wolf_count: liveWolves.length,
    });

    const liveDoctors = alive.filter((id) => roles.get(id) === "doctor");
    const doctorOk = await runAgentPhase(
      `referee round ${round} doctor`,
      liveDoctors,
      "doctor",
      envForId("night-doctor", round, roundEnv),
      sink,
      shouldAbort,
      isClosed,
      beliefsByAgent,
      logEvent,
    );
    if (!doctorOk) return false;

    const doctorLog = await runFilteredQuery(
      `referee round ${round} doctor log`,
      "doctor_channel",
      roundEnv,
      sink,
      (row) =>
        Number(row.round) === round &&
        row.action === "doctor-save" &&
        alive.includes(String(row.agent_id || "")) &&
        alive.includes(String(row.target || "")),
    );
    if (doctorLog.code !== 0) return false;

    const liveSeers = alive.filter((id) => roles.get(id) === "seer");
    const seerOk = await runAgentPhase(
      `referee round ${round} seer`,
      liveSeers,
      "seer",
      envForId("night-seer", round, roundEnv),
      sink,
      shouldAbort,
      isClosed,
      beliefsByAgent,
      logEvent,
    );
    if (!seerOk) return false;

    const seerLog = await runFilteredQuery(
      `referee round ${round} seer log`,
      "seer_channel",
      roundEnv,
      sink,
      (row) =>
        Number(row.round) === round &&
        row.action === "seer-investigate" &&
        alive.includes(String(row.agent_id || "")) &&
        alive.includes(String(row.target || "")),
    );
    if (seerLog.code !== 0) return false;

    const night = resolveNightOutcome(wolfLog.rows, doctorLog.rows);
    if (night.outcome === "kill") {
      const target = night.target;
      alive = alive.filter((id) => id !== target);
      const revealedRole = roles.get(target) || "unknown";
      eliminated.push({
        id: target,
        role: revealedRole,
        round,
        phase: "wolf",
        cause: "wolf-kill",
      });
      const announcement = `Round ${round}: ${target} was killed by wolves. Revealed role: ${revealedRole}.`;
      publicEvents.push(announcement);
      await runBufferedStep(
        "./bin/labctl",
        ["ref-reveal", target, String(round), announcement],
        roundEnv,
      );
      await runBufferedStep(
        "./bin/labctl",
        ["ref-elim", target, String(round), revealedRole, "wolf-kill"],
        roundEnv,
      );
      history.push({
        round,
        phase: "wolf",
        event: "kill",
        target,
        votes: night.votes,
      });
      await logEvent({
        kind: "wolf-kill",
        round,
        target,
        votes: night.votes,
        revealed_role: revealedRole,
      });
      sink.write("stdout", {
        data: `[referee] night ${round}: ${night.target} killed by wolves; revealed role: ${revealedRole}\n`,
      });
    } else if (night.outcome === "saved") {
      history.push({
        round,
        phase: "wolf",
        event: "saved",
        target: night.target,
        votes: night.votes,
      });
      publicEvents.push(`Round ${round}: no one died last night.`);
      await logEvent({
        kind: "wolf-saved",
        round,
        target: night.target,
        votes: night.votes,
      });
      sink.write("stdout", {
        data: `[referee] night ${round}: ${night.target} was attacked but saved (kept private)\n`,
      });
    } else {
      history.push({ round, phase: "wolf", event: "no-kill" });
      publicEvents.push(`Round ${round}: no one died last night.`);
      await logEvent({ kind: "no-kill", round });
      sink.write("stdout", { data: `[referee] night ${round}: no kill\n` });
    }

    for (const seer of liveSeers) {
      const proposals = seerLog.rows.filter((row) => row.agent_id === seer);
      const proposal = proposals[proposals.length - 1];
      if (!proposal || !proposal.target) continue;
      const targetRole = roles.get(String(proposal.target));
      if (!targetRole) continue;
      const note = `Round ${round}: ${proposal.target} is ${targetRole}.`;
      const writeResult = await runBufferedStep(
        "./bin/labctl",
        ["ref-knowledge", seer, String(round), "seer", note],
        roundEnv,
      );
      if (writeResult.code !== 0) {
        sink.write("stderr", {
          data: `[referee] failed to write seer knowledge for ${seer}: ${writeResult.stderr}\n`,
        });
      } else {
        const seerNotes = privateNotesByAgent.get(seer) || [];
        seerNotes.push(note);
        privateNotesByAgent.set(seer, seerNotes);
        history.push({
          round,
          phase: "seer",
          event: "investigate",
          agent: seer,
          target: proposal.target,
          result: targetRole,
        });
        await logEvent({
          kind: "seer-learn",
          round,
          agent: seer,
          target: proposal.target,
          result: targetRole,
        });
        sink.write("stdout", {
          data: `[referee] night ${round}: seer ${seer} learns ${proposal.target} is ${targetRole}\n`,
        });
      }
    }

    const wolfWin = winnerFor(alive, roles);
    if (wolfWin) {
      winner = wolfWin.winner;
      reason = wolfWin.reason;
      break;
    }
  }

  if (!winner) {
    winner = "undecided";
    reason = `max rounds reached (${maxRounds})`;
  }

  const result = {
    winner,
    reason,
    rounds: history.reduce((value, item) => Math.max(value, Number(item.round) || 0), 0),
    alive,
    eliminated,
    history,
    durable_log: path.relative(ROOT_DIR, logPath),
  };

  await logEvent({
    kind: "game-end",
    winner,
    reason,
    rounds: result.rounds,
    alive: alive.slice(),
    eliminated: eliminated.slice(),
  });

  sink.write("step", { command: "referee auto-game" });
  sink.write("stdout", { data: `${JSON.stringify([result])}\n` });
  sink.write("exit", { code: 0, signal: null });
  return true;
}

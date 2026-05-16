#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGameConfig,
  buildLabEnv,
  getActionPlan,
  listActions,
  toHostModelUrl,
} from "./lab-web-actions.mjs";
import { extractJsonArrays } from "../web/flow.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIR = path.join(ROOT_DIR, "web");
const GENERATED_DIR = path.join(ROOT_DIR, ".generated");
const WEB_CONFIG_PATH = path.join(GENERATED_DIR, "web-game.json");
const PORT = Number(process.env.LAB_WEB_PORT || process.env.PORT || 5174);
const DEV_MODE = truthyEnv(process.env.LAB_WEB_DEV);
const activeChildren = new Set();

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeEvent(res, type, payload = {}) {
  res.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function registerChild(child) {
  activeChildren.add(child);
  child.on("close", () => {
    activeChildren.delete(child);
  });
  return child;
}

function killActiveChildren() {
  for (const child of activeChildren) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

async function runStep(command, args, env, res, shouldAbort) {
  writeEvent(res, "step", { command: [command, ...args].join(" ") });

  return new Promise((resolve) => {
    const child = registerChild(spawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));

    const stop = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    shouldAbort.onAbort = stop;

    child.stdout.on("data", (chunk) => {
      writeEvent(res, "stdout", { data: stripAnsi(chunk.toString("utf8")) });
    });
    child.stderr.on("data", (chunk) => {
      writeEvent(res, "stderr", { data: stripAnsi(chunk.toString("utf8")) });
    });
    child.on("error", (error) => {
      writeEvent(res, "error", { message: error.message });
      resolve(1);
    });
    child.on("close", (code, signal) => {
      shouldAbort.onAbort = null;
      writeEvent(res, "exit", { code, signal });
      resolve(code ?? 1);
    });
  });
}

async function runStepCapture(command, args, env, res, shouldAbort) {
  writeEvent(res, "step", { command: [command, ...args].join(" ") });

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
    shouldAbort.onAbort = stop;

    child.stdout.on("data", (chunk) => {
      const data = stripAnsi(chunk.toString("utf8"));
      stdout += data;
      writeEvent(res, "stdout", { data });
    });
    child.stderr.on("data", (chunk) => {
      const data = stripAnsi(chunk.toString("utf8"));
      stderr += data;
      writeEvent(res, "stderr", { data });
    });
    child.on("error", (error) => {
      stderr += error.message;
      writeEvent(res, "error", { message: error.message });
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      shouldAbort.onAbort = null;
      writeEvent(res, "exit", { code, signal });
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runBufferedStep(command, args, env) {
  return new Promise((resolve) => {
    const child = registerChild(spawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += stripAnsi(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr += stripAnsi(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function handleRun(req, res) {
  let body;
  let plan;
  try {
    body = await readJson(req);
    plan = getActionPlan(body.action);
    body.configPath = await writeRuntimeConfig(body);
    buildLabEnv(body, process.env, { requireModel: plan.requiresModel !== false });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const env = buildLabEnv(body, process.env, { requireModel: plan.requiresModel !== false });
  let closed = false;
  const shouldAbort = { onAbort: null };

  res.on("close", () => {
    closed = true;
    if (shouldAbort.onAbort) shouldAbort.onAbort();
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  writeEvent(res, "start", {
    action: body.action,
    label: plan.label,
    provider: env.LLM_PROVIDER,
    round: env.ROUND,
  });

  if (plan.special === "autoGame") {
    const ok = await runAutoGame(body, env, res, shouldAbort, () => closed);
    if (!closed) {
      writeEvent(res, "done", { ok });
      res.end();
    }
    return;
  }

  for (const [command, args] of plan.steps) {
    if (closed) return;
    const code = await runStep(command, args, env, res, shouldAbort);
    if (code !== 0) {
      writeEvent(res, "done", { ok: false });
      res.end();
      return;
    }
  }

  writeEvent(res, "done", { ok: true });
  res.end();
}

async function runAutoGame(body, env, res, shouldAbort, isClosed) {
  const gameConfig = buildGameConfig(body);
  const players = gameConfig.players;
  const roles = new Map(players.map((player) => [player.id, player.role]));
  const history = [];
  const eliminated = [];
  let alive = players.map((player) => player.id);
  let winner = "";
  let reason = "";
  const maxRounds = clampInt(body.maxRounds, 8, 1, 20);

  for (const [command, args] of [
    ["./bin/labctl", ["down"]],
    ["./bin/labctl", ["up"]],
  ]) {
    if (isClosed()) return false;
    const result = await runStep(command, args, env, res, shouldAbort);
    if (result !== 0) return false;
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundEnv = { ...env, ROUND: String(round) };
    writeEvent(res, "stdout", {
      data: `[referee] round ${round} starts with ${alive.join(", ")}\n`,
    });

    for (const id of alive) {
      if (isClosed()) return false;
      const result = await runStep(
        "./bin/labctl",
        ["run-agent", id, "vote"],
        { ...roundEnv, ACTIVE_PLAYER_IDS: alive.join(",") },
        res,
        shouldAbort,
      );
      if (result !== 0) return false;
    }

    const dayLog = await runStepCapture(
      "./bin/labctl",
      ["query", "public_log"],
      roundEnv,
      res,
      shouldAbort,
    );
    if (dayLog.code !== 0) return false;

    const dayVotes = pickRows(dayLog.stdout, "public_log").filter(
      (row) =>
        Number(row.round) === round &&
        row.action === "vote" &&
        alive.includes(row.agent_id) &&
        alive.includes(row.target),
    );
    const dayTarget = chooseTarget(dayVotes);
    if (dayTarget) {
      alive = alive.filter((id) => id !== dayTarget.target);
      eliminated.push({ id: dayTarget.target, round, phase: "day" });
      history.push({
        round,
        phase: "day",
        event: "vote",
        target: dayTarget.target,
        votes: dayTarget.votes,
      });
      writeEvent(res, "stdout", {
        data: `[referee] day ${round}: ${dayTarget.target} eliminated by ${dayTarget.votes} vote(s)\n`,
      });
    } else {
      history.push({ round, phase: "day", event: "no-elimination" });
      writeEvent(res, "stdout", { data: `[referee] day ${round}: no elimination\n` });
    }

    const dayWin = winnerFor(alive, roles);
    if (dayWin) {
      winner = dayWin.winner;
      reason = dayWin.reason;
      break;
    }

    const liveWolves = alive.filter((id) => roles.get(id) === "wolf");
    for (const id of liveWolves) {
      if (isClosed()) return false;
      const result = await runStep(
        "./bin/labctl",
        ["run-agent", id, "wolf"],
        { ...roundEnv, ACTIVE_PLAYER_IDS: alive.join(",") },
        res,
        shouldAbort,
      );
      if (result !== 0) return false;
    }

    const wolfLog = await runStepCapture(
      "./bin/labctl",
      ["query", "wolf_channel"],
      roundEnv,
      res,
      shouldAbort,
    );
    if (wolfLog.code !== 0) return false;

    const wolfVotes = pickRows(wolfLog.stdout, "wolf_channel").filter(
      (row) =>
        Number(row.round) === round &&
        row.action === "wolf-kill" &&
        alive.includes(row.agent_id) &&
        alive.includes(row.target),
    );
    const wolfTarget = chooseTarget(wolfVotes);
    if (wolfTarget) {
      alive = alive.filter((id) => id !== wolfTarget.target);
      eliminated.push({ id: wolfTarget.target, round, phase: "wolf" });
      history.push({
        round,
        phase: "wolf",
        event: "kill",
        target: wolfTarget.target,
        votes: wolfTarget.votes,
      });
      writeEvent(res, "stdout", {
        data: `[referee] night ${round}: ${wolfTarget.target} killed by wolves\n`,
      });
    } else {
      history.push({ round, phase: "wolf", event: "no-kill" });
      writeEvent(res, "stdout", { data: `[referee] night ${round}: no kill\n` });
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
    rounds: history.reduce((value, item) => Math.max(value, item.round || 0), 0),
    alive,
    eliminated,
    history,
  };

  writeEvent(res, "step", { command: "referee auto-game" });
  writeEvent(res, "stdout", { data: `${JSON.stringify([result])}\n` });
  writeEvent(res, "exit", { code: 0, signal: null });
  return true;
}

async function handleExport(req, res) {
  let body;
  let gameConfig;
  try {
    body = await readJson(req);
    body.configPath = await writeRuntimeConfig(body);
    gameConfig = buildGameConfig(body);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const env = buildLabEnv(body, process.env, { requireModel: false });
  const queryNames = ["whoami", "public_log", "wolf_channel", "full_log"];
  const results = {};
  const errors = [];

  for (const queryName of queryNames) {
    const result = await runBufferedStep("./bin/labctl", ["query", queryName], env);
    if (result.code !== 0) {
      errors.push({
        query: queryName,
        exitCode: result.code,
        output: `${result.stdout}${result.stderr}`.slice(0, 2000),
      });
      results[queryName] = [];
      continue;
    }
    results[queryName] = pickRows(result.stdout, queryName);
  }

  const payload = {
    exported_at: new Date().toISOString(),
    game_id: "werewolf-quack-lab",
    provider: env.LLM_PROVIDER,
    model: env.LLM_PROVIDER === "stub" ? "scripted" : env.LLM_MODEL,
    round: Number(env.ROUND),
    post_game_audit_enabled: env.POST_GAME === "true",
    players: gameConfig.players,
    nodes: results.whoami,
    public_log: results.public_log,
    wolf_channel: results.wolf_channel,
    audit_log: results.full_log,
    export_errors: errors,
  };

  sendJson(res, errors.length > 0 ? 207 : 200, payload);
}

async function writeRuntimeConfig(input) {
  const gameConfig = buildGameConfig(input);
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(WEB_CONFIG_PATH, `${JSON.stringify(gameConfig, null, 2)}\n`);
  return path.relative(ROOT_DIR, WEB_CONFIG_PATH);
}

async function handleModels(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const url = toHostModelUrl(body.baseUrl);
  const headers = {};
  if (body.apiKey) headers.Authorization = `Bearer ${body.apiKey}`;

  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    if (!response.ok) {
      sendJson(res, 502, {
        error: `model endpoint returned HTTP ${response.status}`,
        body: text.slice(0, 500),
      });
      return;
    }
    const data = JSON.parse(text);
    sendJson(res, 200, {
      url,
      models: Array.isArray(data.data)
        ? data.data.map((model) => model.id).filter(Boolean)
        : [],
    });
  } catch (error) {
    sendJson(res, 502, { error: error.message, url });
  }
}

function pickRows(raw, queryName) {
  const arrays = extractJsonArrays(raw).filter((value) => Array.isArray(value));
  const predicates = {
    whoami: (row) => row.name,
    public_log: (row) => row.public_text,
    wolf_channel: (row) => row.action === "wolf-kill" || row.rationale,
    full_log: (row) => row.public_text || row.rationale,
  };
  const predicate = predicates[queryName] || (() => true);
  return arrays.find((rows) => rows.some((row) => row && typeof row === "object" && predicate(row))) || [];
}

function chooseTarget(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row.target) continue;
    counts.set(row.target, (counts.get(row.target) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });
  if (ranked.length === 0) return null;
  return { target: ranked[0][0], votes: ranked[0][1] };
}

function winnerFor(alive, roles) {
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

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const candidate = path.resolve(WEB_DIR, relative);

  if (!candidate.startsWith(`${WEB_DIR}${path.sep}`) && candidate !== WEB_DIR) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  try {
    const info = await stat(candidate);
    const filePath = info.isDirectory() ? path.join(candidate, "index.html") : candidate;
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME.get(ext) || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    if (DEV_MODE && path.basename(filePath) === "index.html") {
      const html = await readFile(filePath, "utf8");
      res.end(injectDevClient(html));
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    const index = await readFile(path.join(WEB_DIR, "index.html"), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(DEV_MODE ? injectDevClient(index) : index);
  }
}

function injectDevClient(html) {
  if (!html.includes("</body>")) return html;
  const script = `
    <script>
      (() => {
        let disconnected = false;
        let reloaded = false;
        const reload = () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        };
        const events = new EventSource("/api/dev-events");
        events.addEventListener("open", () => {
          if (disconnected) reload();
        });
        events.addEventListener("reload", reload);
        events.addEventListener("error", () => {
          disconnected = true;
        });
      })();
    </script>`;
  return html.replace("</body>", `${script}\n  </body>`);
}

function handleDevEvents(req, res) {
  if (!DEV_MODE) {
    sendJson(res, 404, { error: "dev reload disabled" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const interval = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(interval);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/dev-events") {
      handleDevEvents(req, res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/config") {
      sendJson(res, 200, { actions: listActions() });
      return;
    }
    if (req.method === "POST" && req.url === "/api/run") {
      await handleRun(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/models") {
      await handleModels(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/export") {
      await handleExport(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", (error) => {
  console.error(`Failed to start Werewolf Quack Lab UI on port ${PORT}: ${error.message}`);
  killActiveChildren();
  process.exit(1);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  killActiveChildren();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Werewolf Quack Lab UI: http://localhost:${PORT}`);
  if (DEV_MODE) console.log("Dev reload enabled.");
});

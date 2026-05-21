#!/usr/bin/env node
// Werewolf Quack Lab web server.
//
// HTTP shell around the orchestrator (lib/referee.mjs). The referee owns
// every orchestrator concern (game loop, durable log, child-process
// supervision); this file is intentionally just routing, request shaping,
// and the NDJSON HTTP sink.

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
} from "../lib/lab-web-actions.mjs";
import {
  httpSink,
  killActiveChildren,
  pickRows,
  ROOT_DIR,
  runAutoGame,
  runBufferedStep,
  runStep,
} from "../lib/referee.mjs";

const WEB_DIR = path.join(ROOT_DIR, "web");
const GENERATED_DIR = path.join(ROOT_DIR, ".generated");
const WEB_CONFIG_PATH = path.join(GENERATED_DIR, "web-game.json");
const PORT = Number(process.env.LAB_WEB_PORT || process.env.PORT || 5174);
const DEV_MODE = truthyEnv(process.env.LAB_WEB_DEV);

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

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
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

  const sink = httpSink(res);
  sink.write("start", {
    action: body.action,
    label: plan.label,
    provider: env.LLM_PROVIDER,
    round: env.ROUND,
  });

  if (plan.special === "autoGame") {
    const ok = await runAutoGame(body, env, sink, { shouldAbort, isClosed: () => closed });
    if (!closed) {
      sink.write("done", { ok });
      res.end();
    }
    return;
  }

  for (const [command, args] of plan.steps) {
    if (closed) return;
    const code = await runStep(command, args, env, sink, shouldAbort);
    if (code !== 0) {
      sink.write("done", { ok: false });
      res.end();
      return;
    }
  }

  sink.write("done", { ok: true });
  res.end();
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
  const queryNames = [
    "whoami",
    "public_log",
    "wolf_channel",
    "seer_channel",
    "doctor_channel",
    "full_log",
  ];
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
    seer_channel: results.seer_channel,
    doctor_channel: results.doctor_channel,
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

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLabEnv,
  getActionPlan,
  listActions,
  toHostModelUrl,
} from "./lab-web-actions.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIR = path.join(ROOT_DIR, "web");
const PORT = Number(process.env.LAB_WEB_PORT || process.env.PORT || 5174);

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

async function runStep(command, args, env, res, shouldAbort) {
  writeEvent(res, "step", { command: [command, ...args].join(" ") });

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

async function handleRun(req, res) {
  let body;
  let plan;
  try {
    body = await readJson(req);
    plan = getActionPlan(body.action);
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
    createReadStream(filePath).pipe(res);
  } catch {
    const index = await readFile(path.join(WEB_DIR, "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(index);
  }
}

const server = createServer(async (req, res) => {
  try {
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
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Werewolf Quack Lab UI: http://localhost:${PORT}`);
});

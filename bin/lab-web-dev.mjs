#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_ENTRY = "bin/lab-web-server.mjs";
const WATCH_ROOTS = ["bin", "web", "sql", "config", "Dockerfile", "docker-compose.yml", "Makefile"];
const POLL_INTERVAL_MS = Number(process.env.LAB_WEB_POLL_MS || 500);
const IGNORED_DIRS = new Set([".git", ".generated", "node_modules"]);
const WATCH_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".yml",
]);
const WATCH_FILES = new Set(["Dockerfile", "Makefile"]);

let snapshot = collectSnapshot();
let server = null;
let restartTimer = null;
let killTimer = null;
let pollTimer = null;
let restarting = false;
let stopping = false;
let restartReason = "";

function startServer() {
  clearTimeout(killTimer);
  killTimer = null;

  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      LAB_WEB_DEV: "1",
    },
    stdio: "inherit",
  });

  server.on("exit", (code, signal) => {
    server = null;
    if (stopping) return;

    if (restarting) {
      restarting = false;
      startServer();
      return;
    }

    console.log(`[web-dev] server exited with ${signal || code}; restarting in 1s`);
    setTimeout(startServer, 1000);
  });
}

function scheduleRestart(reason) {
  if (stopping) return;
  restartReason = reason;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartServer, 150);
}

function restartServer() {
  if (stopping) return;
  console.log(`[web-dev] ${restartReason} changed, restarting web server`);

  if (!server) {
    startServer();
    return;
  }

  restarting = true;
  server.kill("SIGTERM");
  killTimer = setTimeout(() => {
    if (server && !server.killed) server.kill("SIGKILL");
  }, 3000);
}

function collectSnapshot() {
  const files = new Map();
  for (const root of WATCH_ROOTS) {
    scanPath(path.join(ROOT_DIR, root), files);
  }
  return files;
}

function scanPath(target, files) {
  if (!existsSync(target)) return;

  const info = statSync(target);
  if (info.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      scanPath(path.join(target, entry.name), files);
    }
    return;
  }

  if (info.isFile() && shouldRestartFor(target)) {
    files.set(target, `${info.mtimeMs}:${info.size}`);
  }
}

function pollForChanges() {
  const nextSnapshot = collectSnapshot();
  const changedPath = findChangedPath(snapshot, nextSnapshot);
  snapshot = nextSnapshot;

  if (changedPath) {
    scheduleRestart(relativePath(changedPath));
  }
}

function findChangedPath(previous, next) {
  for (const [filePath, signature] of next) {
    if (previous.get(filePath) !== signature) return filePath;
  }
  for (const filePath of previous.keys()) {
    if (!next.has(filePath)) return filePath;
  }
  return null;
}

function shouldRestartFor(filePath) {
  return WATCH_FILES.has(path.basename(filePath)) || WATCH_EXTENSIONS.has(path.extname(filePath));
}

function relativePath(filePath) {
  return path.relative(ROOT_DIR, filePath) || ".";
}

function shutdown(signal) {
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(killTimer);
  clearInterval(pollTimer);

  if (server && !server.killed) {
    server.kill("SIGTERM");
  }

  console.log(`[web-dev] stopped by ${signal}`);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

pollTimer = setInterval(pollForChanges, POLL_INTERVAL_MS);

console.log(
  `[web-dev] polling bin, web, sql, config, Dockerfile, docker-compose.yml, Makefile every ${POLL_INTERVAL_MS}ms`,
);
startServer();

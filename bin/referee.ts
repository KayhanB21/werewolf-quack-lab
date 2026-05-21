#!/usr/bin/env node
// Standalone referee CLI.
//
// Drives one auto-game without the HTTP server. Reads the run spec from a
// JSON file (matching the body shape POST /api/run accepts) and streams the
// same NDJSON event sequence to stdout. Useful for:
//   - reproducing a specific configuration outside the browser UI
//   - hooking into eval/run.ts without spinning up the web server
//   - the LLM-as-judge pass, which needs to walk durable logs the same way
//
// Usage:
//   bin/referee.ts <spec.json> [--exit-on-fail]
//   bin/referee.ts -            # read spec from stdin
//
// Exit code: 0 on game completion (regardless of winner), 1 on abort/error.

import { readFile } from "node:fs/promises";
import { buildLabEnv, getActionPlan } from "../lib/lab-web-actions.ts";
import { killActiveChildren, runAutoGame, stdoutSink, type AbortControl } from "../lib/referee.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.error("usage: bin/referee.ts <spec.json|-> [--exit-on-fail]");
    process.exit(2);
  }
  const specPath = args.find((a) => !a.startsWith("--"));
  if (!specPath) {
    console.error("usage: bin/referee.ts <spec.json|-> [--exit-on-fail]");
    process.exit(2);
  }
  const text =
    specPath === "-" ? await readStdin() : await readFile(specPath, "utf8");
  const body = JSON.parse(text);
  if (!body.action) body.action = "playGame";

  const plan = getActionPlan(body.action);
  if (plan.special !== "autoGame") {
    console.error(`bin/referee.ts only supports playGame; got action=${body.action}`);
    process.exit(2);
  }

  const env = buildLabEnv(body, process.env, { requireModel: plan.requiresModel !== false });
  const sink = stdoutSink();

  let aborted = false;
  const shouldAbort: AbortControl = { onAbort: null };
  const handleSignal = (signal: NodeJS.Signals): void => {
    sink.write("stderr", { data: `referee: received ${signal}, aborting...\n` });
    aborted = true;
    if (shouldAbort.onAbort) shouldAbort.onAbort();
    killActiveChildren();
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  sink.write("start", {
    action: body.action,
    label: plan.label,
    provider: env.LLM_PROVIDER,
    round: env.ROUND,
  });

  const ok = await runAutoGame(body, env, sink, {
    shouldAbort,
    isClosed: () => aborted,
  });
  sink.write("done", { ok });
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`referee: ${message}\n`);
  killActiveChildren();
  process.exit(1);
});

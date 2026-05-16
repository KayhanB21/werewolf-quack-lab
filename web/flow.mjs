export function classifyCommand(command) {
  if (command.endsWith("labctl up")) {
    return { kind: "start", title: "Start Lab", subject: "Containers" };
  }
  if (command.endsWith("labctl run-day")) {
    return { kind: "actions", title: "Day Actions", subject: "Public turns" };
  }
  if (command.endsWith("labctl run-wolf")) {
    return { kind: "actions", title: "Wolf Actions", subject: "Private turns" };
  }
  if (command.endsWith("labctl query public_log")) {
    return { kind: "publicLog", title: "Public Log", subject: "Federated view" };
  }
  if (command.endsWith("labctl query wolf_channel")) {
    return { kind: "wolfChannel", title: "Wolf Channel", subject: "Row-filtered view" };
  }
  if (command.endsWith("labctl query whoami")) {
    return { kind: "whoami", title: "Whoami", subject: "Quack nodes" };
  }
  if (command.endsWith("labctl query denied_private_table")) {
    return { kind: "denied", title: "Denied Scope", subject: "Authorization" };
  }
  if (command.endsWith("labctl smoke")) {
    return { kind: "smoke", title: "Smoke Test", subject: "Assertions" };
  }
  return { kind: "raw", title: command.replace(/^\.\//, ""), subject: "Command" };
}

export function extractJsonArrays(text) {
  const arrays = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "[") continue;

    const next = nextNonWhitespace(text, i + 1);
    if (next !== "{" && next !== "]") continue;

    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let j = i; j < text.length; j += 1) {
      const char = text[j];

      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === "\\") {
          escaping = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            arrays.push(JSON.parse(candidate));
            i = j;
          } catch {
            // Ignore bracketed non-JSON output, such as [gateway].
          }
          break;
        }
      }
    }
  }
  return arrays;
}

export function summarizeStep(command, raw, exitCode = 0) {
  const meta = classifyCommand(command);
  const summary = {
    ...meta,
    command,
    exitCode,
    status: exitCode === 0 ? "done" : "error",
    metrics: [],
    rows: [],
    assertions: [],
    note: "",
  };

  if (meta.kind === "start") {
    const players = uniqueMatches(raw, /Container werewolf-quack-lab-(agent-[a-z0-9_-]+)-1\s+Started/g);
    const built = uniqueMatches(raw, /werewolf-quack-lab-([a-z0-9_-]+)\s+Built/g);
    summary.metrics.push({ label: "players started", value: String(players.length) });
    summary.metrics.push({ label: "images ready", value: String(built.length) });
    summary.note = players.length > 0 ? players.join(", ") : "No player start lines found.";
    return summary;
  }

  if (meta.kind === "actions") {
    summary.rows = [...raw.matchAll(/\[(agent-[^\]]+)\] wrote ([^ ]+) for phase=([a-z]+)/g)].map(
      ([, agent, action, phase]) => ({ agent, action, phase }),
    );
    summary.metrics.push({ label: "actions", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "publicLog") {
    summary.rows = pickArray(raw, (row) => row.public_text).map((row) => ({
      agent: row.agent_id,
      action: row.action,
      target: row.target || "",
      text: row.public_text,
    }));
    summary.metrics.push({ label: "public rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "wolfChannel") {
    summary.rows = pickArray(raw, (row) => row.action === "wolf-kill" || row.rationale).map(
      (row) => ({
        agent: row.agent_id,
        target: row.target || "",
        rationale: row.rationale || "",
      }),
    );
    summary.metrics.push({ label: "wolf rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "whoami") {
    summary.rows = pickArray(raw, (row) => row.name).map((row) => ({
      name: row.name,
      host: row.hostname,
      provider: row.provider,
    }));
    summary.metrics.push({ label: "nodes", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "denied") {
    const denied = raw.includes("Authorization failed");
    summary.status = denied ? "done" : summary.status;
    summary.note = denied ? "Private intents query was rejected." : "No authorization denial found.";
    summary.metrics.push({ label: "denial", value: denied ? "observed" : "missing" });
    return summary;
  }

  if (meta.kind === "smoke") {
    summary.assertions = [...raw.matchAll(/^ok - (.+)$/gm)].map(([, label]) => label);
    summary.metrics.push({ label: "checks", value: String(summary.assertions.length) });
    return summary;
  }

  return summary;
}

function nextNonWhitespace(text, start) {
  for (let i = start; i < text.length; i += 1) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
}

function uniqueMatches(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];
}

function pickArray(raw, predicate) {
  return (
    extractJsonArrays(raw)
      .filter((value) => Array.isArray(value))
      .find((rows) => rows.some((row) => row && typeof row === "object" && predicate(row))) || []
  );
}

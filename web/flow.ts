type Row = Record<string, unknown>;
type SummaryRow = Record<string, string>;
type Metric = { label: string; value: string };
export type StepSummary = {
  kind: string;
  title: string;
  subject: string;
  command: string;
  exitCode: number;
  status: string;
  metrics: Metric[];
  rows: SummaryRow[];
  assertions: string[];
  note: string;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function objectRows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

export function classifyCommand(command: string) {
  const wolfRotation = command.match(/^referee round ([0-9]+) wolf rotation ([0-9]+)$/);
  if (wolfRotation) {
    const [, round, rotation] = wolfRotation;
    return {
      kind: "actions",
      title: `Round ${round} Wolf Rotation ${rotation}`,
      subject: "Private wolves",
    };
  }

  const wolfRotationLog = command.match(/^referee round ([0-9]+) wolf log rotation ([0-9]+)$/);
  if (wolfRotationLog) {
    const [, round, rotation] = wolfRotationLog;
    return {
      kind: "wolfChannel",
      title: `Round ${round} Wolf Channel (rotation ${rotation})`,
      subject: "Row-filtered view",
    };
  }

  const roundPhase = command.match(/^referee round ([0-9]+) (discussion|voting|wolf|doctor|seer)$/);
  if (roundPhase) {
    const [, round, phaseRaw] = roundPhase;
    const phase = phaseRaw as "discussion" | "voting" | "wolf" | "doctor" | "seer";
    const titles = {
      discussion: `Round ${round} Discussion`,
      voting: `Round ${round} Voting`,
      wolf: `Round ${round} Wolf Action`,
      doctor: `Round ${round} Doctor Action`,
      seer: `Round ${round} Seer Action`,
    };
    const subjects = {
      discussion: "Public talk",
      voting: "Public decision",
      wolf: "Private wolves",
      doctor: "Private doctor",
      seer: "Private seer",
    };
    return { kind: "actions", title: titles[phase], subject: subjects[phase] };
  }

  const roundLog = command.match(/^referee round ([0-9]+) (discussion log|vote log|wolf log|doctor log|seer log)$/);
  if (roundLog) {
    const [, round, logKind] = roundLog;
    if (logKind === "wolf log") {
      return { kind: "wolfChannel", title: `Round ${round} Wolf Channel`, subject: "Row-filtered view" };
    }
    if (logKind === "doctor log") {
      return { kind: "doctorChannel", title: `Round ${round} Doctor Channel`, subject: "Row-filtered view" };
    }
    if (logKind === "seer log") {
      return { kind: "seerChannel", title: `Round ${round} Seer Channel`, subject: "Row-filtered view" };
    }
    return {
      kind: "publicLog",
      title: logKind === "discussion log" ? `Round ${round} Public Talk` : `Round ${round} Vote Tally`,
      subject: "Federated view",
    };
  }

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
  if (command.endsWith("labctl query full_log")) {
    return { kind: "fullLog", title: "Audit Log", subject: "Post-game view" };
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
  if (command === "referee auto-game") {
    return { kind: "autoGame", title: "Game Result", subject: "Referee" };
  }
  return { kind: "raw", title: command.replace(/^\.\//, ""), subject: "Command" };
}

export function extractJsonArrays(text: string): unknown[] {
  const arrays: unknown[] = [];
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
            arrays.push(JSON.parse(candidate) as unknown);
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

export function summarizeStep(command: string, raw: string, exitCode = 0): StepSummary {
  const meta = classifyCommand(command);
  const summary = {
    ...meta,
    command,
    exitCode,
    status: exitCode === 0 ? "done" : "error",
    metrics: [] as Metric[],
    rows: [] as SummaryRow[],
    assertions: [] as string[],
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
      ([, agent, action, phase]) => ({ agent: agent || "", action: action || "", phase: phase || "" }),
    );
    summary.metrics.push({ label: "actions", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "publicLog") {
    summary.rows = pickArray(raw, (row) => row.public_text).map((row) => ({
      round: stringValue(row.round),
      agent: stringValue(row.agent_id),
      action: stringValue(row.action),
      target: stringValue(row.target),
      text: stringValue(row.public_text),
    }));
    summary.metrics.push({ label: "public rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "wolfChannel") {
    summary.rows = pickArray(
      raw,
      (row) => row.action === "wolf-kill" || row.action === "wolf-done" || row.rationale,
    ).map((row) => ({
      round: stringValue(row.round),
      agent: stringValue(row.agent_id),
      target: stringValue(row.target),
      rationale: stringValue(row.rationale),
    }));
    summary.metrics.push({ label: "wolf rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "doctorChannel") {
    summary.rows = pickArray(raw, (row) => row.action === "doctor-save" || row.rationale).map(
      (row) => ({
        round: stringValue(row.round),
        agent: stringValue(row.agent_id),
        target: stringValue(row.target),
        rationale: stringValue(row.rationale),
      }),
    );
    summary.metrics.push({ label: "doctor rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "seerChannel") {
    summary.rows = pickArray(raw, (row) => row.action === "seer-investigate" || row.rationale).map(
      (row) => ({
        round: stringValue(row.round),
        agent: stringValue(row.agent_id),
        target: stringValue(row.target),
        rationale: stringValue(row.rationale),
      }),
    );
    summary.metrics.push({ label: "seer rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "fullLog") {
    summary.rows = pickArray(raw, (row) => row.rationale || row.public_text).map((row) => ({
      round: stringValue(row.round),
      agent: stringValue(row.agent_id),
      action: stringValue(row.action),
      target: stringValue(row.target),
      text: stringValue(row.public_text),
      rationale: stringValue(row.rationale),
    }));
    summary.metrics.push({ label: "audit rows", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "whoami") {
    summary.rows = pickArray(raw, (row) => row.name).map((row) => ({
      name: stringValue(row.name),
      host: stringValue(row.hostname),
      provider: stringValue(row.provider),
    }));
    summary.metrics.push({ label: "nodes", value: String(summary.rows.length) });
    return summary;
  }

  if (meta.kind === "autoGame") {
    const result = pickArray(raw, (row) => row.winner)[0];
    if (!result) {
      summary.note = "No referee result found.";
      return summary;
    }
    summary.metrics.push({ label: "winner", value: stringValue(result.winner) });
    summary.metrics.push({ label: "rounds", value: String(result.rounds || 0) });
    summary.metrics.push({ label: "alive", value: String(Array.isArray(result.alive) ? result.alive.length : 0) });
    summary.note = stringValue(result.reason);
    summary.rows = objectRows(result.history).map((row) => ({
      round: stringValue(row.round),
      phase: stringValue(row.phase),
      event: stringValue(row.event),
      target: stringValue(row.target),
      count: stringValue(row.votes || row.turns),
    }));
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
    summary.assertions = [...raw.matchAll(/^ok - (.+)$/gm)].map(([, label]) => label || "");
    summary.metrics.push({ label: "checks", value: String(summary.assertions.length) });
    return summary;
  }

  return summary;
}

function nextNonWhitespace(text: string, start: number): string {
  for (let i = start; i < text.length; i += 1) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return "";
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] || ""))];
}

function pickArray(raw: string, predicate: (row: Row) => unknown): Row[] {
  return (
    extractJsonArrays(raw)
      .filter(Array.isArray)
      .map(objectRows)
      .find((rows) => rows.some((row) => row && typeof row === "object" && predicate(row))) || []
  );
}

const LABCTL = "./bin/labctl";
const ROLES = new Set(["wolf", "villager", "seer", "doctor"]);
const DEFAULT_MODELS = {
  stub: "stub-werewolf-v1",
  openai: "gpt-4o-mini",
};
const DEFAULT_PLAYERS = [
  { id: "agent-a", role: "wolf" },
  { id: "agent-b", role: "villager" },
  { id: "agent-c", role: "seer" },
  { id: "agent-d", role: "wolf" },
  { id: "agent-e", role: "doctor" },
];

export const ACTIONS = {
  start: {
    label: "Start Lab",
    steps: [[LABCTL, ["up"]]],
  },
  stop: {
    label: "Stop Lab",
    requiresModel: false,
    steps: [[LABCTL, ["down"]]],
  },
  day: {
    label: "Run Day",
    steps: [[LABCTL, ["run-day"]]],
  },
  wolf: {
    label: "Run Wolf",
    steps: [[LABCTL, ["run-wolf"]]],
  },
  publicLog: {
    label: "Public Log",
    requiresModel: false,
    steps: [[LABCTL, ["query", "public_log"]]],
  },
  wolfChannel: {
    label: "Wolf Channel",
    requiresModel: false,
    steps: [[LABCTL, ["query", "wolf_channel"]]],
  },
  fullLog: {
    label: "Audit Log",
    requiresModel: false,
    steps: [[LABCTL, ["query", "full_log"]]],
  },
  whoami: {
    label: "Whoami",
    requiresModel: false,
    steps: [[LABCTL, ["query", "whoami"]]],
  },
  denied: {
    label: "Denied Scope",
    requiresModel: false,
    steps: [[LABCTL, ["query", "denied_private_table"]]],
  },
  smoke: {
    label: "Smoke Test",
    steps: [[LABCTL, ["smoke"]]],
  },
  playGame: {
    label: "Play Game",
    special: "autoGame",
  },
  fullRound: {
    label: "Full Round",
    steps: [
      [LABCTL, ["down"]],
      [LABCTL, ["up"]],
      [LABCTL, ["run-day"]],
      [LABCTL, ["query", "public_log"]],
      [LABCTL, ["run-wolf"]],
      [LABCTL, ["query", "wolf_channel"]],
      [LABCTL, ["query", "denied_private_table"]],
    ],
  },
};

const PROVIDERS = new Set(["stub", "omlx", "openai-compatible", "openai"]);

export function getActionPlan(action) {
  const plan = ACTIONS[action];
  if (!plan) {
    throw new Error(`unknown action: ${action}`);
  }
  return plan;
}

export function listActions() {
  return Object.entries(ACTIONS).map(([id, action]) => ({
    id,
    label: action.label,
  }));
}

export function buildLabEnv(input = {}, baseEnv = process.env, options = {}) {
  const provider = String(input.provider || "stub").trim();
  if (!PROVIDERS.has(provider)) {
    throw new Error(`unsupported provider: ${provider}`);
  }

  const round = String(input.round || "1").trim();
  if (!/^[1-9][0-9]{0,3}$/.test(round)) {
    throw new Error("round must be a positive integer");
  }

  const env = {
    ...baseEnv,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ROUND: round,
    LLM_PROVIDER: provider,
    POST_GAME: truthy(input.postGame) ? "true" : "false",
  };

  if (input.configPath) {
    env.CONFIG_PATH = String(input.configPath);
  }

  if (provider === "stub") {
    env.LLM_MODEL = defaultModelForProvider(provider);
    env.LLM_BASE_URL = "https://api.openai.com/v1";
    env.LLM_API_KEY = "";
    return env;
  }

  const model = String(
    input.model || baseEnv.OMLX_MODEL || baseEnv.LLM_MODEL || defaultModelForProvider(provider),
  ).trim();
  if ((options.requireModel ?? true) && !model) {
    throw new Error("model is required for non-stub providers");
  }

  const baseUrl = String(
    input.baseUrl ||
      baseEnv.LLM_BASE_URL ||
      (provider === "omlx"
        ? "http://host.docker.internal:8000/v1"
        : "https://api.openai.com/v1"),
  ).trim();

  env.LLM_MODEL = model;
  env.LLM_BASE_URL = baseUrl;
  env.LLM_API_KEY = String(input.apiKey || baseEnv.OMLX_API_KEY || baseEnv.LLM_API_KEY || "");
  env.LLM_TIMEOUT_SECONDS = String(
    input.timeoutSeconds ||
      baseEnv.LLM_TIMEOUT_SECONDS ||
      (provider === "omlx" ? "180" : "60"),
  );

  return env;
}

export function buildGameConfig(input = {}) {
  const provider = String(input.provider || "stub").trim();
  if (!PROVIDERS.has(provider)) {
    throw new Error(`unsupported provider: ${provider}`);
  }

  const players = normalizePlayers(input.players);
  const model = String(input.model || defaultModelForProvider(provider)).trim();
  const baseUrl = String(
    input.baseUrl || (provider === "omlx"
      ? "http://host.docker.internal:8000/v1"
      : "https://api.openai.com/v1"),
  ).trim();

  return {
    game_id: "werewolf-quack-lab",
    players,
    model: {
      provider,
      model,
      base_url: baseUrl,
    },
  };
}

export function toHostModelUrl(baseUrl) {
  const normalized = String(baseUrl || "http://localhost:8000/v1")
    .trim()
    .replace("host.docker.internal", "localhost")
    .replace(/\/+$/, "");
  return `${normalized}/models`;
}

function truthy(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function defaultModelForProvider(provider) {
  return DEFAULT_MODELS[provider] || "";
}

function normalizePlayers(value) {
  const players = Array.isArray(value) && value.length > 0 ? value : DEFAULT_PLAYERS;
  if (players.length < 3 || players.length > 12) {
    throw new Error("player count must be between 3 and 12");
  }

  const normalized = players.map((player, index) => {
    const id = String(player.id || agentId(index)).trim();
    const role = String(player.role || "villager").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      throw new Error(`invalid player id: ${id}`);
    }
    if (!ROLES.has(role)) {
      throw new Error(`invalid role: ${role}`);
    }
    return { id, role };
  });

  const ids = new Set(normalized.map((player) => player.id));
  if (ids.size !== normalized.length) {
    throw new Error("player ids must be unique");
  }

  const wolfCount = normalized.filter((player) => player.role === "wolf").length;
  if (wolfCount < 1) {
    throw new Error("at least one wolf is required");
  }
  if (wolfCount >= normalized.length) {
    throw new Error("at least one non-wolf player is required");
  }

  return normalized;
}

export function buildContextForAgent(id, opts) {
  const {
    round,
    phase,
    alive = [],
    eliminated = [],
    publicEvents = [],
    publicLog = [],
    privateNotesByAgent = null,
  } = opts || {};
  const notes =
    privateNotesByAgent && typeof privateNotesByAgent.get === "function"
      ? privateNotesByAgent.get(id) || []
      : (opts?.privateNotes || []);
  return {
    round: Number(round) || 1,
    phase: String(phase || ""),
    you: id,
    alive: alive.slice(),
    eliminated: eliminated.map((entry) => ({
      id: entry.id,
      role: entry.role || "unknown",
      round: entry.round ?? null,
      cause: entry.cause || entry.phase || "eliminated",
    })),
    public_events: publicEvents.slice(-10),
    public_log: publicLog.slice(-20).map((row) => ({
      round: Number(row.round) || 0,
      speaker: row.agent_id || row.speaker || "",
      action: row.action || "",
      target: row.target || "",
      text: row.public_text || row.text || "",
    })),
    private_notes: notes.slice(-20),
  };
}

export function chooseTarget(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row || !row.target) continue;
    counts.set(row.target, (counts.get(row.target) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  });
  if (ranked.length === 0) return null;
  return { target: ranked[0][0], votes: ranked[0][1] };
}

export function latestRowPerAgent(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    if (!row || !row.agent_id) continue;
    const existing = latest.get(row.agent_id);
    if (!existing) {
      latest.set(row.agent_id, row);
      continue;
    }
    if (
      typeof row.decided_at === "string" &&
      typeof existing.decided_at === "string" &&
      row.decided_at > existing.decided_at
    ) {
      latest.set(row.agent_id, row);
    } else if (!existing.decided_at) {
      latest.set(row.agent_id, row);
    }
  }
  return latest;
}

export function latestKillsPerWolf(rows, liveWolves) {
  const latest = latestRowPerAgent(rows);
  const tally = [];
  for (const wolfId of liveWolves || []) {
    const row = latest.get(wolfId);
    if (!row || !row.target) continue;
    tally.push({ agent_id: wolfId, target: row.target, action: row.action });
  }
  return tally;
}

export function resolveNightOutcome(wolfRows, doctorRows) {
  const wolfTarget = chooseTarget(wolfRows);
  if (!wolfTarget) {
    return { outcome: "no-kill", target: null, votes: 0 };
  }
  const saves = new Set((doctorRows || []).map((row) => row && row.target).filter(Boolean));
  if (saves.has(wolfTarget.target)) {
    return { outcome: "saved", target: wolfTarget.target, votes: wolfTarget.votes };
  }
  return { outcome: "kill", target: wolfTarget.target, votes: wolfTarget.votes };
}

function agentId(index) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  if (index < alphabet.length) return `agent-${alphabet[index]}`;
  return `agent-${index + 1}`;
}

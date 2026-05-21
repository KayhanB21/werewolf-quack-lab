const LABCTL = "./bin/labctl";
const ROLES = new Set(["wolf", "villager", "seer", "doctor"]);
const DEFAULT_MODELS = {
  stub: "stub-werewolf-v1",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
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

const PROVIDERS = new Set(["stub", "omlx", "openai-compatible", "openai", "anthropic"]);

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
      defaultBaseUrlForProvider(provider),
  ).trim();

  env.LLM_MODEL = model;
  env.LLM_BASE_URL = baseUrl;
  env.LLM_API_KEY = String(input.apiKey || baseEnv.OMLX_API_KEY || baseEnv.LLM_API_KEY || "");
  env.LLM_TIMEOUT_SECONDS = String(
    input.timeoutSeconds ||
      baseEnv.LLM_TIMEOUT_SECONDS ||
      (provider === "omlx" ? "180" : "60"),
  );

  if (input.thinkingBudget !== undefined && input.thinkingBudget !== null && input.thinkingBudget !== "") {
    env.LLM_THINKING_BUDGET = String(input.thinkingBudget);
  }
  if (input.temperature !== undefined && input.temperature !== null) {
    env.LLM_TEMPERATURE = String(input.temperature);
  }
  if (input.maxTokens !== undefined && input.maxTokens !== null) {
    env.LLM_MAX_TOKENS = String(input.maxTokens);
  }

  return env;
}

export function buildGameConfig(input = {}) {
  const provider = String(input.provider || "stub").trim();
  if (!PROVIDERS.has(provider)) {
    throw new Error(`unsupported provider: ${provider}`);
  }

  const players = normalizePlayers(input.players);
  const model = String(input.model || defaultModelForProvider(provider)).trim();
  const baseUrl = String(input.baseUrl || defaultBaseUrlForProvider(provider)).trim();

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

function defaultBaseUrlForProvider(provider) {
  if (provider === "omlx") return "http://host.docker.internal:8000/v1";
  if (provider === "anthropic") return "https://api.anthropic.com";
  return "https://api.openai.com/v1";
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
    beliefsByAgent = null,
  } = opts || {};
  const notes =
    privateNotesByAgent && typeof privateNotesByAgent.get === "function"
      ? privateNotesByAgent.get(id) || []
      : (opts?.privateNotes || []);
  const beliefs =
    beliefsByAgent && typeof beliefsByAgent.get === "function"
      ? beliefsByAgent.get(id) || { suspicions: [], knowledge: [] }
      : { suspicions: [], knowledge: [] };
  const ownIntents = publicLog
    .filter((row) => (row.agent_id || row.speaker) === id)
    .slice(-10)
    .map((row) => ({
      round: Number(row.round) || 0,
      action: row.action || "",
      target: row.target || "",
      text: row.public_text || row.text || "",
    }));
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
    own_intents: ownIntents,
    private_notes: notes.slice(-20),
    beliefs: {
      suspicions: (beliefs.suspicions || []).slice(-10),
      knowledge: (beliefs.knowledge || []).slice(-10),
    },
  };
}

export function parseBeliefsMarkers(text) {
  const results = [];
  if (!text) return results;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("__BELIEFS__ ");
    if (idx < 0) continue;
    const jsonText = line.slice(idx + "__BELIEFS__ ".length).trim();
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object" && parsed.agent) {
        results.push({
          agent: String(parsed.agent),
          round: Number(parsed.round) || 0,
          phase: String(parsed.phase || ""),
          suspicions: Array.isArray(parsed.suspicions) ? parsed.suspicions : [],
          knowledge: Array.isArray(parsed.knowledge) ? parsed.knowledge : [],
        });
      }
    } catch {
      // ignore malformed markers
    }
  }
  return results;
}

export function applyBeliefsMarkers(beliefsByAgent, markers) {
  for (const marker of markers || []) {
    const existing = beliefsByAgent.get(marker.agent) || {
      suspicions: [],
      knowledge: [],
    };
    for (const item of marker.suspicions) {
      if (!item || typeof item !== "object") continue;
      existing.suspicions.push({
        round: marker.round,
        target: String(item.target || ""),
        p_wolf: clampUnit(item.p_wolf),
        reasoning: String(item.reasoning || ""),
      });
    }
    for (const item of marker.knowledge) {
      if (!item || typeof item !== "object") continue;
      existing.knowledge.push({
        round: marker.round,
        source: String(item.source || "deduction"),
        content: String(item.content || ""),
        confidence: clampUnit(item.confidence),
      });
    }
    beliefsByAgent.set(marker.agent, existing);
  }
  return beliefsByAgent;
}

export function parseTurnStatsMarkers(text) {
  const results = [];
  if (!text) return results;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("__TURN_STATS__ ");
    if (idx < 0) continue;
    const jsonText = line.slice(idx + "__TURN_STATS__ ".length).trim();
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || !parsed.agent) continue;
      const tokens = parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {};
      results.push({
        agent: String(parsed.agent),
        role: String(parsed.role || ""),
        phase: String(parsed.phase || ""),
        round: Number(parsed.round) || 0,
        provider: String(parsed.provider || ""),
        model: String(parsed.model || ""),
        parse_path: String(parsed.parse_path || ""),
        valid_json: parsed.valid_json === true,
        raw_action: String(parsed.raw_action || ""),
        normalized_action: String(parsed.normalized_action || ""),
        raw_target: typeof parsed.raw_target === "string" ? parsed.raw_target : "",
        normalized_target:
          typeof parsed.normalized_target === "string" ? parsed.normalized_target : "",
        target_overridden: parsed.target_overridden === true,
        action_in_phase: parsed.action_in_phase === true,
        finish_reason: String(parsed.finish_reason || ""),
        http_status: String(parsed.http_status || ""),
        tokens: {
          prompt: Number(tokens.prompt) || 0,
          completion: Number(tokens.completion) || 0,
          reasoning: Number(tokens.reasoning) || 0,
        },
        latency_ms: Number(parsed.latency_ms) || 0,
        suspicions_count: Number(parsed.suspicions_count) || 0,
        knowledge_count: Number(parsed.knowledge_count) || 0,
        reasoning_content: typeof parsed.reasoning_content === "string" ? parsed.reasoning_content : "",
      });
    } catch {
      // ignore malformed markers
    }
  }
  return results;
}

// Parses __INTENT__ <json> lines from agent-act.sh stdout. Each marker
// carries the normalized utterance the agent wrote AND the private
// rationale, which the judge pass needs to grade deception.
export function parseIntentMarkers(text) {
  const results = [];
  if (!text) return results;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf("__INTENT__ ");
    if (idx < 0) continue;
    const jsonText = line.slice(idx + "__INTENT__ ".length).trim();
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || !parsed.agent) continue;
      results.push({
        agent: String(parsed.agent),
        role: String(parsed.role || ""),
        phase: String(parsed.phase || ""),
        round: Number(parsed.round) || 0,
        action: String(parsed.action || ""),
        target: String(parsed.target || ""),
        public_text: typeof parsed.public_text === "string" ? parsed.public_text : "",
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      });
    } catch {
      // ignore malformed markers
    }
  }
  return results;
}

export function serializeRefereeEvent(event, nowIso) {
  if (!event || typeof event !== "object") {
    throw new Error("referee event must be an object");
  }
  if (!event.kind || typeof event.kind !== "string") {
    throw new Error("referee event must have a kind");
  }
  const { kind, ...rest } = event;
  const ts = typeof nowIso === "string" ? nowIso : new Date().toISOString();
  return `${JSON.stringify({ ts, kind, ...rest })}\n`;
}

export function newRefereeGameId(nowIso) {
  const iso = typeof nowIso === "string" ? nowIso : new Date().toISOString();
  const stamp = iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `game-${stamp}-${suffix}`;
}

function clampUnit(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
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

export function resolveLynch(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    if (!row || !row.target) continue;
    counts.set(row.target, (counts.get(row.target) || 0) + 1);
  }
  if (counts.size === 0) {
    return { outcome: "abstain", target: null, votes: 0 };
  }
  let topVotes = 0;
  let topTargets = [];
  for (const [target, votes] of counts) {
    if (votes > topVotes) {
      topVotes = votes;
      topTargets = [target];
    } else if (votes === topVotes) {
      topTargets.push(target);
    }
  }
  if (topTargets.length !== 1) {
    return { outcome: "abstain", target: null, votes: topVotes };
  }
  return { outcome: "lynch", target: topTargets[0], votes: topVotes };
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

const LABCTL = "./bin/labctl";

export const ACTIONS = {
  start: {
    label: "Start Lab",
    steps: [[LABCTL, ["up"]]],
  },
  stop: {
    label: "Stop Lab",
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
    steps: [[LABCTL, ["query", "public_log"]]],
  },
  wolfChannel: {
    label: "Wolf Channel",
    steps: [[LABCTL, ["query", "wolf_channel"]]],
  },
  whoami: {
    label: "Whoami",
    steps: [[LABCTL, ["query", "whoami"]]],
  },
  denied: {
    label: "Denied Scope",
    steps: [[LABCTL, ["query", "denied_private_table"]]],
  },
  smoke: {
    label: "Smoke Test",
    steps: [[LABCTL, ["smoke"]]],
  },
  fullRound: {
    label: "Full Round",
    steps: [
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

export function buildLabEnv(input = {}, baseEnv = process.env) {
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
  };

  if (provider === "stub") {
    env.LLM_MODEL = "stub-werewolf-v1";
    env.LLM_BASE_URL = "https://api.openai.com/v1";
    env.LLM_API_KEY = "";
    return env;
  }

  const model = String(input.model || baseEnv.OMLX_MODEL || baseEnv.LLM_MODEL || "").trim();
  if (!model) {
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
  env.LLM_TIMEOUT_SECONDS = String(input.timeoutSeconds || baseEnv.LLM_TIMEOUT_SECONDS || "60");

  return env;
}

export function toHostModelUrl(baseUrl) {
  const normalized = String(baseUrl || "http://localhost:8000/v1")
    .trim()
    .replace("host.docker.internal", "localhost")
    .replace(/\/+$/, "");
  return `${normalized}/models`;
}

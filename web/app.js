import { classifyCommand, summarizeStep } from "./flow.mjs";

const form = document.querySelector("#settings");
const log = document.querySelector("#log");
const timeline = document.querySelector("#timeline");
const statusEl = document.querySelector("#status");
const activeCommand = document.querySelector("#activeCommand");
const providerInputs = [...document.querySelectorAll("input[name='provider']")];
const playerCount = document.querySelector("#playerCount");
const playerRoster = document.querySelector("#playerRoster");
const model = document.querySelector("#model");
const baseUrl = document.querySelector("#baseUrl");
const apiKey = document.querySelector("#apiKey");
const postGame = document.querySelector("#postGame");
const buttons = [...document.querySelectorAll("[data-action]")];
const discoverButton = document.querySelector("[data-discover]");
const downloadButton = document.querySelector("[data-download]");
const clearButton = document.querySelector("[data-clear]");

let running = false;
let currentStep = null;

const roles = ["wolf", "villager", "seer", "doctor"];
const providerModelDefaults = {
  openai: "gpt-4o-mini",
};
const knownProviderModels = new Set(Object.values(providerModelDefaults));
let players = [
  { id: "agent-a", role: "wolf" },
  { id: "agent-b", role: "villager" },
  { id: "agent-c", role: "seer" },
  { id: "agent-d", role: "wolf" },
  { id: "agent-e", role: "doctor" },
];

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setRunning(next) {
  running = next;
  buttons.forEach((button) => {
    button.disabled = next;
  });
  downloadButton.disabled = next;
  playerCount.disabled = next;
  playerRoster.querySelectorAll("select").forEach((select) => {
    select.disabled = next;
  });
  updateProviderState();
}

function appendRaw(text, className = "") {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  log.append(span);
  log.scrollTop = log.scrollHeight;
}

function appendRawLine(text, className = "") {
  appendRaw(`${text}\n`, className);
}

function settings() {
  return {
    provider: selectedProvider(),
    round: form.elements.round.value,
    model: model.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    postGame: postGame.checked ? "true" : "false",
    players,
  };
}

function selectedProvider() {
  return form.elements.provider.value || "stub";
}

function renderPlayers() {
  const count = clampPlayerCount(Number(playerCount.value || players.length));
  players = Array.from({ length: count }, (_, index) => ({
    id: agentId(index),
    role: players[index]?.role || defaultRole(index),
  }));
  playerCount.value = String(count);
  playerRoster.replaceChildren(...players.map(playerRow));
}

function playerRow(player, index) {
  const row = document.createElement("label");
  row.className = "player-row";
  const name = document.createElement("span");
  name.textContent = player.id;

  const select = document.createElement("select");
  select.name = `role-${player.id}`;
  select.setAttribute("aria-label", `${player.id} role`);
  roles.forEach((role) => {
    const option = document.createElement("option");
    option.value = role;
    option.textContent = role;
    option.selected = role === player.role;
    select.append(option);
  });
  select.addEventListener("change", () => {
    players[index] = { ...players[index], role: select.value };
  });

  row.append(name, select);
  return row;
}

function clampPlayerCount(value) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(12, Math.max(3, Math.trunc(value)));
}

function defaultRole(index) {
  if (index === 0 || index === 3) return "wolf";
  if (index === 2) return "seer";
  if (index === 4) return "doctor";
  return "villager";
}

function agentId(index) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  if (index < alphabet.length) return `agent-${alphabet[index]}`;
  return `agent-${index + 1}`;
}

function applyProviderDefaults() {
  const value = selectedProvider();
  if (value === "stub") {
    model.value = "";
    baseUrl.value = "https://api.openai.com/v1";
    updateProviderState();
    return;
  }

  if (value === "omlx") {
    baseUrl.value = "http://host.docker.internal:8000/v1";
  } else if (value === "openai") {
    baseUrl.value = "https://api.openai.com/v1";
    if (shouldApplyModelDefault()) {
      model.value = providerModelDefaults.openai;
    }
  }
  updateProviderState();
}

function shouldApplyModelDefault() {
  const current = model.value.trim();
  return !current || knownProviderModels.has(current) || current.startsWith("MLX-");
}

function updateProviderState() {
  const value = selectedProvider();
  const isScripted = value === "stub";
  const modelPlaceholders = {
    stub: "not used",
    omlx: "local model id",
    "openai-compatible": "remote model id",
    openai: "gpt-4o-mini",
  };
  model.disabled = isScripted || running;
  baseUrl.disabled = isScripted || running;
  apiKey.disabled = isScripted || running;
  discoverButton.disabled = isScripted || running;
  model.required = !isScripted;
  baseUrl.required = !isScripted;
  model.placeholder = modelPlaceholders[value] || "model id";
}

function startRunCard(action) {
  const card = document.createElement("article");
  card.className = "run-card";
  card.innerHTML = `
    <div>
      <p class="step-subject">Run</p>
      <h2>${labelForAction(action)}</h2>
    </div>
    <span class="pill" data-kind="running">Running</span>
  `;
  timeline.append(card);
  timeline.scrollTop = timeline.scrollHeight;
  return card;
}

function startStep(command) {
  const meta = classifyCommand(command);
  const item = document.createElement("article");
  item.className = "step-card";
  item.dataset.status = "running";
  item.innerHTML = `
    <div class="step-head">
      <div>
        <p class="step-subject">${meta.subject}</p>
        <h3>${meta.title}</h3>
      </div>
      <span class="pill" data-kind="running">Running</span>
    </div>
    <div class="step-live"></div>
    <div class="step-body"></div>
  `;
  timeline.append(item);
  timeline.scrollTop = timeline.scrollHeight;
  currentStep = {
    command,
    raw: "",
    item,
    live: item.querySelector(".step-live"),
    body: item.querySelector(".step-body"),
    pill: item.querySelector(".pill"),
  };
}

function collectOutput(text) {
  if (!currentStep) return;
  currentStep.raw += text;
  updateLiveStep(currentStep);
}

function updateLiveStep(step) {
  const commandKind = classifyCommand(step.command).kind;
  if (commandKind !== "actions") return;

  const rows = [...step.raw.matchAll(/\[(agent-[^\]]+)\] wrote ([^ ]+) for phase=([a-z]+)/g)];
  step.live.replaceChildren(
    ...rows.map(([, agent, action, phase]) => chip(`${agent} ${action}`, phase)),
  );
}

function finishStep(code) {
  if (!currentStep) return;
  const summary = summarizeStep(currentStep.command, currentStep.raw, code ?? 1);
  currentStep.item.dataset.status = summary.status;
  currentStep.pill.textContent = summary.status === "done" ? "Done" : "Failed";
  currentStep.pill.dataset.kind = summary.status === "done" ? "done" : "error";
  currentStep.body.replaceChildren(renderSummary(summary));
  currentStep = null;
}

function renderSummary(summary) {
  const fragment = document.createDocumentFragment();

  if (summary.metrics.length > 0) {
    const metrics = document.createElement("div");
    metrics.className = "metrics";
    summary.metrics.forEach((metric) => {
      const node = document.createElement("div");
      node.className = "metric";
      node.innerHTML = `<strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.label)}</span>`;
      metrics.append(node);
    });
    fragment.append(metrics);
  }

  if (summary.note && summary.rows.length > 0) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = summary.note;
    fragment.append(note);
  }

  if (summary.rows.length > 0) {
    fragment.append(renderRows(summary));
  } else if (summary.assertions.length > 0) {
    const list = document.createElement("div");
    list.className = "assertion-list";
    summary.assertions.forEach((label) => list.append(chip(label, "ok")));
    fragment.append(list);
  } else if (summary.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = summary.note;
    fragment.append(note);
  }

  return fragment;
}

function renderRows(summary) {
  if (summary.kind === "actions") {
    return table(["Agent", "Action", "Phase"], summary.rows, (row) => [
      row.agent,
      row.action,
      row.phase,
    ]);
  }

  if (summary.kind === "publicLog") {
    return table(["Round", "Agent", "Action", "Target", "Public text"], summary.rows, (row) => [
      row.round,
      row.agent,
      row.action,
      row.target,
      row.text,
    ]);
  }

  if (summary.kind === "wolfChannel") {
    return table(["Round", "Wolf", "Target", "Private rationale"], summary.rows, (row) => [
      row.round,
      row.agent,
      row.target,
      row.rationale,
    ]);
  }

  if (summary.kind === "fullLog") {
    return table(
      ["Round", "Agent", "Action", "Target", "Public text", "Private rationale"],
      summary.rows,
      (row) => [row.round, row.agent, row.action, row.target, row.text, row.rationale],
    );
  }

  if (summary.kind === "autoGame") {
    return table(["Round", "Phase", "Event", "Target", "Count"], summary.rows, (row) => [
      row.round,
      row.phase,
      row.event,
      row.target,
      row.count,
    ]);
  }

  if (summary.kind === "whoami") {
    return table(["Node", "Host", "Provider"], summary.rows, (row) => [
      row.name,
      row.host,
      row.provider,
    ]);
  }

  return document.createTextNode("");
}

function table(headers, rows, mapRow) {
  const tableEl = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  thead.innerHTML = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`;
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    mapRow(row).forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value || "";
      tr.append(td);
    });
    tbody.append(tr);
  });
  tableEl.append(thead, tbody);
  return tableEl;
}

function chip(text, kind) {
  const span = document.createElement("span");
  span.className = "chip";
  span.dataset.kind = kind;
  span.textContent = text;
  return span;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[char];
  });
}

function labelForAction(action) {
  const labels = {
    start: "Start",
    day: "Day",
    publicLog: "Public Log",
    wolf: "Wolf",
    wolfChannel: "Wolf Channel",
    fullLog: "Audit Log",
    denied: "Denied Scope",
    playGame: "Play Game",
    fullRound: "Full Round",
    whoami: "Whoami",
    smoke: "Smoke",
    stop: "Stop",
  };
  return labels[action] || action;
}

async function runAction(action) {
  if (running) return;

  const payload = { action, ...settings() };
  setRunning(true);
  setStatus("Running", "running");
  activeCommand.textContent = labelForAction(action);
  const runCard = startRunCard(action);
  appendRawLine(`\n> ${action}`, "line-system");

  let response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    appendRawLine(error.message, "line-error");
    setStatus("Error", "error");
    setRunning(false);
    markRunCard(runCard, false);
    return;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    appendRawLine(payload.error || `HTTP ${response.status}`, "line-error");
    setStatus("Error", "error");
    setRunning(false);
    markRunCard(runCard, false);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ok = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "step") {
        appendRawLine(`$ ${event.command}`, "line-command");
        startStep(event.command);
      } else if (event.type === "stdout") {
        appendRaw(event.data);
        collectOutput(event.data);
      } else if (event.type === "stderr") {
        appendRaw(event.data, "line-error");
        collectOutput(event.data);
      } else if (event.type === "exit") {
        if (event.code !== 0) appendRawLine(`exit ${event.code}`, "line-error");
        finishStep(event.code);
      } else if (event.type === "done") {
        ok = event.ok;
      } else if (event.type === "error") {
        appendRawLine(event.message, "line-error");
      }
    }
  }

  setStatus(ok ? "Done" : "Error", ok ? "idle" : "error");
  activeCommand.textContent = ok ? "Last run complete" : "Last run failed";
  markRunCard(runCard, ok);
  setRunning(false);
}

function markRunCard(card, ok) {
  const pill = card.querySelector(".pill");
  pill.textContent = ok ? "Done" : "Failed";
  pill.dataset.kind = ok ? "done" : "error";
}

async function discoverModels() {
  if (running) return;
  setRunning(true);
  setStatus("Checking", "running");
  appendRawLine("\n> discover models", "line-system");

  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`${payload.error}${payload.body ? `: ${payload.body}` : ""}`);
    }
    appendRawLine(`models endpoint: ${payload.url}`, "line-command");
    if (payload.models.length === 0) {
      appendRawLine("no models returned", "line-error");
      setStatus("No Models", "error");
      return;
    }
    model.value = payload.models[0];
    payload.models.forEach((id) => appendRawLine(id));
    setStatus("Done");
  } catch (error) {
    appendRawLine(error.message, "line-error");
    setStatus("Error", "error");
  } finally {
    setRunning(false);
  }
}

async function downloadGame() {
  if (running) return;
  setRunning(true);
  setStatus("Exporting", "running");
  appendRawLine("\n> download game", "line-system");

  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings()),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `werewolf-quack-lab-${timestamp}.json`;
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    appendRawLine(`downloaded ${filename}`, "line-command");
    if (payload.export_errors?.length) {
      appendRawLine(`export completed with ${payload.export_errors.length} query warning(s)`);
    }
    setStatus("Done");
    activeCommand.textContent = "Game downloaded";
  } catch (error) {
    appendRawLine(error.message, "line-error");
    setStatus("Error", "error");
    activeCommand.textContent = "Download failed";
  } finally {
    setRunning(false);
  }
}

providerInputs.forEach((input) => {
  input.addEventListener("change", applyProviderDefaults);
});
playerCount.addEventListener("change", renderPlayers);
discoverButton.addEventListener("click", discoverModels);
downloadButton.addEventListener("click", downloadGame);
clearButton.addEventListener("click", () => {
  log.textContent = "";
  timeline.replaceChildren();
  activeCommand.textContent = "No command running";
});
buttons.forEach((button) => {
  button.addEventListener("click", () => runAction(button.dataset.action));
});

appendRawLine("Ready.");
renderPlayers();
applyProviderDefaults();

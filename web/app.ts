import { classifyCommand, summarizeStep, type StepSummary } from "./flow.js";

type Role = "wolf" | "villager" | "seer" | "doctor";
type Provider = "stub" | "omlx" | "openai-compatible" | "openai";
type Player = { id: string; role: Role };
type CurrentStep = {
  command: string;
  raw: string;
  item: HTMLElement;
  live: HTMLElement;
  body: HTMLElement;
  pill: HTMLElement;
};
type RecordValue = Record<string, unknown>;

function qs<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing required element: ${selector}`);
  return element;
}

function asRecord(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

const form = qs<HTMLFormElement>("#settings");
const log = qs<HTMLElement>("#log");
const timeline = qs<HTMLElement>("#timeline");
const statusEl = qs<HTMLElement>("#status");
const activeCommand = qs<HTMLElement>("#activeCommand");
const providerInputs = [...document.querySelectorAll<HTMLInputElement>("input[name='provider']")];
const playerCount = qs<HTMLInputElement>("#playerCount");
const playerRoster = qs<HTMLElement>("#playerRoster");
const model = qs<HTMLInputElement>("#model");
const baseUrl = qs<HTMLInputElement>("#baseUrl");
const apiKey = qs<HTMLInputElement>("#apiKey");
const postGame = qs<HTMLInputElement>("#postGame");
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-action]")];
const discoverButton = qs<HTMLButtonElement>("[data-discover]");
const downloadButton = qs<HTMLButtonElement>("[data-download]");
const clearButton = qs<HTMLButtonElement>("[data-clear]");

let running = false;
let currentStep: CurrentStep | null = null;

const roles: Role[] = ["wolf", "villager", "seer", "doctor"];
const providerModelDefaults: Partial<Record<Provider, string>> = {
  openai: "gpt-4o-mini",
};
const knownProviderModels = new Set(Object.values(providerModelDefaults));
let players: Player[] = [
  { id: "agent-a", role: "wolf" },
  { id: "agent-b", role: "villager" },
  { id: "agent-c", role: "seer" },
  { id: "agent-d", role: "wolf" },
  { id: "agent-e", role: "doctor" },
];

function setStatus(text: string, state = "idle"): void {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setRunning(next: boolean): void {
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

function appendRaw(text: string, className = ""): void {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  log.append(span);
  log.scrollTop = log.scrollHeight;
}

function appendRawLine(text: string, className = ""): void {
  appendRaw(`${text}\n`, className);
}

function settings() {
  const data = new FormData(form);
  return {
    provider: selectedProvider(),
    round: stringValue(data.get("round")) || "1",
    model: model.value,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    postGame: postGame.checked ? "true" : "false",
    players,
  };
}

function selectedProvider(): Provider {
  const value = stringValue(new FormData(form).get("provider"));
  if (value === "omlx" || value === "openai-compatible" || value === "openai") return value;
  return "stub";
}

function renderPlayers(): void {
  const count = clampPlayerCount(Number(playerCount.value || players.length));
  players = Array.from({ length: count }, (_, index) => ({
    id: agentId(index),
    role: players[index]?.role || defaultRole(index),
  }));
  playerCount.value = String(count);
  playerRoster.replaceChildren(...players.map(playerRow));
}

function playerRow(player: Player, index: number): HTMLElement {
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
    const role = roles.includes(select.value as Role) ? (select.value as Role) : "villager";
    players[index] = { ...(players[index] || player), role };
  });

  row.append(name, select);
  return row;
}

function clampPlayerCount(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(12, Math.max(3, Math.trunc(value)));
}

function defaultRole(index: number): Role {
  if (index === 0 || index === 3) return "wolf";
  if (index === 2) return "seer";
  if (index === 4) return "doctor";
  return "villager";
}

function agentId(index: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  if (index < alphabet.length) return `agent-${alphabet[index]}`;
  return `agent-${index + 1}`;
}

function applyProviderDefaults(): void {
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
      model.value = providerModelDefaults.openai ?? "";
    }
  }
  updateProviderState();
}

function shouldApplyModelDefault(): boolean {
  const current = model.value.trim();
  return !current || knownProviderModels.has(current) || current.startsWith("MLX-");
}

function updateProviderState(): void {
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

function startRunCard(action: string): HTMLElement {
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

function startStep(command: string): void {
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
    live: item.querySelector<HTMLElement>(".step-live") || item,
    body: item.querySelector<HTMLElement>(".step-body") || item,
    pill: item.querySelector<HTMLElement>(".pill") || item,
  };
}

function collectOutput(text: string): void {
  if (!currentStep) return;
  currentStep.raw += text;
  updateLiveStep(currentStep);
}

function updateLiveStep(step: CurrentStep): void {
  const commandKind = classifyCommand(step.command).kind;
  if (commandKind !== "actions") return;

  const rows = [...step.raw.matchAll(/\[(agent-[^\]]+)\] wrote ([^ ]+) for phase=([a-z]+)/g)];
  step.live.replaceChildren(
    ...rows.map(([, agent, action, phase]) => chip(`${agent || ""} ${action || ""}`, phase || "")),
  );
}

function finishStep(code: number): void {
  if (!currentStep) return;
  const summary = summarizeStep(currentStep.command, currentStep.raw, code ?? 1);
  currentStep.item.dataset.status = summary.status;
  currentStep.pill.textContent = summary.status === "done" ? "Done" : "Failed";
  currentStep.pill.dataset.kind = summary.status === "done" ? "done" : "error";
  currentStep.body.replaceChildren(renderSummary(summary));
  currentStep = null;
}

function renderSummary(summary: StepSummary): DocumentFragment {
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
    summary.assertions.forEach((label: string) => list.append(chip(label, "ok")));
    fragment.append(list);
  } else if (summary.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = summary.note;
    fragment.append(note);
  }

  return fragment;
}

function renderRows(summary: StepSummary): HTMLElement | Text {
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

function table(headers: string[], rows: Record<string, string>[], mapRow: (row: Record<string, string>) => string[]): HTMLTableElement {
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

function chip(text: string, kind: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "chip";
  span.dataset.kind = kind;
  span.textContent = text;
  return span;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[char];
  });
}

function labelForAction(action: string): string {
  const labels: Record<string, string> = {
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

async function runAction(action: string): Promise<void> {
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
    appendRawLine(errorMessage(error), "line-error");
    setStatus("Error", "error");
    setRunning(false);
    markRunCard(runCard, false);
    return;
  }

  if (!response.ok) {
    const payload = asRecord(await response.json().catch(() => ({})));
    appendRawLine(stringValue(payload.error) || `HTTP ${response.status}`, "line-error");
    setStatus("Error", "error");
    setRunning(false);
    markRunCard(runCard, false);
    return;
  }

  if (!response.body) {
    appendRawLine("empty response body", "line-error");
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
      const event = asRecord(JSON.parse(line));
      if (event.type === "step") {
        const command = stringValue(event.command);
        appendRawLine(`$ ${command}`, "line-command");
        startStep(command);
      } else if (event.type === "stdout") {
        const data = stringValue(event.data);
        appendRaw(data);
        collectOutput(data);
      } else if (event.type === "stderr") {
        const data = stringValue(event.data);
        appendRaw(data, "line-error");
        collectOutput(data);
      } else if (event.type === "exit") {
        const code = Number(event.code);
        if (code !== 0) appendRawLine(`exit ${code}`, "line-error");
        finishStep(code);
      } else if (event.type === "done") {
        ok = event.ok === true;
      } else if (event.type === "error") {
        appendRawLine(stringValue(event.message), "line-error");
      }
    }
  }

  setStatus(ok ? "Done" : "Error", ok ? "idle" : "error");
  activeCommand.textContent = ok ? "Last run complete" : "Last run failed";
  markRunCard(runCard, ok);
  setRunning(false);
}

function markRunCard(card: HTMLElement, ok: boolean): void {
  const pill = card.querySelector<HTMLElement>(".pill");
  if (!pill) return;
  pill.textContent = ok ? "Done" : "Failed";
  pill.dataset.kind = ok ? "done" : "error";
}

async function discoverModels(): Promise<void> {
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
    const payload = asRecord(await response.json());
    if (!response.ok) {
      throw new Error(`${payload.error}${payload.body ? `: ${payload.body}` : ""}`);
    }
    appendRawLine(`models endpoint: ${payload.url}`, "line-command");
    const models = Array.isArray(payload.models) ? payload.models.map(stringValue).filter(Boolean) : [];
    if (models.length === 0) {
      appendRawLine("no models returned", "line-error");
      setStatus("No Models", "error");
      return;
    }
    model.value = models[0] || "";
    models.forEach((id: string) => appendRawLine(id));
    setStatus("Done");
  } catch (error) {
    appendRawLine(errorMessage(error), "line-error");
    setStatus("Error", "error");
  } finally {
    setRunning(false);
  }
}

async function downloadGame(): Promise<void> {
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
    const payload = asRecord(await response.json());
    if (!response.ok) {
      throw new Error(stringValue(payload.error) || `HTTP ${response.status}`);
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
    const exportErrors = Array.isArray(payload.export_errors) ? payload.export_errors : [];
    if (exportErrors.length) {
      appendRawLine(`export completed with ${exportErrors.length} query warning(s)`);
    }
    setStatus("Done");
    activeCommand.textContent = "Game downloaded";
  } catch (error) {
    appendRawLine(errorMessage(error), "line-error");
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
  button.addEventListener("click", () => runAction(button.dataset.action || ""));
});

appendRawLine("Ready.");
renderPlayers();
applyProviderDefaults();

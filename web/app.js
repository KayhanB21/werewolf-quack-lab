import { classifyCommand, summarizeStep } from "./flow.mjs";

const form = document.querySelector("#settings");
const log = document.querySelector("#log");
const timeline = document.querySelector("#timeline");
const statusEl = document.querySelector("#status");
const activeCommand = document.querySelector("#activeCommand");
const providerInputs = [...document.querySelectorAll("input[name='provider']")];
const model = document.querySelector("#model");
const baseUrl = document.querySelector("#baseUrl");
const apiKey = document.querySelector("#apiKey");
const buttons = [...document.querySelectorAll("[data-action]")];
const discoverButton = document.querySelector("[data-discover]");
const clearButton = document.querySelector("[data-clear]");

let running = false;
let currentStep = null;

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setRunning(next) {
  running = next;
  buttons.forEach((button) => {
    button.disabled = next;
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
  };
}

function selectedProvider() {
  return form.elements.provider.value || "stub";
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
  }
  updateProviderState();
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
    return table(["Agent", "Action", "Target", "Public text"], summary.rows, (row) => [
      row.agent,
      row.action,
      row.target,
      row.text,
    ]);
  }

  if (summary.kind === "wolfChannel") {
    return table(["Wolf", "Target", "Private rationale"], summary.rows, (row) => [
      row.agent,
      row.target,
      row.rationale,
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
    denied: "Denied Scope",
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

providerInputs.forEach((input) => {
  input.addEventListener("change", applyProviderDefaults);
});
discoverButton.addEventListener("click", discoverModels);
clearButton.addEventListener("click", () => {
  log.textContent = "";
  timeline.replaceChildren();
  activeCommand.textContent = "No command running";
});
buttons.forEach((button) => {
  button.addEventListener("click", () => runAction(button.dataset.action));
});

appendRawLine("Ready.");
applyProviderDefaults();

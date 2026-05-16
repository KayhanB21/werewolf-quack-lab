const form = document.querySelector("#settings");
const log = document.querySelector("#log");
const statusEl = document.querySelector("#status");
const activeCommand = document.querySelector("#activeCommand");
const provider = document.querySelector("#provider");
const model = document.querySelector("#model");
const baseUrl = document.querySelector("#baseUrl");
const apiKey = document.querySelector("#apiKey");
const buttons = [...document.querySelectorAll("[data-action]")];
const discoverButton = document.querySelector("[data-discover]");
const clearButton = document.querySelector("[data-clear]");

let running = false;

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function setRunning(next) {
  running = next;
  buttons.forEach((button) => {
    button.disabled = next;
  });
  discoverButton.disabled = next;
}

function append(text, className = "") {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  log.append(span);
  log.scrollTop = log.scrollHeight;
}

function appendLine(text, className = "") {
  append(`${text}\n`, className);
}

function settings() {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    provider: data.provider,
    round: data.round,
    model: data.model,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
  };
}

function applyProviderDefaults() {
  if (provider.value === "stub") {
    model.value = "";
    baseUrl.value = "https://api.openai.com/v1";
    return;
  }

  if (provider.value === "omlx") {
    baseUrl.value = "http://host.docker.internal:8000/v1";
  }
}

async function runAction(action) {
  if (running) return;

  setRunning(true);
  setStatus("Running", "running");
  activeCommand.textContent = action;
  appendLine(`\n> ${action}`, "line-system");

  let response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...settings() }),
    });
  } catch (error) {
    appendLine(error.message, "line-error");
    setStatus("Error", "error");
    setRunning(false);
    return;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    appendLine(payload.error || `HTTP ${response.status}`, "line-error");
    setStatus("Error", "error");
    setRunning(false);
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
        appendLine(`$ ${event.command}`, "line-command");
      } else if (event.type === "stdout") {
        append(event.data);
      } else if (event.type === "stderr") {
        append(event.data, "line-error");
      } else if (event.type === "exit" && event.code !== 0) {
        appendLine(`exit ${event.code}`, "line-error");
      } else if (event.type === "done") {
        ok = event.ok;
      } else if (event.type === "error") {
        appendLine(event.message, "line-error");
      }
    }
  }

  setStatus(ok ? "Done" : "Error", ok ? "idle" : "error");
  activeCommand.textContent = ok ? "Last run complete" : "Last run failed";
  setRunning(false);
}

async function discoverModels() {
  if (running) return;
  setRunning(true);
  setStatus("Checking", "running");
  appendLine("\n> discover models", "line-system");

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
    appendLine(`models endpoint: ${payload.url}`, "line-command");
    if (payload.models.length === 0) {
      appendLine("no models returned", "line-error");
      setStatus("No Models", "error");
      return;
    }
    model.value = payload.models[0];
    payload.models.forEach((id) => appendLine(id));
    setStatus("Done");
  } catch (error) {
    appendLine(error.message, "line-error");
    setStatus("Error", "error");
  } finally {
    setRunning(false);
  }
}

provider.addEventListener("change", applyProviderDefaults);
discoverButton.addEventListener("click", discoverModels);
clearButton.addEventListener("click", () => {
  log.textContent = "";
  activeCommand.textContent = "No command running";
});
buttons.forEach((button) => {
  button.addEventListener("click", () => runAction(button.dataset.action));
});

appendLine("Ready. Start the lab, run day, inspect public log, run wolf, inspect wolf channel.");

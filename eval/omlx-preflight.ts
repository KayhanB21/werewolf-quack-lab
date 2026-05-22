#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateProfile } from "./run.ts";

type PreflightFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<Pick<Response, "ok" | "status" | "text">>;

type EnvMap = Record<string, string | undefined>;
export type OmlxPreflightInput = {
  base_url: string;
  api_key_env: string;
  model?: string;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function modelsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`OMLX preflight: invalid base_url "${baseUrl}"`);
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function extractModelIds(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && !Array.isArray(item)) return str((item as { id?: unknown }).id);
      return "";
    })
    .filter((id) => id.length > 0);
}

function redact(value: string, secret: string): string {
  return secret ? value.split(secret).join("[redacted]") : value;
}

export async function preflightOmlx(
  input: OmlxPreflightInput,
  { env = process.env, fetchImpl = fetch }: { env?: EnvMap; fetchImpl?: PreflightFetch } = {},
): Promise<{ ok: true; models: string[]; url: string }> {
  const key = input.api_key_env ? env[input.api_key_env] || "" : "";
  if (!key) {
    throw new Error(`OMLX preflight: missing ${input.api_key_env || "api_key_env"}; set it before running live local evals`);
  }

  const url = modelsUrl(input.base_url);
  let res: Pick<Response, "ok" | "status" | "text">;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OMLX preflight: could not connect to ${url}: ${message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ` Check ${input.api_key_env}.` : "";
    throw new Error(`OMLX preflight: GET ${url} returned HTTP ${res.status}.${hint} Body: ${redact(text, key).slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`OMLX preflight: GET ${url} did not return valid JSON`);
  }

  const models = extractModelIds(parsed);
  if (models.length === 0) {
    throw new Error(`OMLX preflight: GET ${url} returned no model ids in data[]`);
  }
  if (input.model && !models.includes(input.model)) {
    throw new Error(
      `OMLX preflight: expected model "${input.model}" was not returned by /models. Available models: ${models.join(", ")}`,
    );
  }
  return { ok: true, models, url };
}

export async function preflightOmlxProfile(
  profileJson: unknown,
  options: { env?: EnvMap; fetchImpl?: PreflightFetch } = {},
): Promise<{ ok: true; models: string[]; url: string }> {
  const profile = validateProfile(profileJson);
  if (profile.provider !== "omlx") {
    throw new Error(`OMLX preflight: profile "${profile.name}" uses provider "${profile.provider}", not "omlx"`);
  }
  return preflightOmlx(
    {
      base_url: profile.base_url,
      api_key_env: profile.api_key_env,
      model: profile.model,
    },
    options,
  );
}

function parseArgs(argv: string[]): { profilePath: string; input: OmlxPreflightInput | null } {
  let profilePath = "";
  const input: OmlxPreflightInput = { base_url: "", api_key_env: "", model: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => argv[++i] || "";
    if (arg === "--base-url") input.base_url = next();
    else if (arg === "--api-key-env") input.api_key_env = next();
    else if (arg === "--model") input.model = next();
    else if (!arg.startsWith("--")) profilePath = arg;
  }
  if (input.base_url || input.api_key_env || input.model) return { profilePath, input };
  return { profilePath, input: null };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { profilePath, input } = parseArgs(process.argv.slice(2));
  try {
    const result = input
      ? await preflightOmlx(input)
      : await preflightOmlxProfile(JSON.parse(await readFile(profilePath, "utf8")) as unknown);
    console.error(`[omlx-preflight] ok ${result.url} models=${result.models.length}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

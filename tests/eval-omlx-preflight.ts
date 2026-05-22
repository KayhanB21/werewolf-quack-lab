#!/usr/bin/env node
import assert from "node:assert/strict";
import { preflightOmlx, preflightOmlxProfile } from "../eval/omlx-preflight.ts";

type MockResponse = { ok: boolean; status: number; text: () => Promise<string> };

const secret = "local-secret";

function response(status: number, text: string): MockResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

async function rejectsWithoutSecret(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
}

await rejectsWithoutSecret(
  preflightOmlx({ base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "m" }, { env: {} }),
  /missing OMLX_API_KEY/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "not a url", api_key_env: "OMLX_API_KEY", model: "m" },
    { env: { OMLX_API_KEY: secret } },
  ),
  /invalid base_url/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "m" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  ),
  /could not connect/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "m" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async () => response(401, "bad key local-secret"),
    },
  ),
  /HTTP 401/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "m" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async () => response(403, "forbidden"),
    },
  ),
  /HTTP 403/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "m" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async () => response(200, "{nope"),
    },
  ),
  /valid JSON/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "m" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async () => response(200, JSON.stringify({ data: [] })),
    },
  ),
  /no model ids/,
);

await rejectsWithoutSecret(
  preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "missing" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async () => response(200, JSON.stringify({ data: [{ id: "present" }] })),
    },
  ),
  /expected model/,
);

{
  let auth = "";
  const result = await preflightOmlx(
    { base_url: "http://localhost:8000/v1", api_key_env: "OMLX_API_KEY", model: "present" },
    {
      env: { OMLX_API_KEY: secret },
      fetchImpl: async (url, init) => {
        assert.equal(url, "http://localhost:8000/v1/models");
        auth = init.headers.Authorization;
        return response(200, JSON.stringify({ data: [{ id: "present" }] }));
      },
    },
  );
  assert.equal(auth, `Bearer ${secret}`);
  assert.deepEqual(result.models, ["present"]);
}

await rejectsWithoutSecret(
  preflightOmlxProfile(
    {
      name: "stub",
      provider: "stub",
      game_count: 1,
      players: [
        { id: "p1", role: "wolf" },
        { id: "p2", role: "seer" },
        { id: "p3", role: "doctor" },
      ],
    },
    { env: { OMLX_API_KEY: secret } },
  ),
  /not "omlx"/,
);

console.log("ok - eval omlx preflight");

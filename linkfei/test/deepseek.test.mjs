import assert from "node:assert/strict";
import test from "node:test";

import { createDeepSeekClient } from "../src/deepseek.mjs";

test("chat sends an OpenAI-compatible request and returns text", async () => {
  let captured;
  const fakeFetch = async (url, options) => {
    captured = { url, options };
    return new Response(
      JSON.stringify({
        id: "test-response",
        choices: [{ message: { content: "OK" } }],
        usage: { total_tokens: 3 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const client = createDeepSeekClient({
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com/",
    fetchImpl: fakeFetch,
  });
  const result = await client.chat({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(captured.options.body).model, "deepseek-v4-flash");
  assert.equal(result.content, "OK");
});

test("chat reports API errors without exposing the key", async () => {
  const client = createDeepSeekClient({
    apiKey: "secret-value",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
      }),
  });

  await assert.rejects(
    () =>
      client.chat({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});

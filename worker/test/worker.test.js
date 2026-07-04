import assert from "node:assert/strict";
import test from "node:test";

import worker, { handleRequest, hashToken } from "../src/index.js";

class MemoryKV {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  async get(key, type) {
    const value = this.values.get(key);
    if (value == null) {
      return null;
    }
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }
}

class MemoryDurableNamespace {
  constructor(entries = {}) {
    this.usedById = new Map(Object.entries(entries));
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    return {
      fetch: async (url) => {
        const parsed = new URL(url);
        const used = Math.max(0, Number(this.usedById.get(id)) || 0);
        if (parsed.pathname === "/refund") {
          const nextUsed = Math.max(0, used - 1);
          this.usedById.set(id, nextUsed);
          return new Response(JSON.stringify({ ok: true, used: nextUsed }));
        }

        const limit = Math.max(1, Number(parsed.searchParams.get("limit")) || 5);
        if (used >= limit) {
          return new Response(JSON.stringify({ ok: false, used, remaining: 0, limit }), { status: 402 });
        }

        const nextUsed = used + 1;
        this.usedById.set(id, nextUsed);
        return new Response(JSON.stringify({
          ok: true,
          used: nextUsed,
          remaining: Math.max(0, limit - nextUsed),
          limit
        }));
      }
    };
  }
}

async function environmentFor(code, invite = { limit: 5, enabled: true }, used = 0) {
  const hash = await hashToken(code);
  return {
    DEEPSEEK_API_KEY: "server-secret",
    DEEPSEEK_MODEL: "deepseek-v4-flash",
    TRIAL_LIMIT: "5",
    GLOBAL_DAILY_LIMIT: "100",
    RATE_LIMIT_PER_MINUTE: "100",
    TRIALS: new MemoryKV({ [`invite:${hash}`]: JSON.stringify(invite) }),
    TRIAL_LIMITER: new MemoryDurableNamespace({ [hash]: used })
  };
}

function analyzeRequest(code, body = {}, ip = "203.0.113.8") {
  return new Request("https://worker.example/v1/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Trial-Code": code,
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify({
      sentence: "This is a useful sentence.",
      context: "Nearby subtitle context.",
      videoTitle: "Demo video",
      playbackTime: "01:23",
      ...body
    })
  });
}

function successfulUpstream() {
  return new Response(JSON.stringify({
    choices: [{ message: { content: '{"zh":"测试"}' } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("health endpoint is available", async () => {
  const response = await worker.fetch(new Request("https://worker.example/health"), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("rejects an unknown invitation code", async () => {
  const env = {
    DEEPSEEK_API_KEY: "secret",
    TRIALS: new MemoryKV(),
    TRIAL_LIMITER: new MemoryDurableNamespace()
  };
  const response = await handleRequest(analyzeRequest("unknown-code"), env, {}, async () => {
    throw new Error("must not call upstream");
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "INVALID_TRIAL_CODE");
});

test("uses the server key and decrements the five-use trial", async () => {
  const code = "SAI_test_code_123";
  const env = await environmentFor(code);
  let upstreamRequest;
  const response = await handleRequest(analyzeRequest(code), env, {}, async (url, options) => {
    upstreamRequest = { url, options };
    return successfulUpstream();
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.trial.remaining, 4);
  assert.equal(upstreamRequest.options.headers.Authorization, "Bearer server-secret");
  const upstreamBody = JSON.parse(upstreamRequest.options.body);
  assert.equal(upstreamBody.model, "deepseek-v4-flash");
  assert.match(upstreamBody.user_id, /^trial_[a-f0-9]{24}$/);
  assert.equal(env.TRIAL_LIMITER.usedById.get(await hashToken(code)), 1);
});

test("rejects an exhausted trial before calling DeepSeek", async () => {
  const code = "SAI_exhausted_123";
  const env = await environmentFor(code, { limit: 5, enabled: true }, 5);
  const response = await handleRequest(analyzeRequest(code), env, {}, async () => {
    throw new Error("must not call upstream");
  });
  assert.equal(response.status, 402);
  const body = await response.json();
  assert.equal(body.code, "TRIAL_EXHAUSTED");
  assert.equal(body.trial.remaining, 0);
});

test("rejects an empty subtitle", async () => {
  const code = "SAI_invalid_body_123";
  const env = await environmentFor(code);
  const response = await handleRequest(analyzeRequest(code, { sentence: "" }), env, {}, async () => {
    throw new Error("must not call upstream");
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_REQUEST");
});

test("refunds the reserved use when DeepSeek fails", async () => {
  const code = "SAI_upstream_error_123";
  const env = await environmentFor(code);
  const response = await handleRequest(analyzeRequest(code), env, {}, async () => (
    new Response("failed", { status: 500 })
  ));
  assert.equal(response.status, 502);
  assert.equal(env.TRIAL_LIMITER.usedById.get(await hashToken(code)), 0);
});

test("concurrent reservations cannot exceed five successful calls", async () => {
  const code = "SAI_concurrent_test_123";
  const env = await environmentFor(code);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    handleRequest(analyzeRequest(code, {}, `203.0.113.${index + 1}`), env, {}, async () => successfulUpstream())
  )));

  assert.equal(responses.filter((response) => response.status === 200).length, 5);
  assert.equal(responses.filter((response) => response.status === 402).length, 3);
});

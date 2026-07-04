const DEFAULT_TRIAL_LIMIT = 5;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 6;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_API_URL = "https://api.deepseek.com/chat/completions";

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, fetch);
  }
};

export class TrialLimiter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return quotaResponse({ ok: false }, 405);
    }

    const url = new URL(request.url);
    const used = Math.max(0, Number(await this.storage.get("used")) || 0);

    if (url.pathname === "/refund") {
      const nextUsed = Math.max(0, used - 1);
      await this.storage.put("used", nextUsed);
      return quotaResponse({ ok: true, used: nextUsed });
    }

    if (url.pathname !== "/reserve") {
      return quotaResponse({ ok: false }, 404);
    }

    const limit = positiveInteger(url.searchParams.get("limit"), DEFAULT_TRIAL_LIMIT);
    if (used >= limit) {
      return quotaResponse({ ok: false, used, remaining: 0, limit }, 402);
    }

    const nextUsed = used + 1;
    await this.storage.put("used", nextUsed);
    return quotaResponse({
      ok: true,
      used: nextUsed,
      remaining: Math.max(0, limit - nextUsed),
      limit
    });
  }
}

export async function handleRequest(request, env, _ctx, fetchImpl = fetch) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders() });
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (request.method !== "POST" || url.pathname !== "/v1/analyze") {
    return errorResponse(404, "NOT_FOUND", "接口不存在。");
  }

  if (!env.DEEPSEEK_API_KEY || !env.TRIALS || !env.TRIAL_LIMITER) {
    return errorResponse(503, "SERVICE_NOT_CONFIGURED", "体验服务尚未配置完成。");
  }

  const trialCode = String(request.headers.get("X-Trial-Code") || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(trialCode)) {
    return errorResponse(401, "INVALID_TRIAL_CODE", "请输入有效的邀请码。");
  }

  const codeHash = await hashToken(trialCode);
  const inviteKey = `invite:${codeHash}`;
  const invite = await readJson(env.TRIALS, inviteKey);
  if (!invite || invite.enabled === false) {
    return errorResponse(401, "INVALID_TRIAL_CODE", "邀请码无效或已停用。");
  }

  const maximumLimit = positiveInteger(env.TRIAL_LIMIT, DEFAULT_TRIAL_LIMIT);
  const inviteLimit = positiveInteger(invite.limit, maximumLimit);
  const limit = Math.min(inviteLimit, maximumLimit);
  let payload;
  try {
    payload = validatePayload(await request.json());
  } catch (error) {
    return errorResponse(400, "INVALID_REQUEST", error && error.message ? error.message : "请求内容无效。");
  }

  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await hashToken(clientIp);
  const minuteKey = Math.floor(Date.now() / 60000);
  const rateAllowed = await consumeCounter(
    env.TRIALS,
    `rate:${ipHash}:${minuteKey}`,
    positiveInteger(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE),
    120
  );
  if (!rateAllowed) {
    return errorResponse(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。");
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  const globalAllowed = await consumeCounter(
    env.TRIALS,
    `global:${dateKey}`,
    positiveInteger(env.GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT),
    172800
  );
  if (!globalAllowed) {
    return errorResponse(503, "DAILY_LIMIT_REACHED", "今日体验服务额度已用完，请明天再试或使用自己的 API Key。");
  }

  let reservation;
  try {
    reservation = await reserveTrialUse(env.TRIAL_LIMITER, codeHash, limit);
  } catch (error) {
    console.error("[Subtitle AI Helper] quota service failed:", error);
    return errorResponse(503, "QUOTA_SERVICE_UNAVAILABLE", "体验次数服务暂时不可用，请稍后重试。");
  }
  if (!reservation.ok) {
    return errorResponse(402, "TRIAL_EXHAUSTED", "免费体验次数已用完，请切换为自己的 API Key。", {
      trial: { remaining: 0, limit }
    });
  }

  let upstream;
  try {
    upstream = await fetchWithTimeout(fetchImpl, env.DEEPSEEK_API_URL || DEFAULT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || DEFAULT_MODEL,
        temperature: 0.2,
        max_tokens: 900,
        user_id: `trial_${codeHash.slice(0, 24)}`,
        messages: buildMessages(payload)
      })
    }, positiveInteger(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
  } catch (_error) {
    await refundTrialUse(env.TRIAL_LIMITER, codeHash);
    return errorResponse(504, "UPSTREAM_TIMEOUT", "AI 服务连接超时，请稍后重试。");
  }

  if (!upstream.ok) {
    await refundTrialUse(env.TRIAL_LIMITER, codeHash);
    return errorResponse(502, "UPSTREAM_ERROR", `AI 服务暂时不可用（HTTP ${upstream.status}）。`);
  }

  let data;
  try {
    data = await upstream.json();
  } catch (_error) {
    await refundTrialUse(env.TRIAL_LIMITER, codeHash);
    return errorResponse(502, "INVALID_UPSTREAM_RESPONSE", "AI 服务返回了无法识别的内容。");
  }

  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || "").trim()
    : "";
  if (!text) {
    await refundTrialUse(env.TRIAL_LIMITER, codeHash);
    return errorResponse(502, "EMPTY_UPSTREAM_RESPONSE", "AI 没有返回内容，请稍后重试。");
  }

  return jsonResponse({
    ok: true,
    text,
    trial: {
      remaining: reservation.remaining,
      limit
    }
  });
}

export function validatePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("请求内容必须是对象。");
  }

  return {
    sentence: requiredText(input.sentence, "字幕", 2000),
    context: optionalText(input.context, 6000) || "无",
    videoTitle: optionalText(input.videoTitle, 500) || "未知来源",
    playbackTime: optionalText(input.playbackTime, 100) || "未知时间"
  };
}

export function buildMessages(payload) {
  return [
    {
      role: "system",
      content:
        "你是一个面向中文母语者的英语视频字幕学习助手。请用简洁、准确、适合即时学习的中文解释英文字幕。只输出可以被 JSON.parse 解析的合法 JSON，不要输出 Markdown，不要在字符串内部使用未转义的双引号。"
    },
    {
      role: "user",
      content: [
        "请分析当前英文字幕，返回以下 JSON 结构：",
        "{",
        '  "zh": "自然中文意思",',
        '  "tone": "语气、态度、隐含意思",',
        '  "keywords": [{"word": "重点单词", "meaning": "中文意思", "note": "语境提示"}],',
        '  "phrases": [{"phrase": "短语或搭配", "usage": "用法说明", "example": "英文例句 + 中文，不要给英文例句套双引号"}],',
        '  "examples": [{"en": "贴近当前语境的新例句", "zh": "中文"}]',
        "}",
        "重要：返回值必须是严格 JSON。英文例句直接写句子本身，不要加引号；如果必须出现双引号，请写成 \\\"。",
        "",
        `来源标题：${payload.videoTitle}`,
        `时间位置：${payload.playbackTime}`,
        "",
        "当前句子：",
        payload.sentence,
        "",
        "前后字幕上下文：",
        payload.context
      ].join("\n")
    }
  ];
}

export async function hashToken(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(kv, key) {
  try {
    return await kv.get(key, "json");
  } catch (_error) {
    return null;
  }
}

async function consumeCounter(kv, key, limit, expirationTtl) {
  const current = Math.max(0, Number(await kv.get(key)) || 0);
  if (current >= limit) {
    return false;
  }

  await kv.put(key, String(current + 1), { expirationTtl });
  return true;
}

async function reserveTrialUse(namespace, codeHash, limit) {
  const id = namespace.idFromName(codeHash);
  const stub = namespace.get(id);
  const response = await stub.fetch(`https://quota.internal/reserve?limit=${limit}`, { method: "POST" });
  return response.json();
}

async function refundTrialUse(namespace, codeHash) {
  try {
    const id = namespace.idFromName(codeHash);
    const stub = namespace.get(id);
    await stub.fetch("https://quota.internal/refund", { method: "POST" });
  } catch (error) {
    console.error("[Subtitle AI Helper] quota refund failed:", error);
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${label}不能为空。`);
  }
  if (text.length > maxLength) {
    throw new Error(`${label}过长，最多允许 ${maxLength} 个字符。`);
  }
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value || "").trim();
  return text.slice(0, maxLength);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorResponse(status, code, message, extra = {}) {
  return jsonResponse({ ok: false, code, error: message, ...extra }, status);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders()
  });
}

function responseHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Trial-Code",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  };
}

function quotaResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

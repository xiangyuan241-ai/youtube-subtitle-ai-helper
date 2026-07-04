importScripts("config.js", "../shared/review-scheduler.js", "../shared/learning-storage.js", "reminder.js");

const DEFAULT_SYNC_SETTINGS = {
  apiBaseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash"
};
const DEFAULT_LOCAL_SETTINGS = {
  usageMode: "trial",
  trialCode: ""
};
const AI_REQUEST_TIMEOUT_MS = 30000;
const TRIAL_API_URL = globalThis.SaiConfig && globalThis.SaiConfig.trialApiUrl
  ? globalThis.SaiConfig.trialApiUrl
  : "";
const legacyMigrationPromise = migrateLegacyApiKey();

chrome.action.onClicked.addListener((tab) => {
  injectHelper(tab).catch((error) => {
    console.error("[Subtitle AI Helper] inject failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "INJECT_HELPER") {
    injectHelper({
      id: message.payload && message.payload.tabId,
      url: message.payload && message.payload.url
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === "ANALYZE_CAPTION") {
    analyzeCaption(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      });
    return true;
  }

  return false;
});

async function injectHelper(tab) {
  if (!tab || !tab.id || !canInjectIntoUrl(tab.url || "")) {
    throw new Error("当前页面不支持注入助手。请在普通 http/https 英文网页或 YouTube 页面使用。");
  }

  if (!/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url || "")) {
    console.debug("[Subtitle AI Helper] injecting selected-text helper on:", tab.url);
  }

  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ["content/content.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["shared/review-scheduler.js", "shared/learning-storage.js", "content/content.js"]
  });
}

function canInjectIntoUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

async function analyzeCaption(payload) {
  if (!payload || !payload.sentence || !payload.sentence.trim()) {
    throw new Error("没有检测到当前字幕。");
  }

  await legacyMigrationPromise;
  const [syncSettings, localSettings, sessionSettings] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS),
    chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS),
    chrome.storage.session.get({ apiKey: "" })
  ]);

  if (localSettings.usageMode === "own") {
    return analyzeWithOwnKey(payload, syncSettings, sessionSettings.apiKey);
  }

  return analyzeWithTrial(payload, localSettings.trialCode);
}

async function analyzeWithOwnKey(payload, settings, storedApiKey) {
  const apiKey = String(storedApiKey || "").trim();
  const apiBaseUrl = normalizeBaseUrl(settings.apiBaseUrl || DEFAULT_SYNC_SETTINGS.apiBaseUrl);
  const model = String(settings.model || DEFAULT_SYNC_SETTINGS.model).trim();

  if (!apiKey) {
    throw new Error("当前使用自己的 API Key，请在设置页重新填写。Key 只保留到浏览器关闭。");
  }

  const response = await fetchWithTimeout(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 900,
      messages: buildMessages(payload)
    })
  }, AI_REQUEST_TIMEOUT_MS);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI 请求失败：HTTP ${response.status} ${body.slice(0, 220)}`);
  }

  const data = await response.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ""
    : "";

  return parseAiResult(text);
}

async function analyzeWithTrial(payload, storedTrialCode) {
  const trialCode = String(storedTrialCode || "").trim();
  if (!trialCode) {
    throw new Error("请先在扩展设置页填写体验邀请码。");
  }

  if (!TRIAL_API_URL || /replace-me/i.test(TRIAL_API_URL)) {
    throw new Error("体验服务尚未部署，请先配置 Cloudflare Worker 地址。");
  }

  const response = await fetchWithTimeout(TRIAL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Trial-Code": trialCode
    },
    body: JSON.stringify({
      sentence: payload.sentence,
      context: payload.context || payload.sentence,
      videoTitle: payload.videoTitle || "未知来源",
      playbackTime: payload.playbackTime || "未知时间"
    })
  }, AI_REQUEST_TIMEOUT_MS);

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error(`体验服务返回异常：HTTP ${response.status}`);
  }

  if (!response.ok || !data || data.ok === false) {
    throw new Error(data && data.error ? data.error : `体验服务请求失败：HTTP ${response.status}`);
  }

  return parseAiResult(data.text, { trial: data.trial });
}

function parseAiResult(text, extra = {}) {
  const normalized = String(text || "").trim();

  if (!normalized) {
    throw new Error("AI 没有返回内容。");
  }

  const parsed = parseJsonObject(normalized);
  return parsed ? { analysis: parsed, ...extra } : { rawText: normalized, ...extra };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("AI 请求超过 30 秒未返回。请检查网络、API Base URL、模型名称或稍后重试。");
    }

    throw new Error(`AI 请求无法连接：${error && error.message ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeBaseUrl(url) {
  return String(url || DEFAULT_SYNC_SETTINGS.apiBaseUrl).trim().replace(/\/+$/, "");
}

async function migrateLegacyApiKey() {
  try {
    const legacy = await chrome.storage.sync.get({ apiKey: "" });
    const apiKey = String(legacy.apiKey || "").trim();
    if (!apiKey) {
      return;
    }

    await Promise.all([
      chrome.storage.session.set({ apiKey }),
      chrome.storage.local.set({ usageMode: "own" }),
      chrome.storage.sync.remove("apiKey")
    ]);
  } catch (error) {
    console.error("[Subtitle AI Helper] legacy API key migration failed:", error);
  }
}

function buildMessages(payload) {
  const context = payload.context || "无";
  const sourceTitle = payload.videoTitle || "未知来源";
  const playbackTime = payload.playbackTime || "未知时间";

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
        `来源标题：${sourceTitle}`,
        `时间位置：${playbackTime}`,
        "",
        "当前句子：",
        payload.sentence,
        "",
        "前后字幕上下文：",
        context
      ].join("\n")
    }
  ];
}

function parseJsonObject(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (_error) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_innerError) {
      return null;
    }
  }
}

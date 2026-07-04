const DEFAULT_SYNC_SETTINGS = {
  apiBaseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash"
};
const DEFAULT_LOCAL_SETTINGS = {
  usageMode: "trial",
  trialCode: ""
};

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const trialPanel = document.getElementById("trial-panel");
const ownPanel = document.getElementById("own-panel");
const trialCodeEl = document.getElementById("trialCode");
const apiBaseUrlEl = document.getElementById("apiBaseUrl");
const modelEl = document.getElementById("model");
const apiKeyEl = document.getElementById("apiKey");
const clearKeyButton = document.getElementById("clear-key");

initialize();

document.querySelectorAll('input[name="usageMode"]').forEach((radio) => {
  radio.addEventListener("change", updateModePanels);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const usageMode = getSelectedMode();
  const trialCode = trialCodeEl.value.trim();
  const apiBaseUrl = apiBaseUrlEl.value.trim() || DEFAULT_SYNC_SETTINGS.apiBaseUrl;
  const model = modelEl.value.trim() || DEFAULT_SYNC_SETTINGS.model;
  const apiKey = apiKeyEl.value.trim();

  if (usageMode === "trial" && !trialCode) {
    setStatus("请填写体验邀请码。", true);
    trialCodeEl.focus();
    return;
  }

  if (usageMode === "own" && !apiKey) {
    setStatus("请填写自己的 API Key。关闭浏览器后需要重新填写。", true);
    apiKeyEl.focus();
    return;
  }

  try {
    await Promise.all([
      chrome.storage.local.set({ usageMode, trialCode }),
      chrome.storage.sync.set({ apiBaseUrl, model }),
      chrome.storage.sync.remove("apiKey"),
      usageMode === "own"
        ? chrome.storage.session.set({ apiKey })
        : Promise.resolve()
    ]);

    setStatus(usageMode === "trial"
      ? "邀请码已保存。回到视频页面即可开始免费体验。"
      : "API 设置已保存。Key 将在关闭浏览器后自动清除。");
  } catch (error) {
    setStatus(error && error.message ? error.message : "设置保存失败。", true);
  }
});

clearKeyButton.addEventListener("click", async () => {
  apiKeyEl.value = "";
  await chrome.storage.session.remove("apiKey");
  setStatus("当前会话中的 API Key 已清除。");
});

async function initialize() {
  try {
    await migrateLegacyApiKey();
    const [syncSettings, localSettings, sessionSettings] = await Promise.all([
      chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS),
      chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS),
      chrome.storage.session.get({ apiKey: "" })
    ]);

    const selectedMode = localSettings.usageMode === "own" ? "own" : "trial";
    const radio = document.querySelector(`input[name="usageMode"][value="${selectedMode}"]`);
    if (radio) {
      radio.checked = true;
    }

    trialCodeEl.value = localSettings.trialCode || "";
    apiBaseUrlEl.value = syncSettings.apiBaseUrl || DEFAULT_SYNC_SETTINGS.apiBaseUrl;
    modelEl.value = syncSettings.model || DEFAULT_SYNC_SETTINGS.model;
    apiKeyEl.value = sessionSettings.apiKey || "";
    updateModePanels();
  } catch (error) {
    setStatus(error && error.message ? error.message : "无法读取设置。", true);
  }
}

async function migrateLegacyApiKey() {
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
}

function getSelectedMode() {
  const selected = document.querySelector('input[name="usageMode"]:checked');
  return selected && selected.value === "own" ? "own" : "trial";
}

function updateModePanels() {
  const ownMode = getSelectedMode() === "own";
  trialPanel.hidden = ownMode;
  ownPanel.hidden = !ownMode;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", Boolean(isError));
  window.clearTimeout(setStatus.timer);
  setStatus.timer = window.setTimeout(() => {
    statusEl.textContent = "";
    statusEl.classList.remove("is-error");
  }, 5000);
}

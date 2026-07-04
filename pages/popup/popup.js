const todayCountEl = document.getElementById("today-count");
const dueCountEl = document.getElementById("due-count");
const statusEl = document.getElementById("status");

document.getElementById("open-list").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("pages/learning/list.html") });
});

document.getElementById("open-review").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("pages/learning/review.html") });
});

document.getElementById("enable-helper").addEventListener("click", enableHelperOnCurrentTab);

loadSummary();

async function loadSummary() {
  try {
    const [todayItems, dueItems] = await Promise.all([
      globalThis.SaiLearningStorage.getTodayItems(),
      globalThis.SaiLearningStorage.getDueReviewItems()
    ]);
    todayCountEl.textContent = String(todayItems.length);
    dueCountEl.textContent = String(dueItems.length);
  } catch (error) {
    setStatus(error && error.message ? error.message : "无法读取学习记录。");
  }
}

async function enableHelperOnCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("没有找到当前标签页。");
    return;
  }

  chrome.runtime.sendMessage({
    type: "INJECT_HELPER",
    payload: {
      tabId: tab.id,
      url: tab.url || ""
    }
  }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      setStatus(formatRuntimeMessageError(error.message));
      return;
    }

    setStatus(response && response.ok ? "已在当前页启用助手。" : (response && response.error) || "启用失败。");
  });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatRuntimeMessageError(message) {
  const text = String(message || "");
  if (/Extension context invalidated/i.test(text)) {
    return "扩展刚刚被重新加载，请刷新当前页面后再试。";
  }

  if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(text)) {
    return "扩展后台暂时没有响应，请重新加载扩展后再试。";
  }

  return text || "扩展消息发送失败。";
}

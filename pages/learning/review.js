const storage = globalThis.SaiLearningStorage;
const scheduler = globalThis.SaiReviewScheduler;
const rootEl = document.getElementById("review-root");
const statusEl = document.getElementById("status");

const state = {
  items: [],
  index: 0,
  answerVisible: false
};

document.getElementById("open-list").addEventListener("click", () => {
  location.href = "list.html";
});

loadReviewItems();

async function loadReviewItems() {
  try {
    const params = new URLSearchParams(location.search);
    const itemId = params.get("id");
    if (itemId) {
      const item = await storage.getLearningItemById(itemId);
      state.items = item && item.status !== "mastered" ? [item] : [];
    } else {
      state.items = await storage.getDueReviewItems();
    }

    state.index = 0;
    state.answerVisible = false;
    renderReview();
  } catch (error) {
    renderEmpty(error && error.message ? error.message : "无法读取复习内容。");
  }
}

function renderReview() {
  if (!state.items.length || state.index >= state.items.length) {
    renderEmpty("今日复习完成。");
    return;
  }

  const item = state.items[state.index];
  const card = document.createElement("article");
  card.className = "review-card";
  card.innerHTML = [
    `<p class="muted">${state.index + 1} / ${state.items.length}</p>`,
    '<div class="meta">',
    `  <span class="badge">${typeLabel(item.type)}</span>`,
    `  <span class="badge neutral">${escapeHtml(item.sourceTitle || item.sourceSite || "未知来源")}</span>`,
    "</div>",
    `<p class="content">${escapeHtml(item.content)}</p>`
  ].join("");

  if (state.answerVisible) {
    const answer = document.createElement("section");
    answer.className = "review-answer";
    answer.innerHTML = [
      detailBlock("中文解释", item.translation || "暂无"),
      detailBlock("重点单词", (item.wordList || []).join(", ") || "暂无"),
      detailBlock("单词解释", formatWordExplanations(item.wordExplanations)),
      detailBlock("用法说明", item.usage || "暂无"),
      detailBlock("语法说明", item.grammar || "暂无"),
      detailBlock("例句", item.example || "暂无"),
      detailBlock("备注", item.note || "暂无")
    ].join("");
    card.appendChild(answer);
  }

  const actions = document.createElement("div");
  actions.className = "review-actions";
  if (!state.answerVisible) {
    actions.appendChild(actionButton("显示答案", "primary", () => {
      state.answerVisible = true;
      renderReview();
    }));
  } else {
    actions.appendChild(actionButton("记住了", "primary", () => submitResult("remembered")));
    actions.appendChild(actionButton("模糊", "", () => submitResult("vague")));
    actions.appendChild(actionButton("没记住", "danger", () => submitResult("forgotten")));
  }
  card.appendChild(actions);

  rootEl.replaceChildren(card);
}

async function submitResult(result) {
  const item = state.items[state.index];
  if (!item) {
    return;
  }

  try {
    const updates = scheduler.applyReviewResult(item, result);
    await storage.updateLearningItem(item.id, updates);
    state.index += 1;
    state.answerVisible = false;
    setStatus("已更新复习计划。");
    renderReview();
  } catch (error) {
    setStatus(error && error.message ? error.message : "复习更新失败。");
  }
}

function actionButton(text, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  if (className) {
    button.className = className;
  }
  button.addEventListener("click", onClick);
  return button;
}

function detailBlock(title, body) {
  return [
    '<section class="detail-block">',
    `  <h3>${escapeHtml(title)}</h3>`,
    `  <p>${escapeHtml(body)}</p>`,
    "</section>"
  ].join("");
}

function formatWordExplanations(value) {
  if (!value || typeof value !== "object") {
    return "暂无";
  }

  const lines = Object.entries(value).map(([word, data]) => {
    if (!data || typeof data !== "object") {
      return `${word}: ${data}`;
    }
    return `${word}: ${[data.meaning, data.note].filter(Boolean).join("；")}`;
  });
  return lines.join("\n") || "暂无";
}

function renderEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  rootEl.replaceChildren(empty);
}

function typeLabel(type) {
  return {
    word: "单词",
    phrase: "短语",
    sentence: "句子"
  }[type] || "内容";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

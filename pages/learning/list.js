const storage = globalThis.SaiLearningStorage;
const scheduler = globalThis.SaiReviewScheduler;

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const typeFilterEl = document.getElementById("type-filter");
const todayCountEl = document.getElementById("today-count");
const allCountEl = document.getElementById("all-count");
const dueCountEl = document.getElementById("due-count");

const state = {
  view: "today",
  allItems: [],
  todayItems: [],
  dueItems: []
};

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view || "today";
    document.querySelectorAll(".tab").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    renderList();
  });
});

typeFilterEl.addEventListener("change", renderList);

document.getElementById("open-review").addEventListener("click", () => {
  location.href = "review.html";
});

document.getElementById("clear-all").addEventListener("click", async () => {
  if (!confirm("确定清空全部学习记录吗？这个操作不会影响 API 设置，但无法撤销。")) {
    return;
  }

  await storage.clearAllLearningItems();
  setStatus("已清空全部学习记录。");
  await loadItems();
});

loadItems();

async function loadItems() {
  try {
    const [allItems, todayItems, dueItems] = await Promise.all([
      storage.getLearningItems(),
      storage.getTodayItems(),
      storage.getDueReviewItems()
    ]);

    state.allItems = allItems;
    state.todayItems = todayItems;
    state.dueItems = dueItems;

    todayCountEl.textContent = String(todayItems.length);
    allCountEl.textContent = String(allItems.length);
    dueCountEl.textContent = String(dueItems.length);
    renderList();
  } catch (error) {
    renderEmpty(error && error.message ? error.message : "无法读取学习记录。");
  }
}

function renderList() {
  const type = typeFilterEl.value;
  const source = getCurrentSource();
  const items = source.filter((item) => type === "all" || item.type === type);

  if (!items.length) {
    renderEmpty("当前筛选下没有学习记录。");
    return;
  }

  listEl.replaceChildren(...items.map(createItemCard));
}

function getCurrentSource() {
  if (state.view === "all") {
    return state.allItems;
  }
  if (state.view === "due") {
    return state.dueItems;
  }
  return state.todayItems;
}

function createItemCard(item) {
  const card = document.createElement("article");
  card.className = "learning-card";

  const main = document.createElement("div");
  main.className = "card-main";
  main.innerHTML = [
    '<div class="meta">',
    `  <span class="badge">${typeLabel(item.type)}</span>`,
    `  <span class="badge neutral">${statusLabel(item.status)}</span>`,
    `  <span class="badge neutral">下次 ${escapeHtml(item.nextReviewDate || "未设置")}</span>`,
    "</div>",
    `<p class="content">${escapeHtml(item.content)}</p>`,
    `<p class="translation">${escapeHtml(item.translation || "暂无中文解释")}</p>`,
    `<p class="muted">${escapeHtml(item.sourceTitle || item.sourceSite || "未知来源")} · 收藏于 ${escapeHtml(item.createdDate || "")}</p>`
  ].join("");
  card.appendChild(main);

  const details = document.createElement("details");
  details.className = "card-details";
  details.innerHTML = [
    "<summary>查看详情</summary>",
    '<div class="detail-grid">',
    detailBlock("重点单词", (item.wordList || []).join(", ") || "暂无"),
    detailBlock("单词解释", formatWordExplanations(item.wordExplanations)),
    detailBlock("用法说明", item.usage || "暂无"),
    detailBlock("语法说明", item.grammar || "暂无"),
    detailBlock("例句", item.example || "暂无"),
    detailBlock("来源", [item.sourceSite, formatVideoTime(item.videoTime), item.sourceUrl].filter(Boolean).join("\n") || "暂无"),
    "</div>"
  ].join("");
  card.appendChild(details);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(actionButton("立即复习", "primary", async () => {
    await storage.updateLearningItem(item.id, {
      nextReviewDate: scheduler.toDateKey(),
      status: item.status === "mastered" ? "learning" : item.status
    });
    location.href = `review.html?id=${encodeURIComponent(item.id)}`;
  }));
  actions.appendChild(actionButton("标记已掌握", "", async () => {
    await storage.updateLearningItem(item.id, { status: "mastered" });
    setStatus("已标记为掌握。");
    await loadItems();
  }));
  actions.appendChild(actionButton("删除", "danger", async () => {
    if (!confirm("删除这条学习记录？")) {
      return;
    }
    await storage.deleteLearningItem(item.id);
    setStatus("已删除。");
    await loadItems();
  }));
  card.appendChild(actions);

  return card;
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

function formatVideoTime(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }

  const total = Math.max(0, Number(value));
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `视频时间 ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderEmpty(text) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  listEl.replaceChildren(empty);
}

function typeLabel(type) {
  return {
    word: "单词",
    phrase: "短语",
    sentence: "句子"
  }[type] || "内容";
}

function statusLabel(status) {
  return {
    new: "新内容",
    learning: "学习中",
    mastered: "已掌握"
  }[status] || status || "新内容";
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

(function () {
  const STORAGE_KEY = "learningItems";
  const VALID_TYPES = new Set(["word", "phrase", "sentence"]);

  function getReviewScheduler() {
    return globalThis.SaiReviewScheduler || {
      toDateKey: fallbackDateKey
    };
  }

  function fallbackDateKey(date = new Date()) {
    const local = new Date(date);
    return [
      local.getFullYear(),
      String(local.getMonth() + 1).padStart(2, "0"),
      String(local.getDate()).padStart(2, "0")
    ].join("-");
  }

  function getStorageArea() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      throw new Error("chrome.storage.local 不可用。请在 Chrome 扩展环境中使用。");
    }

    return chrome.storage.local;
  }

  async function readItems() {
    const area = getStorageArea();
    const result = await area.get({ [STORAGE_KEY]: [] });
    const items = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    return items.filter((item) => item && typeof item === "object");
  }

  async function writeItems(items) {
    const area = getStorageArea();
    await area.set({ [STORAGE_KEY]: Array.isArray(items) ? items : [] });
  }

  function normalizeContent(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeType(type, content) {
    if (VALID_TYPES.has(type)) {
      return type;
    }

    const words = normalizeContent(content).match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g) || [];
    if (words.length <= 1) {
      return "word";
    }
    if (words.length <= 5) {
      return "phrase";
    }
    return "sentence";
  }

  function createId() {
    const random = Math.random().toString(36).slice(2, 10);
    return `li_${Date.now().toString(36)}_${random}`;
  }

  function normalizeLearningItem(input) {
    const now = new Date();
    const scheduler = getReviewScheduler();
    const createdDate = scheduler.toDateKey(now);
    const content = normalizeContent(input && input.content);

    if (!content) {
      throw new Error("收藏内容不能为空。");
    }

    return {
      id: createId(),
      type: normalizeType(input.type, content),
      content,
      translation: String(input.translation || "").trim(),
      wordList: Array.isArray(input.wordList) ? input.wordList.map(String).filter(Boolean) : [],
      wordExplanations: input.wordExplanations && typeof input.wordExplanations === "object"
        ? input.wordExplanations
        : {},
      usage: String(input.usage || "").trim(),
      grammar: String(input.grammar || "").trim(),
      example: String(input.example || "").trim(),
      sourceSite: String(input.sourceSite || "").trim(),
      sourceTitle: String(input.sourceTitle || "").trim(),
      sourceUrl: String(input.sourceUrl || "").trim(),
      videoTime: input.videoTime == null ? null : input.videoTime,
      note: String(input.note || "").trim(),
      createdDate,
      createdAt: now.toISOString(),
      lastReviewedAt: null,
      nextReviewDate: input.nextReviewDate || createdDate,
      reviewCount: 0,
      status: "new"
    };
  }

  async function addLearningItem(item) {
    const items = await readItems();
    const normalized = normalizeLearningItem(item || {});
    const duplicate = items.find((existing) => (
      normalizeContent(existing.content) === normalized.content &&
      String(existing.sourceUrl || "") === normalized.sourceUrl
    ));

    if (duplicate) {
      return {
        ok: true,
        added: false,
        duplicate: true,
        item: duplicate
      };
    }

    const nextItems = [normalized, ...items];
    await writeItems(nextItems);
    return {
      ok: true,
      added: true,
      duplicate: false,
      item: normalized
    };
  }

  async function getLearningItems() {
    return readItems();
  }

  async function getLearningItemById(id) {
    const items = await readItems();
    return items.find((item) => item.id === id) || null;
  }

  async function getTodayItems() {
    const today = getReviewScheduler().toDateKey();
    const items = await readItems();
    return items.filter((item) => item.createdDate === today);
  }

  async function getDueReviewItems() {
    const scheduler = getReviewScheduler();
    const today = scheduler.toDateKey();
    const items = await readItems();
    return items
      .filter((item) => scheduler.isDueForReview
        ? scheduler.isDueForReview(item, today)
        : item.status !== "mastered" && String(item.nextReviewDate || "") <= today)
      .sort((a, b) => String(a.nextReviewDate || "").localeCompare(String(b.nextReviewDate || "")));
  }

  async function updateLearningItem(id, updates) {
    const items = await readItems();
    let updatedItem = null;
    const nextItems = items.map((item) => {
      if (item.id !== id) {
        return item;
      }

      updatedItem = {
        ...item,
        ...(updates || {}),
        id: item.id
      };
      return updatedItem;
    });

    if (!updatedItem) {
      throw new Error("没有找到要更新的学习记录。");
    }

    await writeItems(nextItems);
    return updatedItem;
  }

  async function deleteLearningItem(id) {
    const items = await readItems();
    const nextItems = items.filter((item) => item.id !== id);
    await writeItems(nextItems);
    return {
      ok: true,
      deleted: nextItems.length !== items.length
    };
  }

  async function clearAllLearningItems() {
    await writeItems([]);
    return {
      ok: true
    };
  }

  globalThis.SaiLearningStorage = {
    STORAGE_KEY,
    addLearningItem,
    clearAllLearningItems,
    deleteLearningItem,
    getDueReviewItems,
    getLearningItemById,
    getLearningItems,
    getTodayItems,
    updateLearningItem
  };
})();

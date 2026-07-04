(function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NEXT_INTERVAL_AFTER_REVIEW = [0, 1, 4, 7, 15, 30, 30];

  function toDateKey(date = new Date()) {
    const local = new Date(date);
    const year = local.getFullYear();
    const month = String(local.getMonth() + 1).padStart(2, "0");
    const day = String(local.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(dateKeyOrDate, days) {
    const base = typeof dateKeyOrDate === "string"
      ? parseDateKey(dateKeyOrDate)
      : new Date(dateKeyOrDate || Date.now());
    return toDateKey(new Date(base.getTime() + Number(days || 0) * DAY_MS));
  }

  function parseDateKey(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return new Date();
    }

    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function calculateNextReviewDate(reviewCount, result, baseDate = new Date()) {
    const count = Math.max(0, Number(reviewCount) || 0);
    const today = toDateKey(baseDate);

    if (result === "vague" || result === "forgotten") {
      return addDays(today, 1);
    }

    if (result !== "remembered") {
      return today;
    }

    const nextCount = count + 1;
    const interval = NEXT_INTERVAL_AFTER_REVIEW[Math.min(nextCount, NEXT_INTERVAL_AFTER_REVIEW.length - 1)];
    return addDays(today, interval);
  }

  function applyReviewResult(item, result, baseDate = new Date()) {
    const currentCount = Math.max(0, Number(item && item.reviewCount) || 0);
    const remembered = result === "remembered";
    const vague = result === "vague";
    const nextCount = remembered || vague ? currentCount + 1 : currentCount;
    const mastered = remembered && nextCount >= 6;

    return {
      lastReviewedAt: new Date(baseDate).toISOString(),
      reviewCount: nextCount,
      nextReviewDate: calculateNextReviewDate(currentCount, result, baseDate),
      status: mastered ? "mastered" : "learning"
    };
  }

  function isDueForReview(item, today = toDateKey()) {
    if (!item || item.status === "mastered") {
      return false;
    }

    return String(item.nextReviewDate || "") <= today;
  }

  globalThis.SaiReviewScheduler = {
    addDays,
    applyReviewResult,
    calculateNextReviewDate,
    isDueForReview,
    toDateKey
  };
})();

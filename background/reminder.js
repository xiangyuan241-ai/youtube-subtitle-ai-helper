(function () {
  const ALARM_NAME = "saiDailyReviewReminder";
  const NOTIFICATION_ID = "sai-daily-review";
  const REMINDER_HOUR = 20;

  if (typeof chrome === "undefined" || !chrome.alarms || !chrome.notifications) {
    return;
  }

  chrome.runtime.onInstalled.addListener(scheduleDailyReviewAlarm);
  chrome.runtime.onStartup.addListener(scheduleDailyReviewAlarm);

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === ALARM_NAME) {
      checkDueReviewsAndNotify();
    }
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId !== NOTIFICATION_ID) {
      return;
    }

    chrome.tabs.create({ url: chrome.runtime.getURL("pages/learning/review.html") });
    chrome.notifications.clear(notificationId);
  });

  scheduleDailyReviewAlarm();

  function scheduleDailyReviewAlarm() {
    chrome.alarms.create(ALARM_NAME, {
      when: getNextReminderTime(),
      periodInMinutes: 24 * 60
    });
  }

  function getNextReminderTime() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(REMINDER_HOUR, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  async function checkDueReviewsAndNotify() {
    try {
      const storage = globalThis.SaiLearningStorage;
      if (!storage || typeof storage.getDueReviewItems !== "function") {
        return;
      }

      const dueItems = await storage.getDueReviewItems();
      if (!dueItems.length) {
        return;
      }

      chrome.notifications.create(NOTIFICATION_ID, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("assets/icon.svg"),
        title: "英语学习复习提醒",
        message: `你今天有 ${dueItems.length} 条英语学习内容需要复习。`,
        priority: 1
      });
    } catch (error) {
      console.error("[Subtitle AI Helper] review reminder failed:", error);
    }
  }

  globalThis.SaiReminder = {
    checkDueReviewsAndNotify,
    scheduleDailyReviewAlarm
  };
})();

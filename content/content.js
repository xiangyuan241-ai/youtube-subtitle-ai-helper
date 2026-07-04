(function () {
  const ROOT_ID = "sai-helper-root";
  const URL_CHECK_MS = 1000;
  const REPLAY_END_PADDING = 0.35;
  const POSITION_STORAGE_KEY = "saiHelperPosition";
  const BUTTON_SIZE = 56;
  const VIEWPORT_MARGIN = 10;
  const DRAG_THRESHOLD = 4;
  const SENTENCE_MAX_WORDS = 34;
  const SENTENCE_MAX_DURATION = 18;
  const SENTENCE_GAP_LIMIT = 1.4;

  const state = {
    videoId: null,
    transcript: null,
    transcriptPromise: null,
    selectedCue: null,
    replayStopAt: null,
    lastUrl: location.href,
    elements: {},
    drag: null,
    suppressNextClick: false,
    wordSearchTimer: null,
    wordSearchRequestId: 0,
    currentAnalysis: null,
    lastSelectedText: ""
  };

  init();

  function init() {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    mountUi();
    bindVideoReplayGuard();
    bindSelectionCapture();
    window.addEventListener("resize", constrainFloatingPosition);
    setInterval(handleUrlChange, URL_CHECK_MS);
  }

  function mountUi() {
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = [
      '<button class="sai-trigger" type="button" aria-label="分析当前字幕">译</button>',
      '<section class="sai-panel" hidden aria-live="polite">',
      '  <header class="sai-header">',
      '    <div>',
      '      <strong>英语学习</strong>',
      '      <span class="sai-status">YouTube</span>',
      "    </div>",
      '    <button class="sai-icon-button sai-close" type="button" aria-label="关闭">x</button>',
      "  </header>",
      '  <form class="sai-word-search" autocomplete="off">',
      '    <label class="sai-word-label" for="sai-word-input">听到或看到的单词</label>',
      '    <div class="sai-word-row">',
      '      <input class="sai-word-input" id="sai-word-input" type="search" inputmode="search" spellcheck="false" placeholder="输入一个词，例如 actually">',
      '      <button class="sai-word-submit" type="submit">查找</button>',
      "    </div>",
      '    <div class="sai-word-hint" aria-live="polite"></div>',
      "  </form>",
      '  <div class="sai-sentence"></div>',
      '  <div class="sai-result"></div>',
      '  <footer class="sai-actions">',
      '    <button class="sai-action sai-read" type="button">朗读</button>',
      '    <button class="sai-action sai-replay" type="button">重播片段</button>',
      '    <button class="sai-action sai-settings" type="button">设置</button>',
      "  </footer>",
      "</section>"
    ].join("");

    (document.body || document.documentElement).appendChild(root);

    state.elements = {
      root,
      trigger: root.querySelector(".sai-trigger"),
      panel: root.querySelector(".sai-panel"),
      close: root.querySelector(".sai-close"),
      wordForm: root.querySelector(".sai-word-search"),
      wordInput: root.querySelector(".sai-word-input"),
      wordHint: root.querySelector(".sai-word-hint"),
      sentence: root.querySelector(".sai-sentence"),
      result: root.querySelector(".sai-result"),
      read: root.querySelector(".sai-read"),
      replay: root.querySelector(".sai-replay"),
      settings: root.querySelector(".sai-settings"),
      status: root.querySelector(".sai-status")
    };

    restoreFloatingPosition();
    bindTriggerDrag();
    bindWordSearch();
    updateModeStatus();

    state.elements.trigger.addEventListener("click", (event) => {
      if (state.suppressNextClick) {
        event.preventDefault();
        state.suppressNextClick = false;
        return;
      }

      handleAnalyzeClick();
    });
    state.elements.close.addEventListener("click", () => {
      state.elements.panel.hidden = true;
    });
    state.elements.read.addEventListener("click", readCurrentSentence);
    state.elements.replay.addEventListener("click", replayCurrentClip);
    state.elements.settings.addEventListener("click", () => {
      sendRuntimeMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
    });
  }

  function bindWordSearch() {
    const form = state.elements.wordForm;
    const input = state.elements.wordInput;
    if (!form || !input) {
      return;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      window.clearTimeout(state.wordSearchTimer);
      handleWordSearch(input.value);
    });

    input.addEventListener("input", () => {
      window.clearTimeout(state.wordSearchTimer);
      state.wordSearchRequestId += 1;

      const query = normalizeSearchQuery(input.value);
      if (!query) {
        clearSearchHint();
        return;
      }

      if (query.length < 2 && !/^[ai]$/i.test(query)) {
        renderSearchHint("继续输入完整单词。");
        return;
      }

      state.wordSearchTimer = window.setTimeout(() => {
        handleWordSearch(input.value);
      }, 420);
    });
  }

  function bindSelectionCapture() {
    document.addEventListener("selectionchange", () => {
      const text = readCurrentSelectionText();
      if (text) {
        state.lastSelectedText = text;
      }
    });

    const initialSelection = readCurrentSelectionText();
    if (initialSelection) {
      state.lastSelectedText = initialSelection;
    }
  }

  function bindTriggerDrag() {
    const trigger = state.elements.trigger;
    if (!trigger || !window.PointerEvent) {
      return;
    }

    trigger.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      const rect = state.elements.root.getBoundingClientRect();
      state.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      trigger.setPointerCapture(event.pointerId);
    });

    trigger.addEventListener("pointermove", (event) => {
      const drag = state.drag;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
      }

      drag.moved = true;
      document.documentElement.classList.add("sai-dragging");
      event.preventDefault();
      positionRoot(drag.left + dx, drag.top + dy);
    });

    const finishDrag = (event) => {
      const drag = state.drag;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      state.drag = null;
      document.documentElement.classList.remove("sai-dragging");
      try {
        trigger.releasePointerCapture(event.pointerId);
      } catch (_error) {
        // Capture may already be released by the browser.
      }

      if (drag.moved) {
        state.suppressNextClick = true;
        window.setTimeout(() => {
          state.suppressNextClick = false;
        }, 0);
        saveFloatingPosition();
      }
    };

    trigger.addEventListener("pointerup", finishDrag);
    trigger.addEventListener("pointercancel", finishDrag);
  }

  function restoreFloatingPosition() {
    try {
      chrome.storage.local.get({ [POSITION_STORAGE_KEY]: null }, (result) => {
        const position = result && result[POSITION_STORAGE_KEY];
        if (!isValidPosition(position)) {
          updatePanelAnchor(state.elements.root.getBoundingClientRect().left);
          return;
        }

        positionRoot(position.left, position.top);
      });
    } catch (_error) {
      updatePanelAnchor(state.elements.root.getBoundingClientRect().left);
    }
  }

  function saveFloatingPosition() {
    const rect = state.elements.root.getBoundingClientRect();
    const position = {
      left: Math.round(rect.left),
      top: Math.round(rect.top)
    };

    try {
      chrome.storage.local.set({ [POSITION_STORAGE_KEY]: position });
    } catch (_error) {
      // Position memory is a convenience feature; drag still works without it.
    }
  }

  function positionRoot(left, top) {
    const clamped = clampPosition(left, top);
    const root = state.elements.root;
    root.style.left = `${clamped.left}px`;
    root.style.top = `${clamped.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    updatePanelAnchor(clamped.left);
  }

  function clampPosition(left, top) {
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - BUTTON_SIZE - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - BUTTON_SIZE - VIEWPORT_MARGIN);

    return {
      left: Math.min(Math.max(left, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop)
    };
  }

  function updatePanelAnchor(left) {
    if (!state.elements.root) {
      return;
    }

    state.elements.root.classList.toggle("sai-anchor-left", left < window.innerWidth / 2);
  }

  function isValidPosition(position) {
    return position &&
      Number.isFinite(position.left) &&
      Number.isFinite(position.top);
  }

  function constrainFloatingPosition() {
    if (!state.elements.root) {
      return;
    }

    const rect = state.elements.root.getBoundingClientRect();
    if (rect.left < VIEWPORT_MARGIN ||
        rect.top < VIEWPORT_MARGIN ||
        rect.right > window.innerWidth - VIEWPORT_MARGIN ||
        rect.bottom > window.innerHeight - VIEWPORT_MARGIN) {
      positionRoot(rect.left, rect.top);
      saveFloatingPosition();
      return;
    }

    updatePanelAnchor(rect.left);
  }

  async function handleAnalyzeClick() {
    openPanel();
    renderLoading("正在读取字幕...");

    try {
      const cue = await getCurrentCue();
      if (!cue || !cue.text) {
        renderError(getNoTextErrorMessage());
        return;
      }

      state.selectedCue = cue;
      renderSentence(cue);
      renderLoading("正在分析...最多等待 40 秒。");

      const response = await sendRuntimeMessage({
        type: "ANALYZE_CAPTION",
        payload: {
          sentence: cue.text,
          context: cue.context || cue.text,
          videoTitle: getPageTitle(),
          playbackTime: getPlaybackTimeLabel(),
          videoUrl: location.href
        }
      }, 40000);

      if (!response || !response.ok) {
        renderError(response && response.error ? response.error : "AI 分析失败。");
        return;
      }

      renderAnalysis(response.analysis, response.rawText);
      renderTrialUsage(response.trial);
    } catch (error) {
      renderError(error && error.message ? error.message : String(error));
    }
  }

  async function handleWordSearch(rawQuery) {
    const query = normalizeSearchQuery(rawQuery);
    const requestId = state.wordSearchRequestId + 1;
    state.wordSearchRequestId = requestId;

    if (!query) {
      renderSearchHint("请输入一个英文单词。", true);
      return;
    }

    openPanel();
    renderSearchHint("正在字幕中查找...");

    try {
      const match = await findSentenceByWord(query);
      if (requestId !== state.wordSearchRequestId) {
        return;
      }

      if (!match) {
        renderSearchHint(`没有找到包含 "${query}" 的字幕句子。`, true);
        return;
      }

      state.selectedCue = match.cue;
      renderSentence(match.cue);
      renderSearchHint(getSearchHintForMatch(match));
      renderSearchResult(query, match);
    } catch (error) {
      if (requestId !== state.wordSearchRequestId) {
        return;
      }

      renderSearchHint("字幕搜索失败。", true);
      renderError(`无法搜索字幕：${error && error.message ? error.message : String(error)}`);
    }
  }

  async function findSentenceByWord(query) {
    let transcript = null;
    try {
      transcript = await ensureTranscript();
    } catch (error) {
      const fallbackMatch = findVisibleSentenceByWord(query, error) || findKnownCueByWord(query, error);
      if (fallbackMatch) {
        return fallbackMatch;
      }

      throw error;
    }

    const matchedIndexes = findMatchingCueIndexes(transcript, query);
    if (!matchedIndexes.length) {
      return findVisibleSentenceByWord(query) || findKnownCueByWord(query) || null;
    }

    const index = pickNearestCueIndex(transcript, matchedIndexes, getVideoTime());
    const cue = withContext({ ...transcript[index], index }, transcript);
    return {
      cue,
      matchCount: matchedIndexes.length,
      source: "transcript"
    };
  }

  function findVisibleSentenceByWord(query, transcriptError) {
    const visibleText = readVisibleCaption();
    if (!visibleText ||
        (!cueMatchesSearch(visibleText, query, true) && !cueMatchesSearch(visibleText, query, false))) {
      return null;
    }

    const currentTime = getVideoTime();
    return {
      cue: {
        text: visibleText,
        start: currentTime,
        end: currentTime + 4,
        context: visibleText,
        source: "visible-caption"
      },
      matchCount: 1,
      source: "visible-caption",
      fallbackReason: transcriptError && transcriptError.message ? transcriptError.message : ""
    };
  }

  function findKnownCueByWord(query, transcriptError) {
    const cue = state.selectedCue;
    if (!cue || !cue.text ||
        (!cueMatchesSearch(cue.text, query, true) && !cueMatchesSearch(cue.text, query, false))) {
      return null;
    }

    return {
      cue,
      matchCount: 1,
      source: "selected-cue",
      fallbackReason: transcriptError && transcriptError.message ? transcriptError.message : ""
    };
  }

  function getSearchHintForMatch(match) {
    if (match && match.source === "visible-caption") {
      return "完整字幕不可用，已从当前屏幕字幕匹配到这句。";
    }

    if (match && match.source === "selected-cue") {
      return "完整字幕不可用，已从当前已显示句子匹配到这句。";
    }

    return `找到 ${match.matchCount} 处，已显示距离当前播放最近的一句。`;
  }

  function findMatchingCueIndexes(transcript, query) {
    const exactMatches = [];
    const partialMatches = [];

    transcript.forEach((cue, index) => {
      if (cueMatchesSearch(cue.text, query, true)) {
        exactMatches.push(index);
      } else if (cueMatchesSearch(cue.text, query, false)) {
        partialMatches.push(index);
      }
    });

    return exactMatches.length ? exactMatches : partialMatches;
  }

  function cueMatchesSearch(text, query, exactWord) {
    const normalizedQuery = normalizeSearchQuery(query);
    const normalizedText = normalizeSearchText(text);
    if (!normalizedQuery || !normalizedText) {
      return false;
    }

    if (normalizedQuery.includes(" ")) {
      return normalizedText.includes(normalizedQuery);
    }

    if (exactWord) {
      return tokenizeSearchText(text).includes(normalizedQuery);
    }

    return normalizedText.includes(normalizedQuery);
  }

  function pickNearestCueIndex(transcript, indexes, currentTime) {
    let nearestIndex = indexes[0];
    let nearestDistance = Infinity;

    indexes.forEach((index) => {
      const cue = transcript[index];
      if (!cue) {
        return;
      }

      const distance = currentTime < cue.start
        ? cue.start - currentTime
        : Math.max(0, currentTime - cue.end);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    return nearestIndex;
  }

  async function getCurrentCue() {
    const video = getVideoElement();
    const currentTime = video ? video.currentTime : 0;

    if (isYouTubePage()) {
      try {
        const transcript = await ensureTranscript();
        const cue = findCueAtTime(transcript, currentTime);
        if (cue) {
          return withContext(cue, transcript);
        }
      } catch (error) {
        console.debug("[Subtitle AI Helper] timedtext fallback:", error);
      }
    }

    const selectedText = readSelectedText();
    if (selectedText) {
      return {
        text: selectedText,
        start: video ? currentTime : null,
        end: video ? currentTime + 4 : null,
        context: selectedText,
        source: "selection"
      };
    }

    const visibleText = readVisibleCaption();
    if (visibleText) {
      return {
        text: visibleText,
        start: currentTime,
        end: currentTime + 4,
        context: visibleText,
        source: "visible-caption"
      };
    }

    return null;
  }

  async function ensureTranscript() {
    const videoId = getVideoId();
    if (!videoId) {
      throw new Error("无法识别 YouTube 视频 ID。");
    }

    if (state.videoId === videoId && state.transcript && state.transcript.length) {
      return state.transcript;
    }

    if (state.videoId === videoId && state.transcriptPromise) {
      return state.transcriptPromise;
    }

    state.videoId = videoId;
    state.transcript = null;
    state.transcriptPromise = loadTranscriptForVideo(videoId).then((transcript) => {
      state.transcript = transcript;
      state.transcriptPromise = null;
      return transcript;
    });

    return state.transcriptPromise;
  }

  async function loadTranscriptForVideo(videoId) {
    const playerResponse = await loadPlayerResponse(videoId);
    const tracks = playerResponse &&
      playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer &&
      playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
      ? playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
      : [];

    if (!tracks.length) {
      throw new Error("这个视频没有可读取的字幕轨道。");
    }

    const track = selectCaptionTrack(tracks);
    if (!track || !track.baseUrl) {
      throw new Error("没有找到可用字幕地址。");
    }

    return fetchTranscript(track.baseUrl);
  }

  async function loadPlayerResponse(videoId) {
    const fromPage = extractPlayerResponseFromText(document.documentElement.innerHTML);
    if (fromPage) {
      return fromPage;
    }

    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
      credentials: "include"
    });
    const html = await response.text();
    const fromFetch = extractPlayerResponseFromText(html);

    if (!fromFetch) {
      throw new Error("无法解析 YouTube 播放器字幕信息。");
    }

    return fromFetch;
  }

  function extractPlayerResponseFromText(text) {
    const markers = [
      "ytInitialPlayerResponse =",
      "ytInitialPlayerResponse=",
      "window.ytInitialPlayerResponse =",
      "window[\"ytInitialPlayerResponse\"] ="
    ];

    for (const marker of markers) {
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const markerIndex = text.indexOf(marker, searchFrom);
        if (markerIndex === -1) {
          break;
        }

        const jsonStart = text.indexOf("{", markerIndex + marker.length);
        const jsonText = extractBalancedJson(text, jsonStart);
        if (jsonText) {
          try {
            return JSON.parse(jsonText);
          } catch (_error) {
            searchFrom = jsonStart + 1;
          }
        } else {
          searchFrom = markerIndex + marker.length;
        }
      }
    }

    return null;
  }

  function extractBalancedJson(text, startIndex) {
    if (startIndex < 0) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }

    return null;
  }

  function selectCaptionTrack(tracks) {
    const englishTracks = tracks.filter((track) => {
      const language = String(track.languageCode || "").toLowerCase();
      const vssId = String(track.vssId || "").toLowerCase();
      return language.startsWith("en") || vssId.includes(".en");
    });

    return (
      englishTracks.find((track) => track.kind !== "asr") ||
      englishTracks[0] ||
      tracks.find((track) => track.kind !== "asr") ||
      tracks[0]
    );
  }

  async function fetchTranscript(baseUrl) {
    const jsonUrl = new URL(baseUrl, location.origin);
    jsonUrl.searchParams.set("fmt", "json3");

    const response = await fetch(jsonUrl.toString(), { credentials: "include" });
    if (response.ok) {
      try {
        const data = await response.json();
        const cues = parseJson3Transcript(data);
        if (cues.length) {
          return cues;
        }
      } catch (error) {
        console.debug("[Subtitle AI Helper] json3 subtitle parse failed, trying vtt:", error);
      }
    }

    const vttUrl = new URL(baseUrl, location.origin);
    vttUrl.searchParams.set("fmt", "vtt");
    const vttResponse = await fetch(vttUrl.toString(), { credentials: "include" });
    if (!vttResponse.ok) {
      throw new Error("字幕下载失败。");
    }

    const cues = parseVttTranscript(await vttResponse.text());
    if (!cues.length) {
      throw new Error("字幕内容为空。");
    }

    return cues;
  }

  function parseJson3Transcript(data) {
    const events = Array.isArray(data && data.events) ? data.events : [];
    return events
      .map((event) => {
        const text = Array.isArray(event.segs)
          ? event.segs.map((segment) => segment.utf8 || "").join("")
          : "";
        const normalized = normalizeCaptionText(text);

        if (!normalized) {
          return null;
        }

        const start = Number(event.tStartMs || 0) / 1000;
        const duration = Number(event.dDurationMs || 3500) / 1000;

        return {
          text: normalized,
          start,
          end: start + Math.max(duration, 1),
          source: "timedtext"
        };
      })
      .filter(Boolean);
  }

  function parseVttTranscript(vttText) {
    const blocks = String(vttText).split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const timeLine = lines.find((line) => line.includes("-->"));
      if (!timeLine) {
        continue;
      }

      const textLines = lines.slice(lines.indexOf(timeLine) + 1);
      const text = normalizeCaptionText(
        textLines
          .join(" ")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
      );
      const times = timeLine.split("-->").map((part) => part.trim());
      const start = parseVttTime(times[0]);
      const end = parseVttTime(times[1]);

      if (text && Number.isFinite(start) && Number.isFinite(end)) {
        cues.push({ text, start, end, source: "vtt" });
      }
    }

    return cues;
  }

  function parseVttTime(value) {
    const cleaned = String(value).split(/\s+/)[0];
    const parts = cleaned.split(":");
    const seconds = Number(parts.pop().replace(",", "."));
    const minutes = Number(parts.pop() || 0);
    const hours = Number(parts.pop() || 0);

    return hours * 3600 + minutes * 60 + seconds;
  }

  function findCueAtTime(transcript, currentTime) {
    if (!Array.isArray(transcript) || !transcript.length) {
      return null;
    }

    const directIndex = transcript.findIndex((cue) => (
      currentTime >= cue.start - 0.25 && currentTime <= cue.end + 0.35
    ));

    if (directIndex !== -1) {
      return { ...transcript[directIndex], index: directIndex };
    }

    let nearestIndex = -1;
    let nearestDistance = Infinity;

    transcript.forEach((cue, index) => {
      const distance = Math.min(Math.abs(currentTime - cue.start), Math.abs(currentTime - cue.end));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    if (nearestIndex !== -1 && nearestDistance <= 4) {
      return { ...transcript[nearestIndex], index: nearestIndex };
    }

    return null;
  }

  function withContext(cue, transcript) {
    const index = typeof cue.index === "number" ? cue.index : transcript.indexOf(cue);
    const sentenceRange = expandSentenceRange(index, transcript);
    const start = Math.max(0, sentenceRange.start - 2);
    const end = Math.min(transcript.length, sentenceRange.end + 3);
    const context = transcript
      .slice(start, end)
      .map((item, offset) => {
        const absoluteIndex = start + offset;
        const prefix = absoluteIndex >= sentenceRange.start && absoluteIndex <= sentenceRange.end ? ">> " : "";
        return `${prefix}${item.text}`;
      })
      .join("\n");
    const sentenceCues = transcript.slice(sentenceRange.start, sentenceRange.end + 1);
    const sentence = normalizeCaptionText(sentenceCues.map((item) => item.text).join(" "));

    return {
      ...cue,
      text: sentence || cue.text,
      start: sentenceCues[0] ? sentenceCues[0].start : cue.start,
      end: sentenceCues[sentenceCues.length - 1] ? sentenceCues[sentenceCues.length - 1].end : cue.end,
      context
    };
  }

  function expandSentenceRange(index, transcript) {
    let start = index;
    let end = index;

    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (!canJoinPrevious(previous, start, end, transcript)) {
        break;
      }
      start = previous;
    }

    while (end < transcript.length - 1 && canJoinNext(start, end, transcript)) {
      end += 1;
    }

    return { start, end };
  }

  function canJoinPrevious(previousIndex, start, end, transcript) {
    const previous = transcript[previousIndex];
    const first = transcript[start];
    if (!previous || !first) {
      return false;
    }

    if (endsSentence(previous.text)) {
      return false;
    }

    if (first.start - previous.end > SENTENCE_GAP_LIMIT) {
      return false;
    }

    return isReasonableSentenceRange(previousIndex, end, transcript);
  }

  function canJoinNext(start, end, transcript) {
    const current = transcript[end];
    const next = transcript[end + 1];
    if (!current || !next) {
      return false;
    }

    if (endsSentence(current.text)) {
      return false;
    }

    if (next.start - current.end > SENTENCE_GAP_LIMIT) {
      return false;
    }

    return isReasonableSentenceRange(start, end + 1, transcript);
  }

  function isReasonableSentenceRange(start, end, transcript) {
    const cues = transcript.slice(start, end + 1);
    const first = cues[0];
    const last = cues[cues.length - 1];
    const text = cues.map((item) => item.text).join(" ");
    const duration = last.end - first.start;
    const wordCount = countWords(text);

    return duration <= SENTENCE_MAX_DURATION && wordCount <= SENTENCE_MAX_WORDS;
  }

  function endsSentence(text) {
    return /[.!?]["')\]]?$/.test(String(text || "").trim());
  }

  function countWords(text) {
    const matches = String(text || "").match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g);
    return matches ? matches.length : 0;
  }

  function renderSentence(cue) {
    const range = Number.isFinite(cue.start) && Number.isFinite(cue.end)
      ? `${formatTime(cue.start)} - ${formatTime(cue.end)}`
      : "当前字幕";

    state.elements.sentence.textContent = `${range}\n${cue.text}`;
  }

  function renderAnalysis(analysis, rawText) {
    const result = state.elements.result;
    result.replaceChildren();

    if (!analysis) {
      const recovered = recoverAnalysisFromRawText(rawText);
      if (recovered) {
        renderAnalysis(recovered);
        appendRawDetails(result, rawText);
        return;
      }

      renderReadableRawText(result, rawText || "AI 返回为空。");
      return;
    }

    state.currentAnalysis = normalizeAnalysisForSaving(analysis);
    appendSection(result, "中文意思", analysis.zh || "暂无", "sai-card-major");
    appendSection(result, "语气解释", analysis.tone || "暂无");
    appendItems(result, "重点单词", analysis.keywords, (item) => {
      const title = item.word || item.text || "";
      return {
        title,
        body: [item.meaning, item.note].filter(Boolean).join(" · ")
      };
    });
    appendItems(result, "短语用法", analysis.phrases, (item) => ({
      title: item.phrase || "",
      body: [item.usage, item.example].filter(Boolean).join("\n")
    }));
    appendItems(result, "例句", analysis.examples, (item) => ({
      title: item.en || "",
      body: item.zh || ""
    }));
    appendSaveAction(result);
  }

  function recoverAnalysisFromRawText(rawText) {
    const text = stripCodeFence(rawText);
    if (!text) {
      return null;
    }

    const recovered = {
      zh: extractLooseField(text, "zh"),
      tone: extractLooseField(text, "tone"),
      keywords: extractLooseItems(text, "keywords", ["word", "meaning", "note"]),
      phrases: extractLooseItems(text, "phrases", ["phrase", "usage", "example"]),
      examples: extractLooseItems(text, "examples", ["en", "zh"])
    };

    const hasContent = recovered.zh ||
      recovered.tone ||
      recovered.keywords.length ||
      recovered.phrases.length ||
      recovered.examples.length;

    return hasContent ? recovered : null;
  }

  function extractLooseItems(text, key, fields) {
    const section = extractLooseArraySection(text, key);
    if (!section) {
      return [];
    }

    const objects = section.match(/\{[\s\S]*?\}/g) || [];
    return objects
      .map((objectText) => fields.reduce((item, field) => {
        item[field] = extractLooseField(objectText, field);
        return item;
      }, {}))
      .filter((item) => Object.values(item).some(Boolean));
  }

  function extractLooseArraySection(text, key) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*\\[([\\s\\S]*?)\\]\\s*(?:,\\s*"|\\s*})`, "i");
    const match = text.match(pattern);
    return match ? match[1] : "";
  }

  function extractLooseField(text, key) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,|})`, "i");
    const match = text.match(pattern);
    return match ? cleanLooseValue(match[1]) : "";
  }

  function cleanLooseValue(value) {
    return String(value || "")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\s+/g, " ")
      .replace(/^"+|"+$/g, "")
      .trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripCodeFence(text) {
    return String(text || "")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  function renderReadableRawText(parent, rawText) {
    const cleaned = stripCodeFence(rawText);
    const readable = cleaned
      .replace(/[{}[\]]/g, "")
      .replace(/^\s*,?\s*"?([a-z_]+)"?\s*:\s*/gim, (_match, key) => `${labelForRawKey(key)}：`)
      .replace(/^\s*,\s*/gm, "")
      .replace(/^\s*"|",?\s*$/gm, "")
      .trim();

    appendSection(parent, "AI 返回内容", readable || cleaned || "AI 返回为空。");
    appendRawDetails(parent, rawText);
  }

  function appendRawDetails(parent, rawText) {
    if (!rawText) {
      return;
    }

    const details = document.createElement("details");
    details.className = "sai-raw-details";

    const summary = document.createElement("summary");
    summary.textContent = "查看原始返回";
    details.appendChild(summary);

    const pre = document.createElement("pre");
    pre.className = "sai-raw";
    pre.textContent = stripCodeFence(rawText);
    details.appendChild(pre);

    parent.appendChild(details);
  }

  function labelForRawKey(key) {
    const labels = {
      zh: "中文意思",
      tone: "语气",
      keywords: "重点单词",
      word: "单词",
      meaning: "意思",
      note: "提示",
      phrases: "短语",
      phrase: "表达",
      usage: "用法",
      example: "例子",
      examples: "例句",
      en: "英文",
      example_en: "英文",
      example_zh: "中文"
    };

    return labels[key] || key;
  }

  function renderSearchResult(query, match) {
    const result = state.elements.result;
    result.replaceChildren();
    state.currentAnalysis = null;

    const lines = match && match.source === "visible-caption"
      ? [
        `已从当前屏幕字幕定位到包含 "${query}" 的句子。`,
        "完整字幕轨道暂时不可用，所以这次只匹配当前显示的字幕。",
        "可以直接朗读；重播会从当前时间附近播放。"
      ]
      : match && match.source === "selected-cue"
        ? [
          `已从当前已显示句子定位到包含 "${query}" 的内容。`,
          "完整字幕轨道暂时不可用，所以这次复用面板里已识别的句子。",
          "可以直接朗读或重播这句话。"
        ]
      : [
        `已定位到包含 "${query}" 的完整句子。`,
        `本视频字幕中共找到 ${match.matchCount} 处匹配。`,
        "可以直接朗读或重播这句话。"
      ];

    const message = document.createElement("div");
    message.className = "sai-message";
    message.textContent = lines.join("\n");
    result.appendChild(message);
  }

  function renderSearchHint(text, isError = false) {
    const hint = state.elements.wordHint;
    if (!hint) {
      return;
    }

    hint.textContent = text;
    hint.classList.toggle("sai-search-error", Boolean(isError));
  }

  function clearSearchHint() {
    renderSearchHint("");
  }

  function appendSection(parent, title, body, extraClass = "") {
    const section = document.createElement("section");
    section.className = "sai-card";
    if (extraClass) {
      section.classList.add(extraClass);
    }

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    const paragraph = document.createElement("p");
    paragraph.textContent = body;
    section.appendChild(paragraph);

    parent.appendChild(section);
  }

  function renderTrialUsage(trial) {
    if (!trial || !Number.isFinite(Number(trial.remaining))) {
      return;
    }

    const remaining = Math.max(0, Number(trial.remaining));
    const limit = Math.max(remaining, Number(trial.limit) || 5);
    appendSection(
      state.elements.result,
      "免费体验额度",
      `剩余 ${remaining} / ${limit} 次。额度用完后，可在设置中切换为自己的 API Key。`
    );
  }

  function appendItems(parent, title, items, normalize) {
    if (!Array.isArray(items) || !items.length) {
      return;
    }

    const section = document.createElement("section");
    section.className = "sai-card";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement("div");
    list.className = "sai-list";

    items.slice(0, 6).forEach((item) => {
      const normalized = normalize(item || {});
      const row = document.createElement("article");
      row.className = "sai-list-item";

      const itemTitle = document.createElement("strong");
      itemTitle.textContent = normalized.title || "未命名";
      row.appendChild(itemTitle);

      if (normalized.body) {
        const itemBody = document.createElement("p");
        itemBody.textContent = normalized.body;
        row.appendChild(itemBody);
      }

      list.appendChild(row);
    });

    section.appendChild(list);
    parent.appendChild(section);
  }

  function appendSaveAction(parent) {
    const section = document.createElement("section");
    section.className = "sai-save-card";

    const button = document.createElement("button");
    button.className = "sai-save-button";
    button.type = "button";
    button.textContent = "收藏到学习清单";

    const status = document.createElement("span");
    status.className = "sai-save-status";
    status.setAttribute("role", "status");

    button.addEventListener("click", () => {
      handleSaveLearningItem(button, status);
    });

    section.appendChild(button);
    section.appendChild(status);
    parent.appendChild(section);
  }

  async function handleSaveLearningItem(button, status) {
    const storage = globalThis.SaiLearningStorage;
    if (!storage || typeof storage.addLearningItem !== "function") {
      setSaveStatus(status, "学习记录模块不可用，请重新加载扩展。", true);
      return;
    }

    if (!state.selectedCue || !state.selectedCue.text) {
      setSaveStatus(status, "没有可收藏的当前内容。", true);
      return;
    }

    if (!state.currentAnalysis) {
      setSaveStatus(status, "请先完成解释后再收藏。", true);
      return;
    }

    button.disabled = true;
    setSaveStatus(status, "正在保存...");

    try {
      const result = await storage.addLearningItem(buildLearningItem());
      if (result && result.duplicate) {
        setSaveStatus(status, "这条内容已经在学习清单中。");
        return;
      }

      setSaveStatus(status, "已加入今日学习清单。");
    } catch (error) {
      setSaveStatus(status, error && error.message ? error.message : "保存失败。", true);
    } finally {
      button.disabled = false;
    }
  }

  function buildLearningItem() {
    const cue = state.selectedCue || {};
    const analysis = state.currentAnalysis || {};
    const keywords = Array.isArray(analysis.keywords) ? analysis.keywords : [];
    const phrases = Array.isArray(analysis.phrases) ? analysis.phrases : [];
    const examples = Array.isArray(analysis.examples) ? analysis.examples : [];

    return {
      type: inferLearningType(cue.text),
      content: cue.text,
      translation: analysis.zh || "",
      wordList: keywords.map((item) => item.word || item.text || "").filter(Boolean),
      wordExplanations: keywords.reduce((map, item) => {
        const word = item.word || item.text || "";
        if (word) {
          map[word] = {
            meaning: item.meaning || "",
            note: item.note || ""
          };
        }
        return map;
      }, {}),
      usage: phrases.map((item) => (
        [item.phrase, item.usage, item.example].filter(Boolean).join(" - ")
      )).filter(Boolean).join("\n"),
      grammar: analysis.grammar || "",
      example: examples.map((item) => (
        [item.en, item.zh].filter(Boolean).join(" - ")
      )).filter(Boolean).join("\n"),
      sourceSite: location.hostname,
      sourceTitle: getPageTitle(),
      sourceUrl: location.href,
      videoTime: Number.isFinite(cue.start) ? Math.round(cue.start) : getCurrentVideoTimeForSaving(),
      note: ""
    };
  }

  function normalizeAnalysisForSaving(analysis) {
    return {
      ...analysis,
      keywords: Array.isArray(analysis.keywords) ? analysis.keywords : [],
      phrases: Array.isArray(analysis.phrases) ? analysis.phrases : [],
      examples: Array.isArray(analysis.examples) ? analysis.examples : []
    };
  }

  function inferLearningType(text) {
    const words = countWords(text);
    if (words <= 1) {
      return "word";
    }
    if (words <= 5 && !endsSentence(text)) {
      return "phrase";
    }
    return "sentence";
  }

  function setSaveStatus(element, text, isError = false) {
    if (!element) {
      return;
    }

    element.textContent = text;
    element.classList.toggle("sai-save-error", Boolean(isError));
  }

  function renderLoading(text) {
    state.elements.result.replaceChildren();
    state.currentAnalysis = null;
    const loading = document.createElement("div");
    loading.className = "sai-message";
    loading.textContent = text;
    state.elements.result.appendChild(loading);
  }

  function renderError(text) {
    state.elements.result.replaceChildren();
    state.currentAnalysis = null;
    const error = document.createElement("div");
    error.className = "sai-message sai-error";
    error.textContent = text;
    state.elements.result.appendChild(error);
  }

  function openPanel() {
    state.elements.panel.hidden = false;
  }

  async function readCurrentSentence() {
    try {
      const cue = state.selectedCue || await getCurrentCue();
      if (!cue || !cue.text) {
        renderError("没有可朗读的当前句子。");
        return;
      }

      state.selectedCue = cue;
      renderSentence(cue);

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(cue.text);
      utterance.lang = "en-US";
      utterance.rate = 0.88;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      renderError(error && error.message ? error.message : String(error));
    }
  }

  async function replayCurrentClip() {
    try {
      const video = getVideoElement();
      const cue = state.selectedCue || await getCurrentCue();

      if (!video || !cue) {
        renderError("没有找到可重播的视频片段。");
        return;
      }

      state.selectedCue = cue;
      renderSentence(cue);
      state.replayStopAt = Math.max(cue.start + 0.8, cue.end + REPLAY_END_PADDING);
      video.currentTime = Math.max(0, cue.start - 0.25);
      video.play().catch(() => {});
    } catch (error) {
      renderError(error && error.message ? error.message : String(error));
    }
  }

  function bindVideoReplayGuard() {
    document.addEventListener("timeupdate", (event) => {
      if (!state.replayStopAt || event.target.tagName !== "VIDEO") {
        return;
      }

      if (event.target.currentTime >= state.replayStopAt) {
        event.target.pause();
        state.replayStopAt = null;
      }
    }, true);
  }

  function handleUrlChange() {
    if (state.lastUrl === location.href) {
      return;
    }

    state.lastUrl = location.href;
    state.videoId = null;
    state.transcript = null;
    state.transcriptPromise = null;
    state.selectedCue = null;
    state.lastSelectedText = "";
    window.clearTimeout(state.wordSearchTimer);
    state.wordSearchRequestId += 1;
    clearSearchHint();

    if (state.elements.status) {
      updateModeStatus();
    }
  }

  function getVideoId() {
    const url = new URL(location.href);
    if (url.searchParams.get("v")) {
      return url.searchParams.get("v");
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if ((parts[0] === "shorts" || parts[0] === "embed") && parts[1]) {
      return parts[1];
    }

    return null;
  }

  function getVideoElement() {
    return document.querySelector("video");
  }

  function getVideoTime() {
    const video = getVideoElement();
    return video ? video.currentTime : 0;
  }

  function getCurrentVideoTimeForSaving() {
    const video = getVideoElement();
    return video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime) : null;
  }

  function getPlaybackTimeLabel() {
    const video = getVideoElement();
    return video && Number.isFinite(video.currentTime) ? formatTime(video.currentTime) : "无视频时间";
  }

  function getPageTitle() {
    if (isYouTubePage()) {
      return document.title.replace(/\s+-\s+YouTube\s*$/i, "").trim() || "YouTube video";
    }

    return document.title.trim() || location.hostname || "当前网页";
  }

  function isYouTubePage() {
    return /(^|\.)youtube\.com$/i.test(location.hostname);
  }

  function updateModeStatus() {
    if (!state.elements.status) {
      return;
    }

    state.elements.status.textContent = isYouTubePage() ? "YouTube" : "网页选中文本";
  }

  function getNoTextErrorMessage() {
    if (isYouTubePage()) {
      return "没有检测到当前字幕或选中文本。请确认视频有英文字幕，或在页面上选中一句英文后再点击。";
    }

    return "没有检测到选中的英文内容。请先用鼠标选中一个单词、短语或句子，再点击悬浮按钮。";
  }

  function readSelectedText() {
    return readCurrentSelectionText() || state.lastSelectedText || "";
  }

  function readCurrentSelectionText() {
    const selection = window.getSelection && window.getSelection();
    const text = selection ? normalizeCaptionText(selection.toString()) : "";
    if (!text || text.length < 2) {
      return "";
    }

    return text.slice(0, 700);
  }

  function readVisibleCaption() {
    return normalizeCaptionText(
      Array.from(document.querySelectorAll(".ytp-caption-segment"))
        .map((element) => element.textContent || "")
        .join(" ")
    );
  }

  function normalizeCaptionText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim();
  }

  function normalizeSearchText(text) {
    return normalizeCaptionText(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'");
  }

  function normalizeSearchQuery(query) {
    return normalizeSearchText(query)
      .replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "")
      .trim();
  }

  function tokenizeSearchText(text) {
    const matches = normalizeSearchText(text).match(/[a-z0-9]+(?:['-][a-z0-9]+)?/g);
    return matches ? matches : [];
  }

  function formatTime(totalSeconds) {
    const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function sendRuntimeMessage(message, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error("扩展上下文不可用。请在 chrome://extensions 重新加载扩展，然后刷新当前页面。"));
        return;
      }

      let settled = false;
      const timeoutId = timeoutMs > 0
        ? window.setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          reject(new Error("AI 分析等待超时。请检查 API 设置、网络连接，或稍后重试。"));
        }, timeoutMs)
        : null;

      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
        callback(value);
      };

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            finish(reject, new Error(formatRuntimeMessageError(error.message)));
            return;
          }
          finish(resolve, response);
        });
      } catch (error) {
        finish(reject, new Error(formatRuntimeMessageError(error && error.message)));
      }
    });
  }

  function formatRuntimeMessageError(message) {
    const text = String(message || "");
    if (/Extension context invalidated/i.test(text)) {
      return "扩展刚刚被重新加载，当前页面里的助手已失效。请刷新当前页面后再点击“译”。";
    }

    if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(text)) {
      return "扩展后台暂时没有响应。请在 chrome://extensions 重新加载扩展，然后刷新当前页面。";
    }

    return text || "扩展消息发送失败。请重新加载扩展并刷新当前页面。";
  }
})();

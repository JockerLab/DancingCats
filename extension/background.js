importScripts("shared.js");

const { MESSAGE } = DancingCatsShared;
const SESSION_KEY = "activeCapture";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.remove(SESSION_KEY);
  void chrome.storage.local.remove("settings");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isYouTubeUrl(tab.url)) {
    await setBadge(tab.id, "!", "#b91c1c");
    return;
  }

  const streamResultPromise = chrome.tabCapture
    .getMediaStreamId({ targetTabId: tab.id })
    .then((streamId) => ({ streamId }), (error) => ({ error }));
  const active = await getActiveCapture();

  if (active?.tabId === tab.id) {
    await stopCapture(tab.id, "user");
    return;
  }
  if (active?.tabId) await stopCapture(active.tabId, "switched-tab");

  const streamResult = await streamResultPromise;
  if (streamResult.error) {
    await handleError(tab.id, streamResult.error);
    return;
  }

  try {
    await ensureOffscreenDocument();
    await chrome.storage.session.set({
      [SESSION_KEY]: { tabId: tab.id, state: "starting" }
    });
    await setBadge(tab.id, "…", "#ca8a04");
    await safeSendToTab(tab.id, { type: MESSAGE.ENABLE_OVERLAY, state: "starting" });
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE.START_CAPTURE,
      tabId: tab.id,
      streamId: streamResult.streamId,
      youtubeUrl: tab.url
    });
    if (response?.ok === false) throw new Error(response.error ?? "Unable to start audio capture");
  } catch (error) {
    await handleError(tab.id, error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === MESSAGE.CONTENT_READY && sender.tab?.id) {
    void getActiveCapture().then((active) => {
      if (active?.tabId === sender.tab.id) {
        return safeSendToTab(sender.tab.id, {
          type: MESSAGE.ENABLE_OVERLAY,
          state: active.state
        });
      }
    });
    return false;
  }

  if (message.type === MESSAGE.RESET_ANALYSIS && sender.tab?.id) {
    void getActiveCapture().then((active) => {
      if (active?.tabId === sender.tab.id) {
        return chrome.runtime.sendMessage({
          target: "offscreen",
          type: MESSAGE.RESET_ANALYSIS,
          tabId: sender.tab.id,
          youtubeUrl: message.youtubeUrl
        });
      }
    });
    return false;
  }

  if (message.source !== "offscreen") return false;
  if (message.type === MESSAGE.CAPTURE_READY) {
    void markReady(message.tabId).then(() => sendResponse?.({ ok: true }));
    return true;
  }
  if (message.type === MESSAGE.BEAT_STATE) {
    void safeSendToTab(message.tabId, message);
  } else if (message.type === MESSAGE.ANALYSIS_STATE) {
    void showAnalysisState(message.tabId, message.status);
    void safeSendToTab(message.tabId, message);
  } else if (message.type === MESSAGE.CHOREOGRAPHY_READY) {
    void safeSendToTab(message.tabId, message);
  } else if (message.type === MESSAGE.CAPTURE_ENDED) {
    void finishCapture(message.tabId, message.reason ?? "ended");
  } else if (message.type === MESSAGE.ERROR) {
    void handleError(message.tabId, message.message ?? message.code);
  }
  sendResponse?.({ ok: true });
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getActiveCapture().then((active) => {
    if (active?.tabId === tabId) return stopCapture(tabId, "tab-closed");
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || isYouTubeUrl(changeInfo.url)) return;
  void getActiveCapture().then((active) => {
    if (active?.tabId === tabId) return stopCapture(tabId, "left-youtube");
  });
});

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Локальный real-time анализ ритма аудио вкладки YouTube"
  });
}

async function markReady(tabId) {
  const active = await getActiveCapture();
  if (active?.tabId !== tabId) return;
  await chrome.storage.session.set({ [SESSION_KEY]: { tabId, state: "listening" } });
  await setBadge(tabId, "ON", "#15803d");
  await safeSendToTab(tabId, { type: MESSAGE.ENABLE_OVERLAY, state: "listening" });
}

async function showAnalysisState(tabId, status) {
  if (status === "complete") {
    await setBadge(tabId, "MAP", "#7c3aed");
  } else if (status === "unavailable") {
    await setBadge(tabId, "RT", "#475569");
  } else {
    await setBadge(tabId, "AI…", "#ca8a04");
  }
}

async function stopCapture(tabId, reason) {
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE.STOP_CAPTURE,
      tabId,
      reason
    });
  } catch {
    // The offscreen document may already be gone.
  }
  await finishCapture(tabId, reason);
}

async function finishCapture(tabId, reason) {
  const active = await getActiveCapture();
  if (active?.tabId === tabId) await chrome.storage.session.remove(SESSION_KEY);
  await setBadge(tabId, "", "#15803d");
  await safeSendToTab(tabId, { type: MESSAGE.DISABLE_OVERLAY, reason });
}

async function handleError(tabId, error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  await chrome.storage.session.remove(SESSION_KEY);
  await setBadge(tabId, "!", "#b91c1c");
  await safeSendToTab(tabId, { type: MESSAGE.ERROR, message });
}

async function getActiveCapture() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  return data[SESSION_KEY] ?? null;
}

async function safeSendToTab(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content scripts are unavailable on internal/error pages.
  }
}

async function setBadge(tabId, text, color) {
  if (!tabId) return;
  await chrome.action.setBadgeText({ tabId, text });
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function isYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname === "www.youtube.com";
  } catch {
    return false;
  }
}

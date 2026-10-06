importScripts("shared.js");

const { MESSAGE } = DancingCatsShared;
const SESSION_KEY = "activeOverlay";
const API_ORIGIN = "http://127.0.0.1:8765";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.remove([SESSION_KEY, "activeCapture"]);
  void chrome.storage.local.remove("settings");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isYouTubeWatchUrl(tab.url)) {
    await setBadge(tab.id, "!", "#b91c1c");
    return;
  }

  const active = await getActiveOverlay();
  if (active?.tabId === tab.id) {
    await disableOverlay(tab.id, "user");
    return;
  }
  if (active?.tabId) await disableOverlay(active.tabId, "switched-tab");

  await chrome.storage.session.set({
    [SESSION_KEY]: { tabId: tab.id, state: "loading" }
  });
  await setBadge(tab.id, "…", "#ca8a04");
  await safeSendToTab(tab.id, {
    type: MESSAGE.ENABLE_OVERLAY,
    youtubeUrl: tab.url
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === MESSAGE.CONTENT_READY && sender.tab?.id) {
    void getActiveOverlay().then((active) => {
      if (active?.tabId === sender.tab.id) {
        return safeSendToTab(sender.tab.id, {
          type: MESSAGE.ENABLE_OVERLAY,
          youtubeUrl: sender.tab.url || sender.url
        });
      }
    });
    return false;
  }

  if (message.type === MESSAGE.START_ANALYSIS && sender.tab?.id) {
    void handleStartAnalysis(sender.tab.id, message).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE.GET_ANALYSIS && sender.tab?.id) {
    void handleGetAnalysis(sender.tab.id, message.jobId).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE.ANALYSIS_STATE && sender.tab?.id) {
    void updateAnalysisState(sender.tab.id, message.status);
    return false;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getActiveOverlay().then((active) => {
    if (active?.tabId === tabId) return clearActiveOverlay(tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || isYouTubeWatchUrl(changeInfo.url)) return;
  void getActiveOverlay().then((active) => {
    if (active?.tabId === tabId) return disableOverlay(tabId, "left-watch-page");
  });
});

async function handleStartAnalysis(tabId, message) {
  if (!(await isActiveTab(tabId)) || !isYouTubeWatchUrl(message.youtubeUrl)) {
    return { ok: false, error: "Analysis is allowed only for the active YouTube video" };
  }
  return requestJson(`${API_ORIGIN}/v1/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      youtubeUrl: message.youtubeUrl,
      assetId: message.assetId || "three-cats"
    })
  });
}

async function handleGetAnalysis(tabId, jobId) {
  if (!(await isActiveTab(tabId)) || !/^[a-f0-9]{32}$/.test(String(jobId || ""))) {
    return { ok: false, error: "Invalid or inactive analysis job" };
  }
  const result = await requestJson(`${API_ORIGIN}/v1/analysis/${encodeURIComponent(jobId)}`);
  if (!result.ok || result.data.status !== "complete") return result;
  if (!isLocalMapUrl(result.data.mapUrl)) {
    return { ok: false, error: "Backend returned an invalid choreography URL" };
  }
  const map = await requestJson(result.data.mapUrl);
  if (!map.ok) return map;
  return { ok: true, data: { ...result.data, choreography: map.data } };
}

async function requestJson(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        error: payload?.detail || `Local backend returned HTTP ${response.status}`
      };
    }
    return { ok: true, data: payload };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function updateAnalysisState(tabId, status) {
  if (!(await isActiveTab(tabId))) return;
  if (status === "ready") {
    await chrome.storage.session.set({
      [SESSION_KEY]: { tabId, state: "ready" }
    });
    await setBadge(tabId, "ON", "#15803d");
  } else if (status === "error") {
    await chrome.storage.session.set({
      [SESSION_KEY]: { tabId, state: "error" }
    });
    await setBadge(tabId, "!", "#b91c1c");
  } else {
    await setBadge(tabId, "…", "#ca8a04");
  }
}

async function disableOverlay(tabId, reason) {
  await clearActiveOverlay(tabId);
  await safeSendToTab(tabId, { type: MESSAGE.DISABLE_OVERLAY, reason });
}

async function clearActiveOverlay(tabId) {
  const active = await getActiveOverlay();
  if (active?.tabId === tabId) await chrome.storage.session.remove(SESSION_KEY);
  await setBadge(tabId, "", "#15803d");
}

async function isActiveTab(tabId) {
  const active = await getActiveOverlay();
  return active?.tabId === tabId;
}

async function getActiveOverlay() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  return data[SESSION_KEY] ?? null;
}

async function safeSendToTab(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script can disappear during navigation.
  }
}

async function setBadge(tabId, text, color) {
  if (!tabId) return;
  await chrome.action.setBadgeText({ tabId, text });
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function isYouTubeWatchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.youtube.com" &&
      url.pathname === "/watch" &&
      /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "")
    );
  } catch {
    return false;
  }
}

function isLocalMapUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === API_ORIGIN && url.pathname.startsWith("/v1/maps/");
  } catch {
    return false;
  }
}

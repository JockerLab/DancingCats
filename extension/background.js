importScripts("shared.js");

const { MESSAGE } = DancingCatsShared;
const ENABLED_TABS_KEY = "enabledTabs";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.session.remove("activeCapture");
  void chrome.storage.local.remove("settings");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isYouTubeUrl(tab.url)) {
    await setBadge(tab.id, "!", "#b91c1c");
    return;
  }

  const enabledTabs = await getEnabledTabs();
  const enabled = !enabledTabs.has(tab.id);
  if (enabled) enabledTabs.add(tab.id);
  else enabledTabs.delete(tab.id);
  await saveEnabledTabs(enabledTabs);
  await setBadge(tab.id, enabled ? "ON" : "", "#15803d");
  await safeSendToTab(tab.id, {
    type: enabled ? MESSAGE.ENABLE_OVERLAY : MESSAGE.DISABLE_OVERLAY
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== MESSAGE.CONTENT_READY || !sender.tab?.id) return false;
  void getEnabledTabs().then(async (enabledTabs) => {
    if (!enabledTabs.has(sender.tab.id)) return;
    await setBadge(sender.tab.id, "ON", "#15803d");
    await safeSendToTab(sender.tab.id, { type: MESSAGE.ENABLE_OVERLAY });
  });
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeEnabledTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || isYouTubeUrl(changeInfo.url)) return;
  void removeEnabledTab(tabId);
});

async function getEnabledTabs() {
  const data = await chrome.storage.session.get(ENABLED_TABS_KEY);
  return new Set(Array.isArray(data[ENABLED_TABS_KEY]) ? data[ENABLED_TABS_KEY] : []);
}

async function saveEnabledTabs(enabledTabs) {
  await chrome.storage.session.set({ [ENABLED_TABS_KEY]: [...enabledTabs] });
}

async function removeEnabledTab(tabId) {
  const enabledTabs = await getEnabledTabs();
  if (!enabledTabs.delete(tabId)) return;
  await saveEnabledTabs(enabledTabs);
}

async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content scripts are unavailable on error and internal pages.
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

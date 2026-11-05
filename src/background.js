// TubeLens service worker: network calls that need host permissions, and opening editor tabs.
"use strict";
importScripts("../lib/keywords.js", "../lib/ytapi.js");

const { keywordIdeas } = globalThis.TubeLensKeywords;
const { createClient, YouTubeApiError } = globalThis.TubeLensApi;

// First install: open the getting-started page.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

async function apiClient() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return typeof apiKey === "string" && apiKey.trim() ? createClient({ key: apiKey }) : null;
}

// Likes, comments and subscriber counts need a YouTube Data API v3 key (free quota).
async function dataApiStats({ videoId, channelId }) {
  const client = await apiClient();
  if (!client) return { available: false, reason: "Add a YouTube Data API key in TubeLens settings for likes, comments and subscribers." };
  const [[video], [channel]] = await Promise.all([
    client.videos([videoId]),
    channelId ? client.channels([channelId]) : Promise.resolve([]),
  ]);
  return {
    available: true,
    likes: video?.likes ?? null,
    comments: video?.comments ?? null,
    subscribers: channel?.subscribers ?? null,
  };
}

// The thumbnail editor reads and removes this seed when it opens.
async function openThumbnail({ image, title, videoId }) {
  await chrome.storage.session.set({ thumbnailSeed: { image, title, videoId } });
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/thumbnail.html") });
  return { opened: true };
}

async function openResearch({ channel }) {
  const url = new URL(chrome.runtime.getURL("src/research.html"));
  if (channel) url.searchParams.set("channel", String(channel));
  await chrome.tabs.create({ url: url.href });
  return { opened: true };
}

// Check a key with the cheapest Data API call (1 unit) before saving it.
async function testKey({ key }) {
  try {
    await createClient({ key: String(key ?? "") }).videoCategories("US");
    return { valid: true };
  } catch (err) {
    if (err instanceof YouTubeApiError) return { valid: false, code: err.code, message: err.message };
    return { valid: false, code: "network", message: String(err?.message ?? err) };
  }
}

const handlers = {
  keywordIdeas: ({ seed }) => keywordIdeas(String(seed ?? "")),
  dataApiStats,
  openThumbnail,
  openResearch,
  openOptions: async () => {
    await chrome.runtime.openOptionsPage();
    return { opened: true };
  },
  testKey,
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(msg)
    .then((data) => reply({ ok: true, data }))
    .catch((err) => reply({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

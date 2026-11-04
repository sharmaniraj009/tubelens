"use strict";
const key = document.getElementById("key");
const status = document.getElementById("status");
const say = (t) => { status.textContent = t; setTimeout(() => (status.textContent = ""), 2000); };

chrome.storage.local.get("apiKey").then(({ apiKey }) => { key.value = apiKey ?? ""; });
document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ apiKey: key.value.trim() });
  say("Saved");
});
document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove("apiKey");
  key.value = "";
  say("Removed");
});

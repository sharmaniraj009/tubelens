"use strict";
const key = document.getElementById("key");
const status = document.getElementById("status");
const say = (text, cls = "") => {
  status.textContent = text;
  status.className = cls;
};

chrome.storage.local.get("apiKey").then(({ apiKey }) => {
  key.value = apiKey ?? "";
  if (apiKey) say("A key is saved.", "ok");
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = key.value.trim();
  if (!value) return say("Paste a key first.", "bad");
  say("Testing the key…");
  const reply = await chrome.runtime.sendMessage({ type: "testKey", key: value });
  const result = reply?.ok ? reply.data : { valid: false, code: "error", message: reply?.error ?? "no response" };
  // Only a rejected key is refused; network trouble or a used-up quota still means the key is real.
  if (!result.valid && result.code === "key_invalid") {
    return say("Google rejected this key. Check that you copied all of it and that YouTube Data API v3 is enabled for its project.", "bad");
  }
  await chrome.storage.local.set({ apiKey: value });
  if (result.valid) say("Saved. The key works.", "ok");
  else if (result.code === "quota_exceeded") say("Saved. Today's quota is used up; it resets at midnight Pacific time.", "ok");
  else say(`Saved, but it couldn't be tested: ${result.message}`, "bad");
});

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.remove("apiKey");
  key.value = "";
  say("Key removed.");
});

"use strict";
const { score } = globalThis.TubeLensSEO;
const Clips = globalThis.TubeLensClips;
const $ = (id) => document.getElementById(id);
const band = (s) => (s >= 70 ? "good" : s >= 40 ? "mid" : "bad");
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};

// Tabs (the last one used opens next time)
function showTab(name) {
  for (const t of document.querySelectorAll("[role=tab]")) {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", String(on));
    $(t.dataset.tab).hidden = !on;
  }
  chrome.storage.local.set({ popupTab: name });
  if (name === "keywords") $("seed").focus();
}
for (const tab of document.querySelectorAll("[role=tab]")) tab.addEventListener("click", () => showTab(tab.dataset.tab));

// API key status
chrome.storage.local.get(["apiKey", "popupTab"]).then(({ apiKey, popupTab }) => {
  const hasKey = typeof apiKey === "string" && apiKey.trim() !== "";
  $("key-status").textContent = hasKey ? "API key ✓" : "Add API key";
  $("key-status").className = `pill ${hasKey ? "ok" : "missing"}`;
  $("key-banner").hidden = hasKey;
  showTab(["keywords", "checker", "clips"].includes(popupTab) ? popupTab : "keywords");
});

// Keyword ideas
let lastIdeas = [];
$("kw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const seed = $("seed").value.trim();
  if (!seed) return;
  $("kw-status").textContent = "Searching autocomplete…";
  $("kw-list").replaceChildren();
  $("kw-copy").hidden = true;
  const reply = await chrome.runtime.sendMessage({ type: "keywordIdeas", seed });
  if (!reply?.ok) {
    $("kw-status").textContent = `Couldn't get ideas: ${reply?.error ?? "no response"}`;
    return;
  }
  const { ideas, probes, failed } = reply.data;
  lastIdeas = ideas.map((i) => i.keyword);
  $("kw-status").textContent = `${ideas.length} ideas from ${probes - failed}/${probes} lookups. Click one to copy it.`;
  $("kw-list").replaceChildren(...ideas.map((idea) => {
    const li = el("li", { title: "Copy" }, el("span", {}, idea.keyword), el("small", {}, `${idea.appearances} hit${idea.appearances === 1 ? "" : "s"}`));
    li.addEventListener("click", () => {
      navigator.clipboard.writeText(idea.keyword);
      $("kw-status").textContent = `Copied "${idea.keyword}".`;
    });
    return li;
  }));
  $("kw-copy").hidden = ideas.length === 0;
});
$("kw-copy").addEventListener("click", () => {
  navigator.clipboard.writeText(lastIdeas.join("\n"));
  $("kw-status").textContent = `Copied ${lastIdeas.length} ideas.`;
});

// SEO checker
const fields = ["c-keyword", "c-title", "c-desc", "c-tags"];
function check() {
  const result = score({
    keyword: $("c-keyword").value,
    title: $("c-title").value,
    description: $("c-desc").value,
    tags: $("c-tags").value.split(","),
  });
  $("c-score").textContent = String(result.score);
  $("c-score").className = `score ${band(result.score)}`;
  $("c-checks").replaceChildren(...result.checks.map((c) =>
    el("li", {}, el("span", { class: c.pass ? "good" : "bad" }, c.pass ? "✓" : "✗"), el("span", {}, `${c.label} (${c.weight})`), el("span", { class: "why" }, c.detail))));
  chrome.storage.local.set({ draft: Object.fromEntries(fields.map((f) => [f, $(f).value])) });
}
for (const f of fields) $(f).addEventListener("input", check);
chrome.storage.local.get("draft").then(({ draft }) => {
  for (const f of fields) if (draft?.[f]) $(f).value = draft[f];
  check();
});

// My clips: every video with saved clips, most recently changed first.
async function savedVideos() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith("clip:") && Array.isArray(v?.clips) && v.clips.length)
    .map(([, v]) => v)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function clipsStatus(text) {
  $("clips-status").textContent = text;
  setTimeout(() => ($("clips-status").textContent = ""), 2500);
}

async function renderClips() {
  const videos = await savedVideos();
  const total = videos.reduce((n, v) => n + v.clips.length, 0);
  $("clips-count").textContent = total ? String(total) : "";
  $("clips-empty").hidden = total > 0;
  $("clips-actions").hidden = total === 0;
  $("clips-list").replaceChildren(...videos.map((v) => el("div", { class: "clip-video" },
    el("a", { href: Clips.watchUrl(v.videoId, 0), target: "_blank", rel: "noopener", title: v.title ?? v.videoId }, v.title || v.videoId),
    v.clips.map((c) => el("div", { class: "clip-row" },
      el("a", { href: Clips.watchUrl(v.videoId, c.start), target: "_blank", rel: "noopener", title: "Open the video at this clip" }, Clips.rangeLabel(c)),
      el("span", { class: "label", title: c.note || "" }, c.note || `${Math.round(c.end - c.start)}s`),
      el("button", { title: "Copy a link that starts at this clip", onclick: () => {
        navigator.clipboard.writeText(Clips.shareUrl(v.videoId, c.start));
        clipsStatus("Link copied.");
      } }, "Link"),
      el("button", { title: "Delete clip", "aria-label": `Delete ${Clips.rangeLabel(c)}`, onclick: () => deleteClip(v.videoId, c.id) }, "✕"))))));
}

async function deleteClip(videoId, id) {
  const key = `clip:${videoId}`;
  const entry = (await chrome.storage.local.get(key))[key];
  if (!entry) return;
  const clips = entry.clips.filter((c) => c.id !== id);
  if (clips.length) await chrome.storage.local.set({ [key]: { ...entry, clips, updatedAt: Date.now() } });
  else await chrome.storage.local.remove(key);
  renderClips();
}

$("clips-copy").addEventListener("click", async () => {
  const videos = await savedVideos();
  const text = videos.map((v) => `${v.title || v.videoId}\n${Clips.clipsAsText(v.clips, v.videoId)}`).join("\n\n");
  await navigator.clipboard.writeText(text);
  clipsStatus("Copied.");
});

$("clips-csv").addEventListener("click", async () => {
  const rows = (await savedVideos()).flatMap((v) => v.clips.map((c) => ({ ...c, videoId: v.videoId, title: v.title })));
  const url = URL.createObjectURL(new Blob([Clips.clipsAsCsv(rows)], { type: "text/csv" }));
  el("a", { href: url, download: `tubelens-clips-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith("clip:"))) renderClips();
});
renderClips();

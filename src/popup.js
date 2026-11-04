"use strict";
const { score } = globalThis.TubeLensSEO;
const $ = (id) => document.getElementById(id);
const band = (s) => (s >= 70 ? "good" : s >= 40 ? "mid" : "bad");

// Tabs
for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll("[role=tab]")) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      $(t.dataset.tab).hidden = !on;
    }
  });
}

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
  $("kw-list").replaceChildren(
    ...ideas.map((idea) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = idea.keyword;
      const hits = document.createElement("small");
      hits.textContent = `${idea.appearances} hit${idea.appearances === 1 ? "" : "s"}`;
      li.append(name, hits);
      li.title = "Copy";
      li.addEventListener("click", () => navigator.clipboard.writeText(idea.keyword));
      return li;
    })
  );
  $("kw-copy").hidden = ideas.length === 0;
});
$("kw-copy").addEventListener("click", () => navigator.clipboard.writeText(lastIdeas.join("\n")));

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
  $("c-checks").replaceChildren(
    ...result.checks.map((c) => {
      const li = document.createElement("li");
      const mark = document.createElement("span");
      mark.className = c.pass ? "good" : "bad";
      mark.textContent = c.pass ? "✓" : "✗";
      const label = document.createElement("span");
      label.textContent = `${c.label} (${c.weight})`;
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = c.detail;
      li.append(mark, label, why);
      return li;
    })
  );
  chrome.storage.local.set({ draft: Object.fromEntries(fields.map((f) => [f, $(f).value])) });
}
for (const f of fields) $(f).addEventListener("input", check);
chrome.storage.local.get("draft").then(({ draft }) => {
  for (const f of fields) if (draft?.[f]) $(f).value = draft[f];
  check();
});

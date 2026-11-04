"use strict";
const { createClient, YouTubeApiError } = globalThis.TubeLensApi;
const { summarizeChannel, auditVideos, rankOutliers } = globalThis.TubeLensResearch;

const $ = (id) => document.getElementById(id);
const store = globalThis.chrome?.storage?.local;
const utcOffsetMinutes = -new Date().getTimezoneOffset();

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
const compact = (n) => (n == null ? "—" : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n));
const num = (n, d = 0) => (n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d }));
const date = (iso) => (iso ? new Date(iso).toLocaleDateString() : "—");
const ratioPill = (r) => (r == null ? "—" : el("span", { class: `pill ${r >= 3 ? "good" : r >= 1 ? "mid" : "bad"}` }, `${num(r, 2)}×`));
const scorePill = (s) => el("span", { class: `pill ${s >= 70 ? "good" : s >= 40 ? "mid" : "bad"}` }, String(s));
const stat = (label, value) => el("div", { class: "stat" }, el("b", {}, value), el("span", {}, label));
const videoCell = (v) => el("div", { class: "vid" },
  el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/mqdefault.jpg`, alt: "", loading: "lazy" }),
  el("div", {}, el("a", { href: v.url, target: "_blank", rel: "noopener" }, v.title), v.channelTitle ? el("div", { class: "note" }, v.channelTitle) : null));

let client = null;
async function getClient() {
  if (client) return client;
  const { apiKey } = (await store?.get("apiKey")) ?? {};
  client = createClient({ key: apiKey }); // throws missing_key
  return client;
}
function showQuota() {
  if (client) $("quota").textContent = `Quota used this session: ${client.quotaUsed()} of 10,000 daily units`;
}

// Run a task for a form: disable its button, show progress, render errors in place.
async function task(form, out, fn) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  out.replaceChildren(el("p", { class: "note" }, "Loading…"));
  try {
    out.replaceChildren(await fn());
  } catch (err) {
    if (err instanceof YouTubeApiError && err.code === "missing_key") $("no-key").hidden = false;
    out.replaceChildren(el("p", { class: "error" }, err?.message ?? String(err)));
  } finally {
    button.disabled = false;
    showQuota();
  }
}

// Tabs
for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll("[role=tab]")) {
      t.setAttribute("aria-selected", String(t === tab));
      $(t.dataset.tab).hidden = t !== tab;
    }
    if (tab.dataset.tab === "competitors") renderCompetitors(false);
  });
}

// ---- Channel report ----
function channelReport(s, audit) {
  const fmt = s.formats;
  const list = (rows) => el("ul", { class: "plain" }, rows.map(([a, b]) => el("li", {}, el("span", {}, a), el("span", {}, b))));
  const videoTable = (rows, extraHead, extraCell) => el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Video"), el("th", { class: "num" }, "Views"), el("th", { class: "num" }, "Published"), el("th", { class: "num" }, extraHead))),
    el("tbody", {}, rows.map((v) => el("tr", {}, el("td", {}, videoCell(v)), el("td", { class: "num" }, compact(v.views)), el("td", { class: "num" }, date(v.publishedAt)), el("td", { class: "num" }, extraCell(v)))))));

  return el("div", {},
    el("h2", {}, el("a", { href: s.channel.url, target: "_blank", rel: "noopener" }, s.channel.title), " ", el("span", { class: "note" }, s.channel.handle ?? "")),
    el("div", { class: "grid" },
      stat("Subscribers", compact(s.channel.subscribers)),
      stat("Median views / video", compact(s.medianViews)),
      stat("Views per subscriber", s.medianViewsPerSubscriber == null ? "—" : `${num(s.medianViewsPerSubscriber * 100, 1)}%`),
      stat("Uploads / week", num(s.uploadsPerWeek, 1)),
      stat("Median engagement", s.medianEngagementRate == null ? "—" : `${num(s.medianEngagementRate, 2)}%`),
      stat("Avg SEO score", audit.averageScore == null ? "—" : num(audit.averageScore, 0))),
    el("div", { class: "cards" },
      el("div", { class: "card" }, el("h3", {}, "Best days to post (your time)"),
        list(s.bestDays.map((d) => [d.label, `${compact(d.medianViews)} median · ${d.videos} videos`]))),
      el("div", { class: "card" }, el("h3", {}, "Best hours to post (your time)"),
        list(s.bestHours.map((h) => [h.label, `${compact(h.medianViews)} median · ${h.videos} videos`]))),
      el("div", { class: "card" }, el("h3", {}, "Format"), list([
        ["Likely Shorts (≤3 min)", `${fmt.likelyShorts.videos} videos · ${compact(fmt.likelyShorts.medianViews)} median`],
        ["Long-form", `${fmt.longForm.videos} videos · ${compact(fmt.longForm.medianViews)} median`]])),
      el("div", { class: "card" }, el("h3", {}, "Most common SEO issues"),
        list(audit.commonIssues.slice(0, 5).map((i) => [i.label, `${i.share}% of videos`])))),
    el("h3", {}, "Outliers (≥ 2× the channel median)"),
    s.outliers.length ? videoTable(s.outliers, "Outlier", (v) => ratioPill(v.outlierRatio)) : el("p", { class: "note" }, "No video reached 2× the median in this sample."),
    el("h3", { style: "margin-top:14px" }, "Underperformers (≤ 0.5× median)"),
    s.underperformers.length ? videoTable(s.underperformers, "Ratio", (v) => ratioPill(v.outlierRatio)) : el("p", { class: "note" }, "None in this sample."),
    el("h3", { style: "margin-top:14px" }, "Lowest SEO scores"),
    videoTable(audit.lowest, "SEO", (v) => scorePill(v.seoScore)),
    el("p", { class: "note" }, `Sample: ${s.sample.videos} uploads (${s.sample.matureVideos} at least 7 days old), ${date(s.sample.from)} – ${date(s.sample.to)}. ${s.notes[1]}`));
}

$("channel-form").addEventListener("submit", (e) => {
  e.preventDefault();
  task(e.currentTarget, $("channel-out"), async () => {
    const c = await getClient();
    const ch = await c.resolveChannel($("channel-input").value);
    const uploads = await c.recentUploads(ch, Number($("channel-count").value));
    return channelReport(summarizeChannel(ch, uploads, { utcOffsetMinutes }), auditVideos(uploads));
  });
});

// ---- Competitors ----
async function loadTracked() {
  const { competitors } = (await store?.get("competitors")) ?? {};
  return Array.isArray(competitors) ? competitors : [];
}
const saveTracked = (list) => store?.set({ competitors: list });

async function renderCompetitors(refresh) {
  const out = $("comp-out");
  const tracked = await loadTracked();
  if (tracked.length === 0) {
    out.replaceChildren(el("p", { class: "note" }, "Add your own channel and a few competitors to compare them."));
    return;
  }
  if (!refresh && tracked.every((t) => t.summary)) return out.replaceChildren(competitorTable(tracked));
  await task($("comp-form"), out, async () => {
    const c = await getClient();
    for (const t of tracked) {
      if (t.summary && !refresh) continue;
      const ch = await c.resolveChannel(t.channelId);
      const s = summarizeChannel(ch, await c.recentUploads(ch, 25), { utcOffsetMinutes });
      t.summary = {
        title: s.channel.title, handle: s.channel.handle, url: s.channel.url, subscribers: s.channel.subscribers,
        medianViews: s.medianViews, viewsPerSub: s.medianViewsPerSubscriber, uploadsPerWeek: s.uploadsPerWeek,
        engagement: s.medianEngagementRate, bestDay: s.bestDays[0]?.label ?? null, topOutlier: s.outliers[0] ?? null,
        updatedAt: new Date().toISOString(),
      };
    }
    await saveTracked(tracked);
    return competitorTable(tracked);
  });
}

function competitorTable(tracked) {
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Channel", "Subscribers", "Median views", "Views/sub", "Uploads/wk", "Engagement", "Best day", "Top outlier", ""].map((h, i) =>
      el("th", { class: i > 0 && i < 6 ? "num" : null }, h)))),
    el("tbody", {}, tracked.map((t, i) => {
      const s = t.summary ?? {};
      return el("tr", {},
        el("td", {}, el("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title ?? t.channelId), el("div", { class: "note" }, s.handle ?? "")),
        el("td", { class: "num" }, compact(s.subscribers)),
        el("td", { class: "num" }, compact(s.medianViews)),
        el("td", { class: "num" }, s.viewsPerSub == null ? "—" : `${num(s.viewsPerSub * 100, 1)}%`),
        el("td", { class: "num" }, num(s.uploadsPerWeek, 1)),
        el("td", { class: "num" }, s.engagement == null ? "—" : `${num(s.engagement, 2)}%`),
        el("td", {}, s.bestDay ?? "—"),
        el("td", {}, s.topOutlier ? el("span", {}, ratioPill(s.topOutlier.outlierRatio), " ", el("a", { href: s.topOutlier.url, target: "_blank", rel: "noopener" }, s.topOutlier.title)) : "—"),
        el("td", {}, el("button", { class: "x", title: "Stop tracking", "aria-label": `Stop tracking ${s.title ?? ""}`, onclick: async () => {
          const list = await loadTracked();
          list.splice(i, 1);
          await saveTracked(list);
          renderCompetitors(false);
        } }, "✕")));
    }))));
}

$("comp-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  task(form, $("comp-out"), async () => {
    const c = await getClient();
    const ch = await c.resolveChannel($("comp-input").value);
    const list = await loadTracked();
    if (!list.some((t) => t.channelId === ch.channelId)) list.push({ channelId: ch.channelId });
    await saveTracked(list);
    $("comp-input").value = "";
    return el("p", { class: "note" }, `Added ${ch.title}.`);
  }).then(() => renderCompetitors(false));
});
$("comp-refresh").addEventListener("click", () => renderCompetitors(true));

// ---- Outlier finder ----
let outlierRows = [];
let outlierSort = { key: "outlierRatio", dir: -1 };

function outlierTable() {
  const cols = [
    ["Video", null], ["Outlier", "outlierRatio"], ["Views", "views"], ["Views/day", "viewsPerDay"],
    ["Views/sub", "viewsPerSubscriber"], ["Subscribers", "channelSubscribers"], ["Engagement", "engagementRate"], ["Published", "publishedAt"],
  ];
  const { key, dir } = outlierSort;
  const val = (r) => (key === "publishedAt" ? Date.parse(r.publishedAt) : r[key]);
  const rows = [...outlierRows].sort((a, b) => ((val(b) ?? -Infinity) - (val(a) ?? -Infinity)) * -dir);
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, cols.map(([label, k]) => el("th", {
      class: k ? "num" : null, "data-sort": k ?? null, "aria-sort": k === key ? (dir < 0 ? "descending" : "ascending") : null,
      onclick: k ? () => { outlierSort = { key: k, dir: outlierSort.key === k ? -outlierSort.dir : -1 }; $("out-out").replaceChildren(outlierTable()); } : null,
    }, label, k === key ? (dir < 0 ? " ↓" : " ↑") : "")))),
    el("tbody", {}, rows.map((r) => el("tr", {},
      el("td", {}, videoCell(r)),
      el("td", { class: "num" }, ratioPill(r.outlierRatio)),
      el("td", { class: "num" }, compact(r.views)),
      el("td", { class: "num" }, compact(r.viewsPerDay)),
      el("td", { class: "num" }, r.viewsPerSubscriber == null ? "—" : `${num(r.viewsPerSubscriber, 2)}×`),
      el("td", { class: "num" }, compact(r.channelSubscribers)),
      el("td", { class: "num" }, r.engagementRate == null ? "—" : `${num(r.engagementRate, 2)}%`),
      el("td", { class: "num" }, date(r.publishedAt)))))));
}

$("out-form").addEventListener("submit", (e) => {
  e.preventDefault();
  task(e.currentTarget, $("out-out"), async () => {
    const c = await getClient();
    const days = Number($("out-days").value);
    const videos = await c.searchVideos({
      query: $("out-query").value.trim(),
      max: Number($("out-count").value),
      publishedAfter: days ? new Date(Date.now() - days * 86400000).toISOString() : undefined,
      videoDuration: $("out-duration").value === "any" ? undefined : $("out-duration").value,
    });
    outlierRows = rankOutliers(videos, await c.channels(videos.map((v) => v.channelId)));
    outlierSort = { key: "outlierRatio", dir: -1 };
    return outlierRows.length ? outlierTable() : el("p", { class: "note" }, "No videos found.");
  });
});

// Open on a tab/channel from the URL, e.g. research.html?channel=@handle
const params = new URLSearchParams(location.search);
if (params.get("channel")) {
  $("channel-input").value = params.get("channel");
  $("channel-form").requestSubmit();
}
store?.get("apiKey").then(({ apiKey }) => { if (!apiKey) $("no-key").hidden = false; });

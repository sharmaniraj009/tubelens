"use strict";
const P = globalThis.TubeLensPlanner;
const Clips = globalThis.TubeLensClips;
const { createClient, YouTubeApiError } = globalThis.TubeLensApi;
const { summarizeChannel } = globalThis.TubeLensResearch;

const store = chrome.storage.local;
const $ = (id) => document.getElementById(id);
const utcOffsetMinutes = -new Date().getTimezoneOffset();
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};
const compact = (n) => (n == null ? "—" : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n));
const dayLabel = (iso, opts = { weekday: "short", day: "numeric", month: "short" }) => P.parseDate(iso)?.toLocaleDateString(undefined, opts) ?? "";
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

const DEFAULTS = { weeks: 4, shortsPerWeek: 2, longDays: [2], longTime: "17:00", shortTime: "12:00" };
let plan = { items: [], settings: {} };
const settings = () => ({ ...DEFAULTS, ...plan.settings });
let shown = new Date(new Date().getFullYear(), new Date().getMonth(), 1); // month on screen

async function loadPlan() {
  const { plan: saved } = await store.get("plan");
  plan = { items: Array.isArray(saved?.items) ? saved.items : [], settings: saved?.settings ?? {} };
}
const savePlan = () => store.set({ plan });

// Feedback in the header, optionally with one action such as Undo.
function say(text, action) {
  $("status").replaceChildren(text, action ? el("button", { type: "button", onclick: action.run }, action.label) : "");
  clearTimeout(say.timer);
  say.timer = setTimeout(() => $("status").replaceChildren(), action ? 8000 : 4000);
}

// ---- Tabs ----

function showTab(name) {
  for (const t of document.querySelectorAll("[role=tab]")) {
    t.setAttribute("aria-selected", String(t.dataset.tab === name));
    $(t.dataset.tab).hidden = t.dataset.tab !== name;
  }
  if (name === "shorts") renderShorts();
}
for (const tab of document.querySelectorAll("[role=tab]")) tab.addEventListener("click", () => showTab(tab.dataset.tab));

// ---- Calendar ----

function chip(item) {
  const { done, total } = P.progress(item);
  return el("button", {
    type: "button", class: `chip ${item.type}${item.status === "published" ? " published" : ""}`, draggable: "true",
    title: `${P.TYPES[item.type]}: ${item.title || "Untitled"} · ${capital(item.status)} · checklist ${done}/${total}`,
    ondragstart: (e) => e.dataTransfer.setData("text/plain", item.id),
    onclick: (e) => { e.stopPropagation(); openEditor(item); },
  }, item.time ? el("span", { class: "time" }, item.time) : null, item.title || P.TYPES[item.type]);
}

function renderMonth() {
  const year = shown.getFullYear(), month = shown.getMonth();
  $("month-label").textContent = shown.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first weeks
  const weeks = Math.ceil((lead + new Date(year, month + 1, 0).getDate()) / 7);
  const start = P.addDays(first, -lead);
  const today = P.isoDate(new Date());
  const byDate = new Map();
  for (const it of P.sortItems(plan.items)) if (it.date) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it]);

  const cells = MONDAY_FIRST.map((d) => el("div", { class: "dow" }, P.addDays(start, (d + 6) % 7).toLocaleDateString(undefined, { weekday: "short" })));
  for (let i = 0; i < weeks * 7; i++) {
    const day = P.addDays(start, i), iso = P.isoDate(day);
    const cls = ["day", day.getMonth() !== month && "out", iso < today && "past", iso === today && "today"].filter(Boolean).join(" ");
    cells.push(el("div", {
      class: cls, "data-date": iso, title: `Plan an upload on ${dayLabel(iso)}`,
      onclick: () => openEditor(P.newItem({ date: iso, time: settings().longTime })),
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("drop"); },
      ondragleave: (e) => e.currentTarget.classList.remove("drop"),
      ondrop: (e) => { e.preventDefault(); moveItem(e.dataTransfer.getData("text/plain"), iso); },
    }, el("span", { class: "num" }, String(day.getDate())), (byDate.get(iso) ?? []).map(chip)));
  }
  $("month").replaceChildren(...cells);
}

async function moveItem(id, date) {
  const item = plan.items.find((i) => i.id === id);
  if (!item || item.date === date) return renderMonth();
  const from = item.date;
  Object.assign(item, { date, updatedAt: Date.now() });
  await savePlan();
  renderAll();
  say(`Moved “${item.title || P.TYPES[item.type]}” to ${dayLabel(date)}.`, { label: "Undo", run: async () => {
    item.date = from;
    await savePlan();
    renderAll();
  } });
}

function listRow(item) {
  const { done, total } = P.progress(item);
  return el("div", { class: "item" },
    el("span", { class: "when" }, item.date ? `${dayLabel(item.date)}${item.time ? ` ${item.time}` : ""}` : "No date"),
    el("span", { class: `type ${item.type}` }, P.TYPES[item.type]),
    el("button", { type: "button", class: "title", onclick: () => openEditor(item) }, item.title || "Untitled"),
    el("span", { class: "meta" }, `${capital(item.status)} · ${done}/${total}`));
}

function renderLists() {
  const today = P.isoDate(new Date()), until = P.isoDate(P.addDays(new Date(), 14));
  const soon = P.sortItems(plan.items).filter((i) => i.date && i.date >= today && i.date <= until);
  $("upcoming").replaceChildren(soon.length
    ? el("div", { class: "list" }, soon.map(listRow))
    : el("p", { class: "note" }, "Nothing planned for the next two weeks. Fill the calendar, or click a day to add an upload."));
  const ideas = plan.items.filter((i) => !i.date);
  $("ideas").replaceChildren(ideas.length
    ? el("div", { class: "list" }, ideas.map(listRow))
    : el("p", { class: "note" }, "Keep video ideas here: add an upload and leave the date empty."));
}

function renderFillForm() {
  const s = settings();
  $("fill-days").replaceChildren(...MONDAY_FIRST.map((d) => el("label", {},
    el("input", { type: "checkbox", value: String(d), checked: s.longDays.includes(d) }),
    P.WEEKDAYS[d].slice(0, 3))));
  $("fill-long-time").value = s.longTime;
  $("fill-short-time").value = s.shortTime;
  $("fill-shorts").value = String(s.shortsPerWeek);
  $("fill-weeks").value = String(s.weeks);
}

function renderAll() {
  renderMonth();
  renderLists();
  renderShortsCount();
}

$("prev").addEventListener("click", () => { shown = new Date(shown.getFullYear(), shown.getMonth() - 1, 1); renderMonth(); });
$("next").addEventListener("click", () => { shown = new Date(shown.getFullYear(), shown.getMonth() + 1, 1); renderMonth(); });
$("today").addEventListener("click", () => { shown = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderMonth(); });
$("add").addEventListener("click", () => openEditor(P.newItem({ date: P.nextFreeDate(plan.items, { type: "long" }), time: settings().longTime })));

$("fill-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const longDays = [...$("fill-days").querySelectorAll("input:checked")].map((i) => Number(i.value));
  const s = { weeks: Number($("fill-weeks").value), shortsPerWeek: Number($("fill-shorts").value), longDays,
    longTime: $("fill-long-time").value || DEFAULTS.longTime, shortTime: $("fill-short-time").value || DEFAULTS.shortTime };
  plan.settings = { ...plan.settings, ...s };
  const added = [];
  for (const slot of P.planSchedule({ ...s, longPerWeek: longDays.length })) {
    if (plan.items.some((i) => i.date === slot.date && i.type === slot.type)) continue;
    const item = P.newItem({ ...slot, title: slot.type === "short" ? "New Short" : "New video" });
    plan.items.push(item);
    added.push(item.id);
  }
  await savePlan();
  renderAll();
  if (!added.length) return say("Those days are already planned.");
  say(`Added ${added.length} upload slots over ${s.weeks} weeks. Click one to name it.`, { label: "Undo", run: async () => {
    plan.items = plan.items.filter((i) => !added.includes(i.id));
    await savePlan();
    renderAll();
    say("Removed them.");
  } });
});

$("ics").addEventListener("click", () => {
  const dated = plan.items.filter((i) => i.date);
  if (!dated.length) return say("Nothing with a date to export yet.");
  const url = URL.createObjectURL(new Blob([P.toICS(dated, { watchUrl: Clips.watchUrl })], { type: "text/calendar" }));
  el("a", { href: url, download: "tubelens-uploads.ics" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  say(`Exported ${dated.length} uploads. Open the file to add them to your calendar.`);
});

// ---- Editor ----

let editing = null; // { item, isNew, checks }

function renderChecks() {
  const type = $("f-type").value;
  const list = P.checklist(type);
  const phases = [...new Set(list.map((c) => c.phase))];
  $("f-checks").replaceChildren(...phases.map((phase) => el("div", {},
    el("div", { class: "phase" }, phase),
    list.filter((c) => c.phase === phase).map((c) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: Boolean(editing.checks[c.id]), onchange: (e) => {
        editing.checks[c.id] = e.target.checked;
        renderProgress();
      } }),
      el("span", {}, c.label))))));
  renderProgress();
}
const renderProgress = () => {
  const { done, total } = P.progress({ type: $("f-type").value, checks: editing.checks });
  $("f-progress").textContent = `${done} of ${total}`;
};

function openEditor(item) {
  const isNew = !plan.items.some((i) => i.id === item.id);
  editing = { item, isNew, checks: { ...item.checks } };
  $("editor-title").textContent = isNew ? "Plan an upload" : "Edit upload";
  $("f-title").value = item.title;
  $("f-type").replaceChildren(...Object.entries(P.TYPES).map(([v, label]) => el("option", { value: v, selected: v === item.type }, label)));
  $("f-status").replaceChildren(...P.STATUSES.map((s) => el("option", { value: s, selected: s === item.status }, capital(s))));
  $("f-date").value = item.date ?? "";
  $("f-time").value = item.time ?? "";
  $("f-notes").value = item.notes ?? "";
  $("f-clip").hidden = !item.clip;
  if (item.clip) {
    $("f-clip").replaceChildren(`Clip ${Clips.rangeLabel(item.clip)} of “${item.clip.videoTitle || item.clip.videoId}” · `,
      el("a", { href: Clips.watchUrl(item.clip.videoId, item.clip.start), target: "_blank", rel: "noopener" }, "Open the moment"));
  }
  $("f-delete").hidden = isNew;
  renderChecks();
  $("editor").showModal();
  $("f-title").focus();
}

$("f-type").addEventListener("change", renderChecks);
$("f-cancel").addEventListener("click", () => $("editor").close());
$("editor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { item, isNew, checks } = editing;
  Object.assign(item, {
    title: $("f-title").value.trim(), type: $("f-type").value, status: $("f-status").value,
    date: $("f-date").value || null, time: $("f-time").value, notes: $("f-notes").value, checks, updatedAt: Date.now(),
  });
  if (isNew) plan.items.push(item);
  await savePlan();
  $("editor").close();
  if (item.date) {
    const d = P.parseDate(item.date);
    shown = new Date(d.getFullYear(), d.getMonth(), 1);
  }
  renderAll();
  say(isNew ? `Planned “${item.title || P.TYPES[item.type]}”${item.date ? ` for ${dayLabel(item.date)}` : ""}.` : "Saved.");
});
$("f-delete").addEventListener("click", async () => {
  const { item } = editing;
  const index = plan.items.findIndex((i) => i.id === item.id);
  if (index < 0) return $("editor").close();
  plan.items.splice(index, 1);
  await savePlan();
  $("editor").close();
  renderAll();
  say(`Deleted “${item.title || P.TYPES[item.type]}”.`, { label: "Undo", run: async () => {
    plan.items.splice(index, 0, item);
    await savePlan();
    renderAll();
  } });
});

// ---- Strategy ----

const stat = (label, value) => el("div", { class: "stat" }, el("b", {}, value), el("span", {}, label));

function heatTable(grid) {
  const blocks = grid.cells.filter((c) => c.day === 0);
  const tint = (r) => (r >= 1 ? `color-mix(in srgb, var(--good) ${Math.round(Math.min(1, r - 1) * 55 + 12)}%, transparent)`
    : `color-mix(in srgb, var(--bad) ${Math.round(Math.min(1, 1 - r) * 45 + 8)}%, transparent)`);
  return el("div", { class: "table-wrap" }, el("table", { class: "heat" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), blocks.map((b) => el("th", {}, `${String(b.startHour).padStart(2, "0")}–${String(b.endHour).padStart(2, "0")}`)))),
    el("tbody", {}, MONDAY_FIRST.map((day) => el("tr", {},
      el("th", {}, P.WEEKDAYS[day].slice(0, 3)),
      grid.cells.filter((c) => c.day === day).map((c) => c.videos
        ? el("td", { style: `background:${tint(c.ratio)}`, title: `${c.label}: ${c.videos} upload${c.videos === 1 ? "" : "s"}, median ${compact(c.medianViews)} views` }, `${c.ratio}×`)
        : el("td", { class: "empty" }, "·")))))));
}

function useBestDays(r) {
  const days = r.slots.length ? r.slots.map((s) => s.day) : r.bestDays.map((d) => Number(d.key));
  plan.settings = { ...plan.settings, longDays: [...new Set(days)].slice(0, 2),
    ...(r.slots[0] ? { longTime: `${String(r.slots[0].startHour).padStart(2, "0")}:00` } : {}) };
  savePlan();
  renderFillForm();
  showTab("calendar");
  $("fill-form").scrollIntoView({ behavior: "smooth", block: "center" });
  say("Your best days and time are filled in. Choose how many Shorts and weeks, then Fill calendar.");
}

function strategyView(r) {
  const c = r.cadence ?? {};
  const days = (n) => (n == null ? "—" : `${n} day${n === 1 ? "" : "s"}`);
  const slotList = r.slots.length
    ? r.slots.map((s) => el("li", {}, el("span", {}, s.label), el("span", {}, `${s.ratio}× median · ${s.videos} uploads`)))
    : r.bestDays.map((d) => el("li", {}, el("span", {}, d.label), el("span", {}, `${compact(d.medianViews)} median · ${d.videos} uploads`)));
  return el("div", {},
    el("h2", {}, el("a", { href: r.channel.url, target: "_blank", rel: "noopener" }, r.channel.title), " ",
      el("span", { class: "note" }, `analysed ${new Date(r.updatedAt).toLocaleString()}`)),
    el("div", { class: "grid" },
      stat("Uploads a week", c.perWeek == null ? "—" : String(c.perWeek)),
      stat("Usual gap", days(c.medianGapDays)),
      stat("Longest gap", days(c.longestGapDays)),
      stat("Since the last upload", days(c.daysSinceLast)),
      stat("Rhythm", c.consistency ? capital(c.consistency) : "—"),
      stat("Shorts share", c.shortsShare == null ? "—" : `${c.shortsShare}%`)),
    el("div", { class: "cards" },
      el("div", { class: "card" }, el("h3", {}, "What to do next"), el("ul", { class: "tips" }, r.tips.map((t) => el("li", {}, t)))),
      el("div", { class: "card" }, el("h3", {}, r.slots.length ? "Best times to post (your time zone)" : "Best days to post (your time zone)"),
        slotList.length ? el("ul", { class: "plain" }, slotList) : el("p", { class: "note" }, "Not enough uploads older than a week to compare times yet."),
        slotList.length ? el("p", {}, el("button", { type: "button", onclick: () => useBestDays(r) }, "Use these in the calendar")) : null)),
    el("h3", {}, "When your uploads do best"),
    heatTable(r.grid),
    el("p", { class: "note" }, `Each cell compares the median views of uploads posted at that time with your channel's median (${compact(r.grid.baseline)}). `
      + `Based on ${r.grid.videos} uploads at least a week old, in your time zone. A cell with one or two uploads is only a hint.`));
}

$("channel-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.currentTarget.querySelector("button[type=submit]");
  const out = $("strategy-out");
  button.disabled = true;
  out.replaceChildren(el("p", { class: "note" }, "Analysing your recent uploads…"));
  try {
    const { apiKey } = await store.get("apiKey");
    const client = createClient({ key: apiKey });
    const channel = await client.resolveChannel($("channel-input").value);
    const uploads = await client.recentUploads(channel, 100);
    const summary = summarizeChannel(channel, uploads, { utcOffsetMinutes });
    const grid = P.postingGrid(uploads, { utcOffsetMinutes });
    const slots = P.bestSlots(grid);
    const cadence = P.cadence(uploads);
    const result = {
      channel: { channelId: channel.channelId, title: channel.title, url: summary.channel.url },
      updatedAt: Date.now(), grid, slots, cadence, bestDays: summary.bestDays,
      tips: P.recommendations({ cadence, slots, formats: summary.formats }),
    };
    await store.set({ myChannel: $("channel-input").value.trim(), planStrategy: result });
    out.replaceChildren(strategyView(result));
  } catch (err) {
    if (err instanceof YouTubeApiError && err.code === "missing_key") $("no-key").hidden = false;
    out.replaceChildren(el("p", { class: "error" }, err?.message ?? String(err)));
  } finally {
    button.disabled = false;
  }
});

// ---- Shorts from clips ----

async function savedVideos() {
  const all = await store.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith("clip:") && Array.isArray(v?.clips) && v.clips.length)
    .map(([, v]) => v)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function renderShortsCount() {
  const planned = new Set(plan.items.map((i) => i.clipId).filter(Boolean));
  const open = (await savedVideos()).reduce((n, v) => n + v.clips.filter((c) => !planned.has(c.id)).length, 0);
  $("shorts-count").textContent = open ? String(open) : "";
}

async function planClips(pairs) {
  const added = [];
  for (const { video, clip } of pairs) {
    if (plan.items.some((i) => i.clipId === clip.id)) continue;
    const item = P.shortFromClip(plan.items, clip, video, { time: settings().shortTime });
    plan.items.push(item);
    added.push(item);
  }
  if (!added.length) return;
  await savePlan();
  renderAll();
  renderShorts();
  say(added.length === 1 ? `Planned as a Short on ${dayLabel(added[0].date)}.` : `Planned ${added.length} Shorts, starting ${dayLabel(added[0].date)}.`);
}

async function renderShorts() {
  const videos = await savedVideos();
  const plannedBy = new Map(plan.items.filter((i) => i.clipId).map((i) => [i.clipId, i]));
  const open = videos.flatMap((video) => video.clips.filter((clip) => !plannedBy.has(clip.id)).map((clip) => ({ video, clip })));
  if (!videos.length) {
    return $("shorts-out").replaceChildren(el("div", { class: "card empty-state" },
      el("b", {}, "No saved clips yet."),
      el("ol", {},
        el("li", {}, "Open one of your videos on YouTube."),
        el("li", {}, "In the TubeLens panel, open Clips and save the suggested moments, or drag across the timeline."),
        el("li", {}, "Come back here and plan them as Shorts."))));
  }
  $("shorts-out").replaceChildren(
    open.length > 1 ? el("p", {}, el("button", { type: "button", class: "primary", onclick: () => planClips(open) }, `Plan all ${open.length} as Shorts`)) : "",
    ...videos.map((video) => el("div", { class: "card clipvid" },
      el("h3", {}, el("a", { href: Clips.watchUrl(video.videoId, 0), target: "_blank", rel: "noopener" }, video.title || video.videoId)),
      el("div", { class: "list" }, video.clips.map((clip) => {
        const item = plannedBy.get(clip.id);
        return el("div", { class: "item" },
          el("a", { class: "when", href: Clips.watchUrl(video.videoId, clip.start), target: "_blank", rel: "noopener", title: "Open the video at this moment" }, Clips.rangeLabel(clip)),
          el("span", { class: "title" }, clip.note || `${Math.round(clip.end - clip.start)}s clip`),
          item
            ? el("button", { type: "button", onclick: () => openEditor(item) }, item.date ? `Planned for ${dayLabel(item.date)}` : "Planned")
            : el("button", { type: "button", onclick: () => planClips([{ video, clip }]) }, "Plan as Short"));
      })))));
}

// ---- Start ----

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.plan && JSON.stringify(changes.plan.newValue?.items ?? []) !== JSON.stringify(plan.items)) {
    loadPlan().then(renderAll);
  }
  if (Object.keys(changes).some((k) => k.startsWith("clip:"))) {
    renderShortsCount();
    if (!$("shorts").hidden) renderShorts();
  }
});

(async () => {
  await loadPlan();
  renderFillForm();
  renderAll();
  const { myChannel, planStrategy, apiKey } = await store.get(["myChannel", "planStrategy", "apiKey"]);
  if (myChannel) $("channel-input").value = myChannel;
  if (planStrategy?.grid) $("strategy-out").replaceChildren(strategyView(planStrategy));
  if (!apiKey) $("no-key").hidden = false;
  const tab = new URLSearchParams(location.search).get("tab");
  if (["calendar", "strategy", "shorts"].includes(tab)) showTab(tab);
})();

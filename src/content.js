// TubeLens panel on YouTube watch and Shorts pages: Overview, SEO, Tags and Clips tabs.
(function () {
  "use strict";
  const { score, videoStats, cleanTags } = globalThis.TubeLensSEO;
  const { parseWatchPage, videoIdFromUrl, extractJsonAfter } = globalThis.TubeLensYouTube;
  const Clips = globalThis.TubeLensClips;

  const HOST_ID = "tubelens-host";
  const PREFS_KEY = "panelPrefs";
  const TABS = ["overview", "seo", "tags", "clips"];
  const clipKey = (videoId) => `clip:${videoId}`;
  const t = Clips.formatTime;

  let currentId = null;
  let loadToken = 0;
  let prefs = { tab: "overview", collapsed: false };
  // The video on screen, kept across re-renders so drafts and inputs survive.
  let state = null;
  let message = null; // shown instead of the tabs while loading or on errors
  // Elements that follow playback or show feedback; rebuilt on every render.
  let live = {};
  let preview = null; // {start, end} while a clip preview plays

  // ---- Helpers ----

  const fmt = (n, digits = 0) =>
    n == null || !Number.isFinite(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
  const compact = (n) =>
    n == null ? "—" : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
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
  const svg = (tag, attrs = {}, ...kids) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid) node.append(kid);
    return node;
  };
  const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // chrome.* calls throw once the extension is reloaded under an open tab.
  const STALE = "TubeLens was updated. Reload this page to keep using it.";
  const storage = {
    async get(key) { try { return (await chrome.storage.local.get(key))[key]; } catch { return undefined; } },
    async set(key, value) { try { await chrome.storage.local.set({ [key]: value }); return true; } catch { return false; } },
    async remove(key) { try { await chrome.storage.local.remove(key); return true; } catch { return false; } },
  };
  const savePrefs = () => storage.set(PREFS_KEY, prefs);
  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => { void chrome.runtime.lastError; resolve(reply); });
    } catch {
      resolve({ ok: false, error: STALE });
    }
  });

  function playerVideo() {
    if (location.pathname.startsWith("/shorts/"))
      return document.querySelector("ytd-reel-video-renderer[is-active] video") ?? document.querySelector("#shorts-player video") ?? document.querySelector("video");
    return document.querySelector("video.html5-main-video") ?? document.querySelector("#movie_player video") ?? document.querySelector("video");
  }
  const currentTime = () => playerVideo()?.currentTime ?? 0;

  // ---- Styles ----

  const STYLE = `
    :host { all: initial; }
    .card { font: 13px/1.4 Roboto, Arial, sans-serif; color: var(--fg); background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 0 0 12px; }
    .card { --fg:#0f0f0f; --muted:#606060; --bg:#fff; --line:#e5e5e5; --chip:#f2f2f2; --good:#1a7f37; --mid:#b26b00; --bad:#c62828; --accent:#3d5afe; }
    .card.dark { --fg:#f1f1f1; --muted:#aaa; --bg:#181818; --line:#303030; --chip:#272727; --good:#5fd38d; --mid:#f0b552; --bad:#ff6b6b; --accent:#8c9eff; }
    header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    h2 { font-size:15px; margin:0; } h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px; }
    button { font:inherit; color:inherit; background:var(--chip); border:0; border-radius:8px; padding:4px 10px; cursor:pointer; }
    button:hover:not(:disabled) { filter:brightness(.95); }
    button:disabled { opacity:.5; cursor:default; }
    button:focus-visible, input:focus-visible, svg:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
    button.primary { background:var(--accent); color:#fff; }
    button.link { background:none; padding:0; color:var(--accent); text-decoration:underline; }
    .card.dark button.primary { color:#111; }
    nav.tabs { display:flex; gap:2px; margin:10px 0 0; border-bottom:1px solid var(--line); }
    nav.tabs button { background:none; border-radius:8px 8px 0 0; padding:6px 10px; color:var(--muted); border-bottom:2px solid transparent; }
    nav.tabs button[aria-selected="true"] { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
    nav.tabs .count { font-weight:400; color:var(--muted); margin-left:4px; font-size:11px; }
    .score { font-size:28px; font-weight:700; } .good{color:var(--good)} .mid{color:var(--mid)} .bad{color:var(--bad)}
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; }
    .stat { background:var(--chip); border-radius:8px; padding:6px 8px; } .stat b { display:block; font-size:15px; }
    .stat span { color:var(--muted); font-size:11px; }
    .chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:10px; } .chip { background:var(--chip); border-radius:999px; padding:2px 8px; }
    ul { list-style:none; padding:0; margin:0; } li { display:flex; gap:6px; padding:3px 0; }
    li .why { color:var(--muted); margin-left:auto; white-space:nowrap; padding-left:8px; }
    input { font:inherit; color:inherit; background:var(--chip); border:1px solid var(--line); border-radius:8px; padding:4px 8px; flex:1; min-width:0; }
    .row { display:flex; gap:6px; align-items:center; } .note { color:var(--muted); font-size:11px; margin-top:6px; }
    .actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .status { min-height:15px; margin-top:4px; }
    .status:empty { min-height:0; margin:0; }
    .body[hidden] { display:none; }
    .timeline { margin-top:10px; }
    .timeline svg { display:block; width:100%; height:56px; background:var(--chip); border-radius:8px; cursor:pointer; }
    .heat { fill:var(--accent); fill-opacity:.3; stroke:var(--accent); stroke-width:1.5; vector-effect:non-scaling-stroke; }
    .sugg { fill:var(--mid); }
    .saved { fill:var(--good); }
    .draft { fill:var(--accent); fill-opacity:.25; }
    .playhead { stroke:var(--fg); stroke-width:1.5; vector-effect:non-scaling-stroke; }
    .axis { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; margin-top:2px; }
    .key { display:inline-block; width:10px; height:4px; border-radius:2px; margin:0 3px 2px 6px; vertical-align:middle; }
    .sugg-key { background:var(--mid); } .saved-key { background:var(--good); }
    .clip { display:flex; align-items:center; gap:6px; padding:4px 0; border-top:1px solid var(--line); }
    .clip:first-child { border-top:0; }
    .clip .range { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
    .clip .meta { color:var(--muted); font-size:11px; white-space:nowrap; }
    .clip .label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .icon { padding:4px 8px; }
    .marker { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .marker .wide { grid-column:1 / -1; }
    .marker .now { margin:0 0 0 auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
    kbd { white-space:nowrap; font:11px ui-monospace, monospace; background:var(--chip); border:1px solid var(--line); border-radius:4px; padding:0 4px; }`;

  // ---- Mounting ----

  function hostElement() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.attachShadow({ mode: "open" });
    }
    // Docked in the right column when YouTube has rendered it; floating until then (and on Shorts).
    const anchor = document.querySelector("#secondary-inner") ?? document.querySelector("#secondary");
    if (anchor) {
      host.removeAttribute("style");
      if (host.parentElement !== anchor) anchor.prepend(host);
    } else if (!host.isConnected) {
      Object.assign(host.style, { position: "fixed", right: "16px", bottom: "16px", width: "380px",
        maxHeight: "75vh", overflow: "auto", zIndex: 9999 });
      document.body.append(host);
    }
    return host;
  }

  const isDark = () => document.documentElement.hasAttribute("dark");

  function render() {
    const host = hostElement();
    live = {};
    const content = state
      ? card(tabBar(), live.status = el("div", { class: "note status", role: "status", "aria-live": "polite" }, state.status ?? ""), tabBody())
      : card(el("div", { class: message?.cls ?? "note" }, message?.text ?? ""));
    host.shadowRoot.replaceChildren(el("style", {}, STYLE), content);
    tick();
  }

  function showMessage(text, cls) {
    state = null;
    message = { text, cls };
    render();
  }

  function card(...body) {
    const bodyEl = el("div", { class: "body" }, ...body);
    bodyEl.hidden = prefs.collapsed;
    const toggle = el("button", { "aria-expanded": String(!prefs.collapsed), onclick: () => {
      prefs.collapsed = !prefs.collapsed;
      savePrefs();
      render();
    } }, prefs.collapsed ? "Show" : "Hide");
    return el("div", { class: `card${isDark() ? " dark" : ""}` }, el("header", {}, el("h2", {}, "TubeLens"), toggle), bodyEl);
  }

  // Short-lived feedback under the tabs, optionally with one action (e.g. Undo).
  function flash(text, action) {
    if (!state) return;
    state.status = text;
    if (live.status) {
      live.status.replaceChildren(text, action ? " " : "", action ? el("button", { class: "link", onclick: action.run }, action.label) : "");
    }
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      if (!state) return;
      state.status = "";
      live.status?.replaceChildren();
    }, action ? 6000 : 3000);
  }

  function copy(text, done) {
    navigator.clipboard.writeText(text).then(() => flash(done), () => flash("Couldn't copy. Click the page once, then try again."));
  }

  // ---- Tabs ----

  function setTab(tab) {
    prefs.tab = tab;
    prefs.collapsed = false;
    savePrefs();
    render();
  }

  function tabBar() {
    const counts = { seo: state.seoScore, tags: state.tags.length, clips: state.saved.length || null };
    const names = { overview: "Overview", seo: "SEO", tags: "Tags", clips: "Clips" };
    return el("nav", { class: "tabs", role: "tablist", "aria-label": "TubeLens sections" }, TABS.map((tab) => {
      const count = counts[tab] == null ? null : el("span", { class: "count" }, String(counts[tab]));
      if (tab === "seo") live.seoCount = count;
      return el("button", { role: "tab", "aria-selected": String(prefs.tab === tab), onclick: () => setTab(tab) }, names[tab], count);
    }));
  }

  function tabBody() {
    const body = { overview: overviewTab, seo: seoTab, tags: tagsTab, clips: clipsTab }[prefs.tab] ?? overviewTab;
    return el("div", { role: "tabpanel" }, body());
  }

  function overviewTab() {
    const { video, extra } = state;
    const derived = videoStats({ views: video.views, likes: extra?.likes ?? null, comments: extra?.comments ?? null, publishedAt: video.publishedAt });
    const stat = (label, value) => el("div", { class: "stat" }, el("b", {}, value), el("span", {}, label));
    const openThumb = (image) =>
      ask({ type: "openThumbnail", image, title: video.title, videoId: video.videoId }).then((r) => {
        if (!r?.ok) flash(`Couldn't open the thumbnail maker: ${r?.error ?? "no response"}`);
      });
    return el("div", {},
      el("div", { class: "actions" },
        el("button", { class: "primary", onclick: () => {
          try {
            openThumb(captureFrame());
          } catch (err) {
            flash(err.message);
          }
        } }, "Thumbnail from this frame"),
        el("button", { onclick: () => openThumb(`https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/maxresdefault.jpg`) }, "Edit thumbnail"),
        el("button", { onclick: () => setTab("clips") }, "Find clips"),
        video.channelId ? el("button", { onclick: () => ask({ type: "openResearch", channel: video.channelId }) }, "Channel report") : null),
      el("div", { class: "grid" },
        stat("Views", compact(video.views)),
        stat("Views / hour", fmt(derived.viewsPerHour, 1)),
        stat("Published", video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : "—"),
        stat("Length", video.lengthSeconds ? t(video.lengthSeconds) : "—"),
        stat("Likes", compact(extra?.likes ?? null)),
        stat("Comments", compact(extra?.comments ?? null)),
        stat("Engagement", derived.engagementRate == null ? "—" : `${fmt(derived.engagementRate, 2)}%`),
        stat("Subscribers", compact(extra?.subscribers ?? null)),
        stat("Category", video.category ?? "—")),
      extra && !extra.available
        ? el("div", { class: "note" }, "Likes, comments and subscribers need a free API key. ",
            el("button", { class: "link", onclick: () => ask({ type: "openOptions" }) }, "Add one (2 minutes)"))
        : null,
      extra?.error ? el("div", { class: "note bad" }, `Data API: ${extra.error}`) : null);
  }

  function seoTab() {
    const { video, tags } = state;
    const band = (s) => (s >= 70 ? "good" : s >= 40 ? "mid" : "bad");
    const scoreBox = el("div");
    const kw = el("input", { placeholder: "Target keyword", "aria-label": "Target keyword" });
    kw.value = state.keyword;
    const draw = () => {
      state.keyword = kw.value;
      const result = score({ ...video, tags, keyword: kw.value });
      state.seoScore = result.score;
      if (live.seoCount) live.seoCount.textContent = String(result.score);
      kw.placeholder = result.keyword ? `Target keyword (default: ${result.keyword})` : "Target keyword";
      const failed = result.checks.filter((c) => !c.pass), passed = result.checks.filter((c) => c.pass);
      const row = (c) => el("li", {}, el("span", { class: c.pass ? "good" : "bad" }, c.pass ? "✓" : "✗"), el("span", {}, `${c.label} (${c.weight})`), el("span", { class: "why" }, c.detail));
      scoreBox.replaceChildren(
        el("div", { class: "row" }, el("span", { class: `score ${band(result.score)}` }, String(result.score)), el("span", {}, "/ 100 SEO score")),
        failed.length ? el("h3", {}, `To fix (${failed.length})`) : null,
        el("ul", {}, failed.map(row)),
        el("h3", {}, `Passing (${passed.length})`),
        el("ul", {}, passed.map(row)));
    };
    kw.addEventListener("input", draw);
    draw();
    return el("div", {},
      el("div", { class: "row", style: "margin:10px 0 8px" }, kw),
      scoreBox,
      el("div", { class: "note" }, "Score is TubeLens's own transparent checklist, not YouTube's ranking."));
  }

  function tagsTab() {
    const { tags } = state;
    if (!tags.length) return el("div", { class: "note" }, "This video has no public tags.");
    return el("div", {},
      el("div", { class: "chips" }, tags.map((tag) => el("span", { class: "chip" }, tag))),
      el("div", { class: "actions" },
        el("button", { class: "primary", onclick: () => copy(tags.join(", "), `Copied ${tags.length} tags.`) }, "Copy tags"),
        el("button", { onclick: () => copy(tags.join("\n"), "Copied, one tag per line.") }, "Copy one per line")));
  }

  // ---- Clips ----

  function clipsTab() {
    const { video, heatmap, suggestions, saved } = state;
    const total = video.lengthSeconds;
    if (!total) return el("div", { class: "note" }, "Clips need a video with a fixed length, so they don't work on live streams.");
    return el("div", {},
      timeline(total),
      el("div", { class: "note" }, heatmap.length
        ? "The curve shows how often viewers replay each moment (YouTube's “Most replayed”). Click anywhere to jump there."
        : "YouTube hasn't published “Most replayed” data for this video (it needs enough views). You can still mark clips yourself."),
      suggestions.length ? el("h3", {}, "Suggested clips") : null,
      suggestions.length ? el("div", {}, suggestions.map(suggestionRow)) : null,
      markerBox(),
      el("h3", {}, `Saved clips (${saved.length})`),
      saved.length
        ? el("div", {}, saved.map(savedRow))
        : el("div", { class: "note" }, "Nothing saved yet. Save a suggestion, or mark a start and end above."),
      saved.length ? el("div", { class: "actions" },
        el("button", { onclick: () => copy(Clips.clipsAsText(saved, video.videoId), `Copied ${saved.length} clip${saved.length === 1 ? "" : "s"} with links.`) }, "Copy with links"),
        el("button", { onclick: copyChapters }, "Copy as chapters")) : null,
      saved.length ? el("div", { class: "note" }, "All your clips, from every video, are in the TubeLens toolbar popup.") : null);
  }

  function timeline(total) {
    const W = 1000, H = 56;
    const x = (s) => ((Math.min(Math.max(s, 0), total) / total) * W).toFixed(1);
    const width = (a, b) => Math.max(3, x(b) - x(a)).toFixed(1);
    const tip = (text) => svg("title", {}, text);
    const kids = state.suggestions.map((c) =>
      svg("rect", { class: "sugg", x: x(c.start), y: 0, width: width(c.start, c.end), height: 4 }, tip(`Suggested ${Clips.rangeLabel(c)}`)));
    if (state.heatmap.length) {
      const pts = state.heatmap.map((m) => `${x(m.start + m.duration / 2)},${(H - 3 - m.intensity * (H - 10)).toFixed(1)}`);
      kids.push(svg("path", { class: "heat", d: `M0,${H} L${pts.join(" L")} L${W},${H} Z` }));
    }
    for (const c of state.saved)
      kids.push(svg("rect", { class: "saved", x: x(c.start), y: H - 6, width: width(c.start, c.end), height: 6 }, tip(`Saved ${Clips.rangeLabel(c)}`)));
    const d = state.draft;
    if (d.start != null) kids.push(svg("rect", { class: "draft", x: x(d.start), y: 0, width: width(d.start, d.end ?? d.start), height: H }));
    live.playhead = svg("line", { class: "playhead", x1: 0, x2: 0, y1: 0, y2: H });
    live.toX = x;
    kids.push(live.playhead);
    const jump = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      seek(((e.clientX - r.left) / r.width) * total);
    };
    const keys = (e) => {
      const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
      if (step) { e.preventDefault(); seek(currentTime() + step); }
    };
    return el("div", { class: "timeline" },
      svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", tabindex: "0", role: "img",
        "aria-label": "Video timeline. Click to jump; arrow keys move 5 seconds.", onclick: jump, onkeydown: keys }, kids),
      el("div", { class: "axis" }, el("span", {}, "0:00"),
        el("span", {}, el("i", { class: "key sugg-key" }), "suggested ", el("i", { class: "key saved-key" }), "saved"),
        el("span", {}, t(total))));
  }

  function suggestionRow(c) {
    const isSaved = state.saved.some((s) => s.start === c.start && s.end === c.end);
    return el("div", { class: "clip" },
      el("button", { class: "icon", title: "Preview this clip", "aria-label": `Preview ${Clips.rangeLabel(c)}`, onclick: () => playClip(c) }, "▶"),
      el("span", { class: "range" }, Clips.rangeLabel(c)),
      el("span", { class: "label meta" }, `${c.length}s · replay ${c.intensity}%`),
      el("button", { disabled: isSaved ? "" : null, onclick: () => saveClip({ start: c.start, end: c.end, note: "", source: "suggested" }) },
        isSaved ? "Saved" : "Save"));
  }

  function savedRow(c) {
    return el("div", { class: "clip" },
      el("button", { class: "icon", title: "Play this clip", "aria-label": `Play ${Clips.rangeLabel(c)}`, onclick: () => playClip(c) }, "▶"),
      el("span", { class: "range" }, Clips.rangeLabel(c)),
      el("span", { class: "label", title: c.note || "" }, c.note || el("span", { class: "meta" }, `${Math.round(c.end - c.start)}s`)),
      el("button", { class: "icon", title: "Copy a link that starts at this clip", onclick: () => copy(Clips.shareUrl(state.video.videoId, c.start), "Link copied.") }, "Link"),
      el("button", { class: "icon", title: "Delete clip", "aria-label": `Delete ${Clips.rangeLabel(c)}`, onclick: () => deleteClip(c.id) }, "✕"));
  }

  function markerBox() {
    const d = state.draft;
    const len = d.start != null && d.end != null ? d.end - d.start : null;
    const note = el("input", { placeholder: "Note (optional), e.g. best tip", "aria-label": "Clip note" });
    note.value = d.note;
    note.addEventListener("input", () => (d.note = note.value));
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveDraft(); }
    });
    live.now = el("span", { class: "note now" });
    return el("div", {},
      el("h3", {}, "Mark a clip"),
      el("div", { class: "marker" },
        el("button", { onclick: markStart, title: "Set the start to the current time (Alt+[)" }, d.start == null ? "Set start" : `Start ${t(d.start)}`),
        el("button", { onclick: markEnd, title: "Set the end to the current time (Alt+])" }, d.end == null ? "Set end" : `End ${t(d.end)}`),
        el("div", { class: "wide row" }, note),
        el("div", { class: "wide row" },
          el("button", { class: "primary", disabled: len >= 1 ? null : "", onclick: saveDraft, title: "Save (Alt+S)" }, len >= 1 ? `Save clip (${Math.round(len)}s)` : "Save clip"),
          el("button", { disabled: len >= 1 ? null : "", onclick: () => playClip(d) }, "Preview"),
          d.start != null || d.end != null ? el("button", { onclick: clearDraft }, "Clear") : null,
          live.now)),
      len > 180 ? el("div", { class: "note mid" }, "This is longer than 3 minutes, the Shorts limit.") : null,
      el("div", { class: "note" }, "Play to the moment you want, then set the start and the end. Keys: ",
        el("kbd", {}, "Alt+["), " start, ", el("kbd", {}, "Alt+]"), " end, ", el("kbd", {}, "Alt+S"), " save."));
  }

  function seek(seconds, play = false) {
    const v = playerVideo();
    if (!v) return flash("Couldn't find the video player.");
    v.currentTime = Math.max(0, Math.min(seconds, state?.video.lengthSeconds ?? seconds));
    if (play) v.play()?.catch?.(() => {});
    tick();
  }

  function playClip(c) {
    preview = { start: c.start, end: c.end };
    seek(c.start, true);
  }

  function markStart() {
    const at = Math.floor(currentTime());
    const d = state.draft;
    d.start = at;
    if (d.end != null && d.end <= at) d.end = null;
    render();
    flash(`Start set at ${t(at)}. Now play to where the clip should end and set the end.`);
  }

  function markEnd() {
    const at = Math.ceil(currentTime());
    const d = state.draft;
    const guessed = d.start == null;
    const start = d.start ?? Math.max(0, at - 30);
    if (at <= start) return flash("The end has to come after the start. Play a little further, then set the end.");
    d.start = start;
    d.end = at;
    render();
    flash(guessed ? `End set at ${t(at)}. The start was set 30 seconds earlier; change it if you need to.` : `End set at ${t(at)}.`);
  }

  function clearDraft() {
    state.draft = { start: null, end: null, note: "" };
    render();
  }

  async function persist() {
    const { video, saved } = state;
    const key = clipKey(video.videoId);
    return saved.length
      ? storage.set(key, { videoId: video.videoId, title: video.title, channel: video.channelName,
          durationSeconds: video.lengthSeconds, updatedAt: Date.now(), clips: saved })
      : storage.remove(key);
  }

  async function saveClip({ start, end, note, source }) {
    if (!(end - start >= 1)) return flash("The end has to come after the start.");
    state.saved = [...state.saved, { id: newId(), start, end, note: (note ?? "").trim(), source, createdAt: Date.now() }]
      .sort((a, b) => a.start - b.start);
    const ok = await persist();
    render();
    flash(ok ? `Saved ${t(start)}–${t(end)}.` : STALE);
  }

  async function saveDraft() {
    const d = state.draft;
    if (d.start == null || d.end == null) return flash("Set a start and an end first.");
    if (d.end - d.start < 1) return flash("The end has to come after the start.");
    state.draft = { start: null, end: null, note: "" };
    await saveClip({ start: d.start, end: d.end, note: d.note, source: "manual" });
  }

  async function deleteClip(id) {
    const removed = state.saved.find((c) => c.id === id);
    if (!removed) return;
    const videoId = state.video.videoId;
    state.saved = state.saved.filter((c) => c.id !== id);
    await persist();
    render();
    flash(`Deleted ${Clips.rangeLabel(removed)}.`, { label: "Undo", run: async () => {
      if (state?.video.videoId !== videoId || state.saved.some((c) => c.id === id)) return;
      state.saved = [...state.saved, removed].sort((a, b) => a.start - b.start);
      await persist();
      render();
      flash("Restored.");
    } });
  }

  function copyChapters() {
    const text = Clips.clipsAsChapters(state.saved);
    const lines = text.split("\n").length;
    copy(text, lines >= 3 ? "Chapters copied. Paste them into your description." : `Copied ${lines} chapter${lines === 1 ? "" : "s"}. YouTube needs at least 3 to show chapters.`);
  }

  // Follow playback: the "Now" label, the playhead, and stopping a preview at its end.
  function tick() {
    if (!state) return;
    const v = playerVideo();
    if (!v) return;
    const now = v.currentTime;
    if (live.now) live.now.textContent = `Now ${t(now)}`;
    if (live.playhead && live.toX) {
      const px = live.toX(now);
      live.playhead.setAttribute("x1", px);
      live.playhead.setAttribute("x2", px);
    }
    if (preview) {
      if (now < preview.start - 1 || now > preview.end + 2) preview = null; // the viewer jumped elsewhere
      else if (now >= preview.end) {
        v.pause();
        preview = null;
      }
    }
  }
  document.addEventListener("timeupdate", tick, true); // media events don't bubble, but capture sees them

  // Alt+[ / Alt+] / Alt+S mark and save clips from anywhere on the page.
  document.addEventListener("keydown", (e) => {
    if (!state?.video.lengthSeconds || !e.altKey || e.ctrlKey || e.metaKey) return;
    const action = { BracketLeft: markStart, BracketRight: markEnd, KeyS: saveDraft }[e.code];
    if (!action) return;
    const path = e.composedPath();
    const target = path[0];
    const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (typing && !path.some((n) => n.id === HOST_ID)) return; // leave YouTube's own text boxes alone
    e.preventDefault();
    e.stopPropagation();
    if (prefs.tab !== "clips" || prefs.collapsed) {
      prefs.tab = "clips";
      prefs.collapsed = false;
      savePrefs();
      render();
    }
    action();
  }, true);

  // Clips deleted from the popup (or another tab) disappear here too.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !state) return;
      const change = changes[clipKey(state.video.videoId)];
      if (!change) return;
      const clips = change.newValue?.clips ?? [];
      if (JSON.stringify(clips) === JSON.stringify(state.saved)) return;
      state.saved = clips;
      render();
    });
  } catch { /* extension reloaded */ }

  // Grab the playing frame at 1280×720 (letterboxed to 16:9) as a JPEG data URL.
  function captureFrame() {
    const video = playerVideo();
    if (!video || video.readyState < 2 || !video.videoWidth) throw new Error("Play or seek the video first, then capture a frame.");
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 1280, 720);
    const scale = Math.min(1280 / video.videoWidth, 720 / video.videoHeight);
    const w = video.videoWidth * scale, h = video.videoHeight * scale;
    ctx.drawImage(video, (1280 - w) / 2, (720 - h) / 2, w, h);
    try {
      return canvas.toDataURL("image/jpeg", 0.92);
    } catch {
      throw new Error("This video's frames can't be captured (protected content). Use 'Edit thumbnail' instead.");
    }
  }

  // ---- Loading ----

  async function load(videoId) {
    const token = ++loadToken;
    preview = null;
    showMessage("Loading video data…");
    try {
      // Shorts also have a /watch page, which carries the same player response.
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
      const html = await res.text();
      const video = parseWatchPage(html);
      if (token !== loadToken) return;
      if (!video) return showMessage("Couldn't read this video's details.");
      let heatmap = [];
      try {
        heatmap = Clips.heatmapFromInitialData(extractJsonAfter(html, "ytInitialData"), video.videoId);
      } catch { /* clips still work without it */ }
      const stored = await storage.get(clipKey(video.videoId));
      if (token !== loadToken) return;
      const tags = cleanTags(video.tags);
      state = {
        video, tags, extra: null, heatmap, keyword: "", status: "",
        seoScore: score({ ...video, tags }).score,
        suggestions: video.lengthSeconds ? Clips.suggestClips(heatmap, { durationSeconds: video.lengthSeconds, count: 5 }) : [],
        saved: Array.isArray(stored?.clips) ? stored.clips : [],
        draft: { start: null, end: null, note: "" },
      };
      message = null;
      render();
      const reply = await ask({ type: "dataApiStats", videoId: video.videoId, channelId: video.channelId });
      if (token !== loadToken || !state) return;
      state.extra = reply?.ok ? reply.data : { available: true, error: reply?.error ?? "no response" };
      if (prefs.tab === "overview") render(); // other tabs don't show these numbers; don't steal focus
    } catch (err) {
      if (token === loadToken) showMessage(`TubeLens error: ${err.message}`, "note bad");
    }
  }

  function onNavigate() {
    const id = videoIdFromUrl(location.href);
    if (!id) {
      currentId = null;
      state = null;
      document.getElementById(HOST_ID)?.remove();
      return;
    }
    if (id !== currentId) {
      currentId = id;
      load(id);
    } else {
      hostElement();
    }
  }

  // YouTube is a single-page app: react to its navigation event and URL changes.
  document.addEventListener("yt-navigate-finish", onNavigate);
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onNavigate();
    } else if (currentId && document.getElementById(HOST_ID)) {
      hostElement(); // dock once YouTube renders the right column
    }
  }, 1000);
  storage.get(PREFS_KEY).then((saved) => {
    if (saved && typeof saved === "object") prefs = { ...prefs, ...saved };
    if (!TABS.includes(prefs.tab)) prefs.tab = "overview";
    onNavigate();
  });
})();

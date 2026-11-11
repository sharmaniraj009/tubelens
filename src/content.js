// TubeLens panel on YouTube watch and Shorts pages: Overview, SEO, Tags, Clips and Engage tabs.
(function () {
  "use strict";
  const { score, videoStats, cleanTags } = globalThis.TubeLensSEO;
  const { parseWatchPage, videoIdFromUrl, extractJsonAfter } = globalThis.TubeLensYouTube;
  const Clips = globalThis.TubeLensClips;
  const Engage = globalThis.TubeLensEngage;
  const Planner = globalThis.TubeLensPlanner;

  const HOST_ID = "tubelens-host";
  const PREFS_KEY = "panelPrefs";
  const PLAN_KEY = "plan";
  const TABS = ["overview", "seo", "tags", "clips", "engage"];
  const QUICK_CLIP_SECONDS = 30;
  const clipKey = (videoId) => `clip:${videoId}`;
  const t = Clips.formatTime;
  const band = (s) => (s >= 70 ? "good" : s >= 40 ? "mid" : "bad");

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
  // Ads play in the same <video> element, so its time is the ad's while one runs.
  const adPlaying = () => Boolean(playerVideo()?.closest(".html5-video-player")?.classList.contains("ad-showing"));
  const AD_WAIT = "An ad is playing. Try again once the video is back.";
  const isTyping = (node) => node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));

  // YouTube's player shortcuts (k, j, l, f, space, digits…) listen on the page, and keys pressed
  // inside the panel reach them too. Keep the keys a panel control uses inside the panel.
  function keepKeysInPanel(e) {
    if (isTyping(e.composedPath()[0]) || /^( |Enter|Arrow\w+)$/.test(e.key)) e.stopPropagation();
  }
  // After a mouse click on a playback control, give the keyboard back to the player so space
  // pauses the video instead of pressing the control again.
  const releaseFocus = (e) => { if (e?.detail) e.currentTarget?.blur?.(); };

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
    nav.tabs { display:flex; flex-wrap:wrap; gap:0; margin:10px 0 0; border-bottom:1px solid var(--line); }
    nav.tabs button { background:none; border-radius:8px 8px 0 0; padding:6px 8px; color:var(--muted); border-bottom:2px solid transparent; white-space:nowrap; }
    nav.tabs button[aria-selected="true"] { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
    nav.tabs .count { font-weight:400; color:var(--muted); margin-left:4px; font-size:11px; }
    .score { font-size:28px; font-weight:700; } .good{color:var(--good)} .mid{color:var(--mid)} .bad{color:var(--bad)}
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; }
    .stat { background:var(--chip); border-radius:8px; padding:6px 8px; } .stat b { display:block; font-size:15px; }
    .stat span { color:var(--muted); font-size:11px; }
    .chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:10px; } .chip { background:var(--chip); border-radius:999px; padding:2px 8px; }
    ul { list-style:none; padding:0; margin:0; } li { display:flex; gap:6px; padding:3px 0; }
    li .why { color:var(--muted); margin-left:auto; padding-left:8px; text-align:right; max-width:45%; overflow-wrap:anywhere; }
    input { font:inherit; color:inherit; background:var(--chip); border:1px solid var(--line); border-radius:8px; padding:4px 8px; flex:1; min-width:0; }
    .row { display:flex; gap:6px; align-items:center; } .row.wrap { flex-wrap:wrap; } .note { color:var(--muted); font-size:11px; margin-top:6px; }
    .actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    .status { min-height:15px; margin-top:4px; }
    .status:empty { min-height:0; margin:0; }
    .body[hidden] { display:none; }
    .timeline { margin-top:10px; position:relative; }
    .timeline svg { display:block; width:100%; height:56px; background:var(--chip); border-radius:8px; cursor:crosshair; touch-action:none; user-select:none; }
    .hover { position:absolute; top:6px; transform:translateX(-50%); background:var(--fg); color:var(--bg); font-size:11px;
      padding:1px 6px; border-radius:4px; pointer-events:none; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .hover[hidden] { display:none; }
    .sel { fill:var(--accent); fill-opacity:.35; }
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
    .clip .icon { padding:3px 7px; }
    .marker { display:grid; gap:6px; }
    .edge { display:flex; align-items:center; gap:6px; }
    .edge .name { width:34px; color:var(--muted); }
    .edge .time { min-width:44px; text-align:center; font-weight:600; font-variant-numeric:tabular-nums; }
    .edge .set { margin-left:auto; }
    .marker .now { margin:0 0 0 auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
    button[aria-pressed="true"] { background:var(--accent); color:#fff; }
    .card.dark button[aria-pressed="true"] { color:#111; }
    .quick { display:flex; align-items:center; gap:6px; margin-top:8px; }
    textarea { font:inherit; color:inherit; background:var(--chip); border:1px solid var(--line); border-radius:8px; padding:6px 8px;
      width:100%; box-sizing:border-box; resize:vertical; min-height:54px; }
    .box { border:1px solid var(--line); border-radius:8px; padding:8px; margin-top:6px; }
    .box .row { justify-content:space-between; margin-bottom:4px; }
    .reply { padding:6px 0; border-top:1px solid var(--line); }
    .reply:first-child { border-top:0; }
    .reply p { margin:0 0 2px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
    .reply a { color:var(--accent); }
    kbd { white-space:nowrap; font:11px ui-monospace, monospace; background:var(--chip); border:1px solid var(--line); border-radius:4px; padding:0 4px; }`;

  // ---- Mounting ----

  function hostElement() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.attachShadow({ mode: "open" });
      for (const type of ["keydown", "keypress", "keyup"]) host.addEventListener(type, keepKeysInPanel);
    }
    // Docked in the right column of a watch page once YouTube has rendered it; floating until
    // then and on Shorts. YouTube keeps the watch page in the DOM, hidden, while a Short plays.
    const shown = (selector) => [...document.querySelectorAll(selector)].find((n) => n.getClientRects().length);
    const anchor = location.pathname === "/watch" ? shown("#secondary-inner") ?? shown("#secondary") : null;
    if (anchor) {
      host.removeAttribute("style");
      if (host.parentElement !== anchor) anchor.prepend(host);
    } else if (host.parentElement !== document.body) {
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
    // "?" opens the Academy at the lesson for the tab on screen.
    const lesson = { overview: "start", seo: "seo", tags: "seo", clips: "find-clips", engage: "engage" }[prefs.tab] ?? "start";
    const help = el("button", { class: "icon", title: "How to use this (TubeLens Academy)", "aria-label": "Open the TubeLens Academy",
      onclick: () => ask({ type: "openAcademy", lesson }) }, "?");
    return el("div", { class: `card${isDark() ? " dark" : ""}` }, el("header", {}, el("h2", {}, "TubeLens"), el("div", { class: "row" }, help, toggle)), bodyEl);
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
    const counts = { seo: state.seoScore, tags: state.tags.length, clips: state.saved.length || null, engage: state.engageScore };
    const names = { overview: "Overview", seo: "SEO", tags: "Tags", clips: "Clips", engage: "Engage" };
    return el("nav", { class: "tabs", role: "tablist", "aria-label": "TubeLens sections" }, TABS.map((tab) => {
      const count = counts[tab] == null ? null : el("span", { class: "count" }, String(counts[tab]));
      if (tab === "seo") live.seoCount = count;
      return el("button", { role: "tab", "aria-selected": String(prefs.tab === tab), onclick: () => setTab(tab) }, names[tab], count);
    }));
  }

  function tabBody() {
    const body = { overview: overviewTab, seo: seoTab, tags: tagsTab, clips: clipsTab, engage: engageTab }[prefs.tab] ?? overviewTab;
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
        el("button", { onclick: () => setTab("engage") }, "Engagement"),
        video.channelId ? el("button", { onclick: () => ask({ type: "openResearch", channel: video.channelId }) }, "Channel report") : null,
        el("button", { onclick: () => ask({ type: "openPlanner" }) }, "Upload planner")),
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

  const emptyDraft = () => ({ start: null, end: null, note: "", editing: null });
  const dateLabel = (iso) => Planner.parseDate(iso)?.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) ?? iso;
  const openPlanner = { label: "Open planner", run: () => ask({ type: "openPlanner" }) };

  function clipsTab() {
    const { video, heatmap, suggestions, saved } = state;
    const total = video.lengthSeconds;
    if (!total) return el("div", { class: "note" }, "Clips need a video with a fixed length, so they don't work on live streams.");
    return el("div", {},
      timeline(total),
      el("div", { class: "note" }, heatmap.length
        ? "The curve shows how often viewers replay each moment (YouTube's “Most replayed”). Click to jump there; drag across it to select a clip."
        : "YouTube hasn't published “Most replayed” data for this video (it needs enough views). Drag across the timeline to select a clip, or mark one below."),
      el("div", { class: "quick" },
        el("button", { onclick: quickClip, title: `Save the ${QUICK_CLIP_SECONDS} seconds before the current time (Alt+C)` }, `Clip the last ${QUICK_CLIP_SECONDS}s`),
        el("span", { class: "note", style: "margin:0" }, el("kbd", {}, "Alt+C"), " right after a great moment")),
      suggestions.length ? el("h3", {}, "Suggested clips") : null,
      suggestions.length ? el("div", {}, suggestions.map(suggestionRow)) : null,
      heatmap.length && !suggestions.length
        ? el("div", { class: "note" }, "No moment stands out: viewers watch this video about evenly, so there's nothing to suggest. Mark clips yourself below.")
        : null,
      markerBox(),
      el("h3", {}, `Saved clips (${saved.length})`),
      saved.length
        ? el("div", {}, saved.map(savedRow))
        : el("div", { class: "note" }, "Nothing saved yet. Save a suggestion, drag across the timeline, or press Alt+C after a great moment."),
      saved.length ? el("div", { class: "actions" },
        el("button", { onclick: () => copy(Clips.clipsAsText(saved, video.videoId), `Copied ${saved.length} clip${saved.length === 1 ? "" : "s"} with links.`) }, "Copy with links"),
        el("button", { onclick: copyChapters }, "Copy as chapters"),
        el("button", { onclick: () => planShorts(saved), title: "Add every saved clip to the upload planner as a Short" }, "Plan all as Shorts")) : null,
      saved.length ? el("div", { class: "note" }, "All your clips, from every video, are in the TubeLens toolbar popup and the upload planner.") : null);
  }

  function timeline(total) {
    const W = 1000, H = 56;
    const x = (s) => ((Math.min(Math.max(s, 0), total) / total) * W).toFixed(1);
    const width = (a, b) => Math.max(3, x(b) - x(a)).toFixed(1);
    const tip = (text) => svg("title", {}, text);
    const kids = state.suggestions.map((c) =>
      svg("rect", { class: "sugg", x: x(c.start), y: 0, width: width(c.start, c.end), height: 4 }, tip(`Suggested ${Clips.rangeLabel(c)}`)));
    if (state.heatmap.length) {
      // Scaled to the hottest moment after the opening spike, which would flatten everything else.
      const peak = Clips.heatProfile(state.heatmap, { durationSeconds: total }).peak;
      const level = (m) => (peak > 0 ? Math.min(1, m.intensity / peak) : m.intensity);
      const pts = state.heatmap.map((m) => `${x(m.start + m.duration / 2)},${(H - 3 - level(m) * (H - 10)).toFixed(1)}`);
      kids.push(svg("path", { class: "heat", d: `M0,${H} L${pts.join(" L")} L${W},${H} Z` }));
    }
    for (const c of state.saved)
      kids.push(svg("rect", { class: "saved", x: x(c.start), y: H - 6, width: width(c.start, c.end), height: 6 }, tip(`Saved ${Clips.rangeLabel(c)}`)));
    const d = state.draft;
    if (d.start != null) kids.push(svg("rect", { class: "draft", x: x(d.start), y: 0, width: width(d.start, d.end ?? d.start), height: H }));
    const selection = svg("rect", { class: "sel", x: 0, y: 0, width: 0, height: H, visibility: "hidden" });
    live.playhead = svg("line", { class: "playhead", x1: 0, x2: 0, y1: 0, y2: H });
    live.toX = x;
    kids.push(selection, live.playhead);

    // Click to jump; drag to select a clip. A label follows the pointer with the time under it.
    const hover = el("div", { class: "hover", hidden: "" });
    const timeAt = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      return (Math.min(Math.max(e.clientX - r.left, 0), r.width) / r.width) * total;
    };
    let drag = null;
    const hideSelection = () => selection.setAttribute("visibility", "hidden");
    const down = (e) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      drag = { from: timeAt(e), x: e.clientX, moved: false };
    };
    const move = (e) => {
      const at = timeAt(e), r = e.currentTarget.getBoundingClientRect();
      hover.hidden = false;
      hover.style.left = `${Math.min(Math.max(e.clientX - r.left, 24), r.width - 24)}px`;
      if (drag && Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
      if (!drag?.moved) return void (hover.textContent = t(at));
      const a = Math.min(drag.from, at), b = Math.max(drag.from, at);
      hover.textContent = `${t(a)}–${t(b)} · ${Math.round(b - a)}s`;
      selection.setAttribute("x", x(a));
      selection.setAttribute("width", width(a, b));
      selection.setAttribute("visibility", "visible");
    };
    const up = (e) => {
      if (!drag) return;
      const { from, moved } = drag;
      drag = null;
      e.currentTarget.blur(); // leave space and the arrow keys to the player
      const at = timeAt(e);
      if (!moved) return void seek(at);
      hideSelection();
      const start = Math.floor(Math.min(from, at)), end = Math.ceil(Math.max(from, at));
      if (end - start < 1) return;
      state.draft = { ...state.draft, start, end };
      render();
      flash(`Selected ${t(start)}–${t(end)}. Preview it, nudge the edges, then save.`);
    };
    const keys = (e) => {
      const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
      if (step) { e.preventDefault(); seek(currentTime() + step); }
    };
    return el("div", { class: "timeline" },
      hover,
      svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", tabindex: "0", role: "img",
        "aria-label": "Video timeline. Click to jump, drag to select a clip; arrow keys move 5 seconds.",
        onpointerdown: down, onpointermove: move, onpointerup: up, onkeydown: keys,
        onpointercancel: () => { drag = null; hideSelection(); },
        onpointerleave: () => { if (!drag) hover.hidden = true; } }, kids),
      el("div", { class: "axis" }, el("span", {}, "0:00"),
        el("span", {}, el("i", { class: "key sugg-key" }), "suggested ", el("i", { class: "key saved-key" }), "saved"),
        el("span", {}, t(total))));
  }

  function suggestionRow(c) {
    const isSaved = state.saved.some((s) => s.start === c.start && s.end === c.end);
    return el("div", { class: "clip" },
      el("button", { class: "icon", title: "Preview this clip", "aria-label": `Preview ${Clips.rangeLabel(c)}`, onclick: (e) => playClip(c, e) }, "▶"),
      el("span", { class: "range" }, Clips.rangeLabel(c)),
      el("span", { class: "label meta", title: `Replayed ${c.lift}× as often as a typical moment of this video` }, `${c.length}s · ${c.lift}× typical`),
      el("button", { disabled: isSaved ? "" : null, onclick: () => saveClip({ start: c.start, end: c.end, note: "", source: "suggested" }) },
        isSaved ? "Saved" : "Save"));
  }

  function savedRow(c) {
    const planned = state.planned.has(c.id);
    const range = Clips.rangeLabel(c);
    return el("div", { class: "clip" },
      el("button", { class: "icon", title: "Play this clip", "aria-label": `Play ${range}`, onclick: (e) => playClip(c, e) }, "▶"),
      el("span", { class: "range" }, range),
      el("span", { class: "label", title: c.note || "" }, c.note || el("span", { class: "meta" }, `${Math.round(c.end - c.start)}s`)),
      el("button", { class: "icon", title: "Change this clip's start, end or note", "aria-label": `Edit ${range}`, onclick: () => editClip(c.id) }, "Edit"),
      el("button", { class: "icon", disabled: planned ? "" : null, "aria-label": `Plan ${range} as a Short`,
        title: planned ? "Already in the upload planner" : "Plan this clip as a Short in the upload planner", onclick: () => planShorts([c]) }, planned ? "Planned" : "Short"),
      el("button", { class: "icon", title: "Copy a link that starts at this clip", onclick: () => copy(Clips.shareUrl(state.video.videoId, c.start), "Link copied.") }, "Link"),
      el("button", { class: "icon", title: "Delete clip", "aria-label": `Delete ${range}`, onclick: () => deleteClip(c.id) }, "✕"));
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
    // One row per edge: nudge it a second at a time, or set it to the current time.
    const edge = (key, name, setNow, keys) => el("div", { class: "edge" },
      el("span", { class: "name" }, name),
      d[key] == null ? el("span", { class: "time meta" }, "—") : [
        el("button", { class: "icon", title: "1 second earlier (Shift-click: 5 seconds)", "aria-label": `${name} 1 second earlier`, onclick: (e) => nudge(key, e.shiftKey ? -5 : -1) }, "−1s"),
        el("span", { class: "time" }, t(d[key])),
        el("button", { class: "icon", title: "1 second later (Shift-click: 5 seconds)", "aria-label": `${name} 1 second later`, onclick: (e) => nudge(key, e.shiftKey ? 5 : 1) }, "+1s")],
      el("button", { class: "set", onclick: setNow, title: `Set the ${name.toLowerCase()} to the current time (${keys})` }, "Set to now"));
    return el("div", {},
      el("h3", {}, d.editing ? "Edit clip" : "Mark a clip"),
      el("div", { class: "marker" },
        edge("start", "Start", markStart, "Alt+["),
        edge("end", "End", markEnd, "Alt+]"),
        el("div", { class: "row" }, note),
        el("div", { class: "row wrap" },
          el("button", { class: "primary", disabled: len >= 1 ? null : "", onclick: saveDraft, title: "Save (Alt+S)" },
            len >= 1 ? `${d.editing ? "Update" : "Save"} clip (${Math.round(len)}s)` : "Save clip"),
          el("button", { disabled: len >= 1 ? null : "", onclick: (e) => playClip(d, e) }, "Preview"),
          el("button", { "aria-pressed": String(state.loop), title: "Repeat previews until you stop them", onclick: () => { state.loop = !state.loop; render(); } }, "Loop"),
          d.start != null || d.end != null ? el("button", { onclick: clearDraft }, d.editing ? "Cancel" : "Clear") : null,
          live.now)),
      len > 180 ? el("div", { class: "note mid" }, "This is longer than 3 minutes, the Shorts limit.") : null,
      el("div", { class: "note" }, "Drag across the timeline, or play to a moment and press Set to now. Keys: ",
        el("kbd", {}, "Alt+["), " start, ", el("kbd", {}, "Alt+]"), " end, ", el("kbd", {}, "Alt+S"), " save, ",
        el("kbd", {}, "Alt+C"), ` the last ${QUICK_CLIP_SECONDS}s.`));
  }

  function seek(seconds, play = false) {
    const v = playerVideo();
    if (!v || adPlaying()) {
      flash(v ? AD_WAIT : "Couldn't find the video player.");
      return false;
    }
    v.currentTime = Math.max(0, Math.min(seconds, state?.video.lengthSeconds ?? seconds));
    if (play) v.play()?.catch?.(() => {});
    tick();
    return true;
  }

  function playClip(c, e) {
    releaseFocus(e);
    preview = null; // so the seek can't trip an earlier preview's end
    if (seek(c.start, true)) preview = { start: c.start, end: c.end };
  }

  function markStart() {
    if (adPlaying()) return flash(AD_WAIT);
    const at = Math.floor(currentTime());
    const d = state.draft;
    d.start = at;
    if (d.end != null && d.end <= at) d.end = null;
    render();
    flash(`Start set at ${t(at)}. Now play to where the clip should end and set the end.`);
  }

  function markEnd() {
    if (adPlaying()) return flash(AD_WAIT);
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

  // Move one edge of the draft, then show it: jump to a new start, or play up to a new end.
  function nudge(key, delta) {
    const d = state.draft;
    const value = Math.min(Math.max(d[key] + delta, 0), state.video.lengthSeconds);
    if (key === "start" ? d.end != null && value > d.end - 1 : d.start != null && value < d.start + 1)
      return flash("A clip has to be at least 1 second long.");
    d[key] = value;
    render();
    if (key === "start") seek(value);
    else playClip({ start: Math.max(d.start ?? 0, value - 3), end: value });
  }

  // Save the stretch just watched, for when a great moment has already gone by.
  async function quickClip() {
    if (adPlaying()) return flash(AD_WAIT);
    const end = Math.ceil(currentTime());
    const start = Math.max(0, end - QUICK_CLIP_SECONDS);
    if (end - start < 1) return flash("Play a few seconds of the video first.");
    const clip = await saveClip({ start, end, note: "", source: "quick" });
    if (clip) flash(`Saved ${t(start)}–${t(end)}.`, { label: "Adjust", run: () => editClip(clip.id) });
  }

  function editClip(id) {
    const c = state.saved.find((s) => s.id === id);
    if (!c) return;
    state.draft = { start: c.start, end: c.end, note: c.note ?? "", editing: id };
    if (prefs.tab !== "clips") setTab("clips");
    else render();
    flash(`Editing ${Clips.rangeLabel(c)}. Nudge the edges or change the note, then update it.`);
  }

  function clearDraft() {
    state.draft = emptyDraft();
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

  const byStart = (a, b) => a.start - b.start;

  async function saveClip({ start, end, note, source }) {
    if (!(end - start >= 1)) return flash("The end has to come after the start.");
    const clip = { id: newId(), start, end, note: (note ?? "").trim(), source, createdAt: Date.now() };
    state.saved = [...state.saved, clip].sort(byStart);
    const ok = await persist();
    render();
    flash(ok ? `Saved ${t(start)}–${t(end)}.` : STALE);
    return ok ? clip : null;
  }

  async function saveDraft() {
    const d = state.draft;
    if (d.start == null || d.end == null) return flash("Set a start and an end first.");
    if (d.end - d.start < 1) return flash("The end has to come after the start.");
    state.draft = emptyDraft();
    if (!d.editing || !state.saved.some((c) => c.id === d.editing))
      return void (await saveClip({ start: d.start, end: d.end, note: d.note, source: "manual" }));
    state.saved = state.saved.map((c) => (c.id === d.editing ? { ...c, start: d.start, end: d.end, note: d.note.trim() } : c)).sort(byStart);
    const ok = await persist();
    render();
    flash(ok ? `Updated to ${t(d.start)}–${t(d.end)}.` : STALE);
  }

  async function deleteClip(id) {
    const removed = state.saved.find((c) => c.id === id);
    if (!removed) return;
    const videoId = state.video.videoId;
    state.saved = state.saved.filter((c) => c.id !== id);
    if (state.draft.editing === id) state.draft = emptyDraft();
    await persist();
    render();
    flash(`Deleted ${Clips.rangeLabel(removed)}.`, { label: "Undo", run: async () => {
      if (state?.video.videoId !== videoId || state.saved.some((c) => c.id === id)) return;
      state.saved = [...state.saved, removed].sort(byStart);
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

  // Add clips to the upload planner as Shorts, each on the next day with nothing planned.
  async function planShorts(list) {
    const { video } = state;
    const plan = (await storage.get(PLAN_KEY)) ?? {};
    const items = Array.isArray(plan.items) ? [...plan.items] : [];
    const added = [];
    for (const c of list) {
      if (items.some((i) => i.clipId === c.id)) continue;
      const item = Planner.shortFromClip(items, c, video, { time: plan.settings?.shortTime ?? "12:00" });
      items.push(item);
      added.push(item);
    }
    if (!added.length) return flash("Already in the upload planner.", openPlanner);
    if (!(await storage.set(PLAN_KEY, { ...plan, items }))) return flash(STALE);
    state.planned = new Set([...state.planned, ...added.map((i) => i.clipId)]);
    render();
    flash(added.length === 1 ? `Planned as a Short on ${dateLabel(added[0].date)}.` : `Planned ${added.length} Shorts, starting ${dateLabel(added[0].date)}.`, openPlanner);
  }

  // Follow playback: the "Now" label, the playhead, and stopping or looping a preview at its end.
  function tick() {
    if (!state) return;
    const v = playerVideo();
    if (!v || adPlaying()) return; // a preview carries on once the ad is over
    const now = v.currentTime;
    if (live.now) live.now.textContent = `Now ${t(now)}`;
    if (live.playhead && live.toX) {
      const px = live.toX(now);
      live.playhead.setAttribute("x1", px);
      live.playhead.setAttribute("x2", px);
    }
    if (preview) {
      if (now < preview.start - 1 || now > preview.end + 2) preview = null; // the viewer jumped elsewhere
      else if (now >= preview.end && state.loop) v.currentTime = preview.start;
      else if (now >= preview.end) {
        v.pause();
        preview = null;
      }
    }
  }
  document.addEventListener("timeupdate", tick, true); // media events don't bubble, but capture sees them

  // Alt+[ / Alt+] / Alt+S / Alt+C mark and save clips from anywhere on the page.
  document.addEventListener("keydown", (e) => {
    if (!state?.video.lengthSeconds || !e.altKey || e.ctrlKey || e.metaKey) return;
    const action = { BracketLeft: markStart, BracketRight: markEnd, KeyS: saveDraft, KeyC: quickClip }[e.code];
    if (!action) return;
    const path = e.composedPath();
    if (isTyping(path[0]) && !path.some((n) => n.id === HOST_ID)) return; // leave YouTube's own text boxes alone
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

  // ---- Engage ----

  function engageTab() {
    const { video, tags } = state;
    const result = Engage.engagementChecks(video);
    const failed = result.checks.filter((c) => !c.pass), passed = result.checks.filter((c) => c.pass);
    const row = (c) => el("li", { title: c.tip }, el("span", { class: c.pass ? "good" : "bad" }, c.pass ? "✓" : "✗"), el("span", {}, c.label), el("span", { class: "why" }, c.detail));
    const moments = state.saved.length ? state.saved : state.suggestions;
    return el("div", {},
      el("div", { class: "row", style: "margin-top:10px" }, el("span", { class: `score ${band(result.score)}` }, String(result.score)), el("span", {}, "/ 100 engagement checklist")),
      failed.length ? el("h3", {}, `To add (${failed.length})`) : null,
      el("ul", {}, failed.map(row)),
      passed.length ? el("h3", {}, `Done (${passed.length})`) : null,
      el("ul", {}, passed.map(row)),
      el("div", { class: "note" }, "What the title and description do to invite comments and keep people watching. TubeLens's own checklist, not YouTube's ranking."),
      el("h3", {}, "Pinned comment ideas"),
      el("div", { class: "note", style: "margin-top:0" }, "Edit one, post it under your video and pin it. A question gives viewers an easy first reply."),
      Engage.pinnedComments({ title: video.title, tags, description: video.description, moments }).map(draftBox),
      el("h3", {}, "Comments to answer"),
      repliesBox());
  }

  function draftBox(d) {
    const area = el("textarea", { "aria-label": d.label, rows: String(Math.min(6, d.text.split("\n").length + 1)) });
    area.value = d.text;
    return el("div", { class: "box" },
      el("div", { class: "row" }, el("b", {}, d.label),
        el("button", { class: "icon", onclick: () => copy(area.value, "Copied. Post it as a comment on your video, then pin it.") }, "Copy")),
      area);
  }

  function repliesBox() {
    const r = state.replies;
    if (!r) return el("div", {},
      el("div", { class: "note", style: "margin-top:0" }, "Answering early, questions first, keeps the conversation going and shows viewers you read them."),
      el("div", { class: "actions" }, el("button", { onclick: loadReplies }, "Find comments to answer"),
        el("span", { class: "note", style: "margin:0;align-self:center" }, "1 API unit")));
    if (r.loading) return el("div", { class: "note" }, "Loading comments…");
    if (r.needsKey) return el("div", { class: "note" }, "This needs a free YouTube API key. ", el("button", { class: "link", onclick: () => ask({ type: "openOptions" }) }, "Add one (2 minutes)"));
    if (r.error) return el("div", { class: "note bad" }, r.error, " ", el("button", { class: "link", onclick: loadReplies }, "Try again"));
    const q = r.result;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return el("div", {},
      el("div", { class: "note", style: "margin-top:0" }, r.note
        ?? `Of the top ${plural(q.total, "comment")}, ${q.unanswered} have no replies, including ${plural(q.unansweredQuestions, "question")}.`),
      q.queue.length
        ? el("div", {}, q.queue.map((c) => el("div", { class: "reply" },
            el("p", {}, c.text),
            el("div", { class: "note", style: "margin:0" }, c.question ? "Question · " : "", plural(c.likes, "like"), c.author ? ` · ${c.author}` : "",
              c.url ? [" · ", el("a", { href: c.url, target: "_blank", rel: "noopener" }, "Reply")] : null))))
        : el("div", { class: "note" }, r.note ? "" : "Every top comment already has a reply."),
      el("div", { class: "actions" }, el("button", { onclick: loadReplies }, "Refresh")));
  }

  async function loadReplies() {
    const videoId = state.video.videoId;
    state.replies = { loading: true };
    render();
    const reply = await ask({ type: "videoComments", videoId });
    if (state?.video.videoId !== videoId) return;
    if (!reply?.ok) state.replies = { error: `Couldn't load comments: ${reply?.error ?? "no response"}` };
    else if (!reply.data.available) state.replies = { needsKey: true };
    else state.replies = { result: Engage.replyQueue(reply.data.comments, { videoId, limit: 8 }), note: reply.data.note };
    if (prefs.tab === "engage") render();
  }

  // Clips deleted from the popup (or another tab), and Shorts planned elsewhere, show up here too.
  const plannedClipIds = (plan) => new Set((plan?.items ?? []).map((i) => i.clipId).filter(Boolean));
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !state) return;
      if (changes[PLAN_KEY]) {
        state.planned = plannedClipIds(changes[PLAN_KEY].newValue);
        if (prefs.tab === "clips") render();
      }
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
      const [stored, plan] = await Promise.all([storage.get(clipKey(video.videoId)), storage.get(PLAN_KEY)]);
      if (token !== loadToken) return;
      const tags = cleanTags(video.tags);
      state = {
        video, tags, extra: null, heatmap, keyword: "", status: "",
        seoScore: score({ ...video, tags }).score,
        engageScore: Engage.engagementChecks(video).score,
        replies: null, // comments to answer, loaded on request
        loop: false,
        suggestions: video.lengthSeconds ? Clips.suggestClips(heatmap, { durationSeconds: video.lengthSeconds, count: 5 }) : [],
        saved: Array.isArray(stored?.clips) ? stored.clips : [],
        planned: plannedClipIds(plan),
        draft: emptyDraft(),
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

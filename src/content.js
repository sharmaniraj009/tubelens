// TubeLens panel on YouTube watch and Shorts pages.
(function () {
  "use strict";
  const { score, videoStats, cleanTags } = globalThis.TubeLensSEO;
  const { parseWatchPage, videoIdFromUrl } = globalThis.TubeLensYouTube;

  const HOST_ID = "tubelens-host";
  let currentId = null;
  let loadToken = 0;

  const fmt = (n, digits = 0) =>
    n == null || !Number.isFinite(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
  const compact = (n) =>
    n == null ? "—" : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const duration = (s) => {
    if (s == null) return "—";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(sec).padStart(2, "0")}`;
  };
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  };

  const STYLE = `
    :host { all: initial; }
    .card { font: 13px/1.4 Roboto, Arial, sans-serif; color: var(--fg); background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 0 0 12px; }
    .card { --fg:#0f0f0f; --muted:#606060; --bg:#fff; --line:#e5e5e5; --chip:#f2f2f2; --good:#1a7f37; --mid:#b26b00; --bad:#c62828; --accent:#3d5afe; }
    .card.dark { --fg:#f1f1f1; --muted:#aaa; --bg:#181818; --line:#303030; --chip:#272727; --good:#5fd38d; --mid:#f0b552; --bad:#ff6b6b; --accent:#8c9eff; }
    header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    h2 { font-size:15px; margin:0; } h3 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px; }
    button { font:inherit; color:inherit; background:var(--chip); border:0; border-radius:8px; padding:4px 10px; cursor:pointer; }
    button:hover { filter:brightness(.95); }
    .score { font-size:28px; font-weight:700; } .good{color:var(--good)} .mid{color:var(--mid)} .bad{color:var(--bad)}
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:8px; }
    .stat { background:var(--chip); border-radius:8px; padding:6px 8px; } .stat b { display:block; font-size:15px; }
    .stat span { color:var(--muted); font-size:11px; }
    .chips { display:flex; flex-wrap:wrap; gap:4px; } .chip { background:var(--chip); border-radius:999px; padding:2px 8px; }
    ul { list-style:none; padding:0; margin:0; } li { display:flex; gap:6px; padding:3px 0; }
    li .why { color:var(--muted); margin-left:auto; white-space:nowrap; padding-left:8px; }
    input { font:inherit; color:inherit; background:var(--chip); border:1px solid var(--line); border-radius:8px; padding:4px 8px; flex:1; min-width:0; }
    .row { display:flex; gap:6px; align-items:center; } .note { color:var(--muted); font-size:11px; margin-top:6px; }
    .body[hidden] { display:none; }`;

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
      Object.assign(host.style, { position: "fixed", right: "16px", bottom: "16px", width: "360px",
        maxHeight: "70vh", overflow: "auto", zIndex: 9999 });
      document.body.append(host);
    }
    return host;
  }

  const isDark = () => document.documentElement.hasAttribute("dark");

  function render(content) {
    const host = hostElement();
    host.shadowRoot.replaceChildren(el("style", {}, STYLE), content);
  }

  function shell(...body) {
    const collapsed = sessionStorage.getItem("tubelens-collapsed") === "1";
    const bodyEl = el("div", { class: "body" }, ...body);
    bodyEl.hidden = collapsed;
    const toggle = el("button", {
      onclick: () => {
        bodyEl.hidden = !bodyEl.hidden;
        sessionStorage.setItem("tubelens-collapsed", bodyEl.hidden ? "1" : "0");
        toggle.textContent = bodyEl.hidden ? "Show" : "Hide";
      },
    }, collapsed ? "Show" : "Hide");
    return el("div", { class: `card${isDark() ? " dark" : ""}` }, el("header", {}, el("h2", {}, "TubeLens"), toggle), bodyEl);
  }

  const band = (s) => (s >= 70 ? "good" : s >= 40 ? "mid" : "bad");

  function copy(text, button) {
    navigator.clipboard.writeText(text).then(
      () => { button.textContent = "Copied"; setTimeout(() => (button.textContent = "Copy tags"), 1200); },
      () => { button.textContent = "Copy failed"; }
    );
  }

  function view(video, extra) {
    const tags = cleanTags(video.tags);
    const derived = videoStats({ views: video.views, likes: extra?.likes ?? null, comments: extra?.comments ?? null, publishedAt: video.publishedAt });

    const scoreBox = el("div");
    const kwInput = el("input", { placeholder: "Target keyword", "aria-label": "Target keyword" });
    const drawScore = () => {
      const result = score({ ...video, tags, keyword: kwInput.value });
      if (!kwInput.value) kwInput.placeholder = result.keyword ? `Target keyword (default: ${result.keyword})` : "Target keyword";
      scoreBox.replaceChildren(
        el("div", { class: "row" }, el("span", { class: `score ${band(result.score)}` }, String(result.score)), el("span", {}, "/ 100 SEO score")),
        el("ul", {}, result.checks.map((c) =>
          el("li", {}, el("span", { class: c.pass ? "good" : "bad" }, c.pass ? "✓" : "✗"), el("span", {}, `${c.label} (${c.weight})`), el("span", { class: "why" }, c.detail))))
      );
    };
    kwInput.addEventListener("input", drawScore);
    drawScore();

    const stat = (label, value) => el("div", { class: "stat" }, el("b", {}, value), el("span", {}, label));
    const published = video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : "—";
    const copyBtn = el("button", { onclick: (e) => copy(tags.join(", "), e.currentTarget) }, "Copy tags");
    const status = el("div", { class: "note" });
    const openThumb = (image) =>
      ask({ type: "openThumbnail", image, title: video.title, videoId: video.videoId }).then((r) => {
        status.textContent = r?.ok ? "" : `Couldn't open the thumbnail maker: ${r?.error ?? "no response"}`;
      });
    const tools = el("div", { class: "row", style: "flex-wrap:wrap;margin-top:10px" },
      el("button", { onclick: () => {
        try {
          openThumb(captureFrame());
        } catch (err) {
          status.textContent = err.message;
        }
      } }, "Thumbnail from this frame"),
      el("button", { onclick: () => openThumb(`https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/maxresdefault.jpg`) }, "Edit current thumbnail"),
      video.channelId ? el("button", { onclick: () => ask({ type: "openResearch", channel: video.channelId }) }, "Channel report") : null);

    return shell(
      el("div", { class: "grid" },
        stat("Views", compact(video.views)),
        stat("Views / hour", fmt(derived.viewsPerHour, 1)),
        stat("Published", published),
        stat("Length", duration(video.lengthSeconds)),
        stat("Likes", compact(extra?.likes ?? null)),
        stat("Comments", compact(extra?.comments ?? null)),
        stat("Engagement", derived.engagementRate == null ? "—" : `${fmt(derived.engagementRate, 2)}%`),
        stat("Subscribers", compact(extra?.subscribers ?? null)),
        stat("Category", video.category ?? "—")),
      extra && !extra.available ? el("div", { class: "note" }, extra.reason) : null,
      extra?.error ? el("div", { class: "note bad" }, `Data API: ${extra.error}`) : null,
      el("h3", {}, `Tags (${tags.length})`),
      tags.length ? el("div", { class: "chips" }, tags.map((t) => el("span", { class: "chip" }, t))) : el("div", { class: "note" }, "This video has no public tags."),
      tags.length ? el("div", { class: "row", style: "margin-top:6px" }, copyBtn) : null,
      el("h3", {}, "SEO check"),
      el("div", { class: "row", style: "margin-bottom:8px" }, kwInput),
      scoreBox,
      el("div", { class: "note" }, "Score is TubeLens's own transparent checklist, not YouTube's ranking."),
      tools,
      status
    );
  }

  // Grab the playing frame at 1280×720 (letterboxed to 16:9) as a JPEG data URL.
  function captureFrame() {
    const video = document.querySelector("video.html5-main-video, #movie_player video, video");
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
      throw new Error("This video's frames can't be captured (protected content). Use 'Edit current thumbnail' instead.");
    }
  }

  const ask = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

  async function load(videoId) {
    const token = ++loadToken;
    render(shell(el("div", { class: "note" }, "Loading video data…")));
    try {
      // Shorts also have a /watch page, which carries the same player response.
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
      const video = parseWatchPage(await res.text());
      if (token !== loadToken) return;
      if (!video) return render(shell(el("div", { class: "note" }, "Couldn't read this video's details.")));
      render(view(video, null));
      const reply = await ask({ type: "dataApiStats", videoId: video.videoId, channelId: video.channelId });
      if (token !== loadToken) return;
      render(view(video, reply?.ok ? reply.data : { available: true, error: reply?.error ?? "no response" }));
    } catch (err) {
      if (token === loadToken) render(shell(el("div", { class: "note bad" }, `TubeLens error: ${err.message}`)));
    }
  }

  function onNavigate() {
    const id = videoIdFromUrl(location.href);
    if (!id) {
      currentId = null;
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
  onNavigate();
})();

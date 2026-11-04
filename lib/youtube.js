// Parse public video facts out of a YouTube watch/shorts page's HTML.
(function (root) {
  "use strict";

  // Return the JSON object literal that follows `marker`, using a string-aware brace scan.
  function extractJsonAfter(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf("{", at + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  const toNumber = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

  function parseWatchPage(html) {
    const player = extractJsonAfter(html, "ytInitialPlayerResponse");
    const vd = player && player.videoDetails;
    if (!vd || !vd.videoId) return null;
    const mf = (player.microformat && player.microformat.playerMicroformatRenderer) || {};
    return {
      videoId: vd.videoId,
      title: vd.title ?? "",
      description: vd.shortDescription ?? "",
      tags: Array.isArray(vd.keywords) ? vd.keywords : [],
      views: toNumber(vd.viewCount),
      lengthSeconds: toNumber(vd.lengthSeconds),
      channelId: vd.channelId ?? null,
      channelName: vd.author ?? null,
      publishedAt: mf.publishDate || mf.uploadDate || null,
      category: mf.category ?? null,
      isLive: Boolean(vd.isLiveContent),
    };
  }

  // Video id from a /watch?v=, /shorts/ or youtu.be URL.
  function videoIdFromUrl(href) {
    try {
      const u = new URL(href);
      if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  root.TubeLensYouTube = { extractJsonAfter, parseWatchPage, videoIdFromUrl };
  if (typeof module === "object" && module.exports) module.exports = root.TubeLensYouTube;
})(typeof globalThis !== "undefined" ? globalThis : this);

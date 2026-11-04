// YouTube Data API v3 client shared by the extension and the MCP server.
// Quota costs (units/day, default 10,000): list calls 1 unit, search.list 100 units.
(function (root) {
  "use strict";

  const BASE = "https://www.googleapis.com/youtube/v3/";
  const TIMEOUT_MS = 20000;

  class YouTubeApiError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "YouTubeApiError";
      this.code = code; // missing_key | quota_exceeded | key_invalid | not_found | http | network
    }
  }

  const toNumber = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

  // ISO-8601 duration ("PT1H2M3S", "P1DT2H") to seconds; null when absent or unparseable.
  function parseIsoDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso ?? ""));
    if (!m || iso === "P" || iso === "PT") return null;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Math.round(Number(m[4] ?? 0));
  }

  function normalizeVideo(item) {
    const s = item.snippet ?? {};
    const st = item.statistics ?? {};
    const thumbs = s.thumbnails ?? {};
    return {
      videoId: item.id,
      title: s.title ?? "",
      description: s.description ?? "",
      tags: Array.isArray(s.tags) ? s.tags : [],
      channelId: s.channelId ?? null,
      channelTitle: s.channelTitle ?? null,
      publishedAt: s.publishedAt ?? null,
      categoryId: s.categoryId ?? null,
      durationSeconds: parseIsoDuration(item.contentDetails?.duration),
      views: toNumber(st.viewCount),
      likes: toNumber(st.likeCount), // null when the owner hides likes
      comments: toNumber(st.commentCount), // null when comments are disabled
      thumbnail: (thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
      liveBroadcastContent: s.liveBroadcastContent ?? "none",
    };
  }

  function normalizeChannel(item) {
    const s = item.snippet ?? {};
    const st = item.statistics ?? {};
    return {
      channelId: item.id,
      title: s.title ?? "",
      handle: s.customUrl ?? null,
      description: s.description ?? "",
      country: s.country ?? null,
      publishedAt: s.publishedAt ?? null,
      thumbnail: (s.thumbnails?.high ?? s.thumbnails?.default)?.url ?? null,
      subscribers: st.hiddenSubscriberCount ? null : toNumber(st.subscriberCount),
      views: toNumber(st.viewCount),
      videoCount: toNumber(st.videoCount),
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
  }

  // Classify a caller's channel reference without any network call.
  function parseChannelRef(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return null;
    if (/^UC[\w-]{22}$/.test(raw)) return { kind: "id", value: raw };
    if (/^@[\w.-]{3,}$/.test(raw)) return { kind: "handle", value: raw };
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
      const [first, second] = u.pathname.split("/").filter(Boolean);
      if (first === "channel" && /^UC[\w-]{22}$/.test(second ?? "")) return { kind: "id", value: second };
      if (first?.startsWith("@")) return { kind: "handle", value: decodeURIComponent(first) };
      if (first === "user" && second) return { kind: "username", value: second };
      if (first === "c" && second) return { kind: "custom", value: second };
    } catch {
      /* not a URL */
    }
    return /^[\w.-]{3,}$/.test(raw) ? { kind: "handle", value: `@${raw}` } : null;
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function createClient({ key, fetchImpl = globalThis.fetch.bind(globalThis), baseUrl = BASE } = {}) {
    const apiKey = String(key ?? "").trim();
    if (!apiKey) {
      throw new YouTubeApiError("missing_key",
        "A YouTube Data API v3 key is required. Create one in Google Cloud Console (APIs & Services → Credentials) and enable 'YouTube Data API v3'.");
    }
    let quotaUsed = 0;

    async function get(resource, params, cost = 1) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
      qs.set("key", apiKey);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}${resource}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        throw new YouTubeApiError("network", `YouTube Data API unreachable: ${err?.message ?? err}`);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = body?.error?.errors?.[0]?.reason ?? "";
        const message = body?.error?.message ?? `HTTP ${res.status}`;
        if (reason === "quotaExceeded" || reason === "dailyLimitExceeded")
          throw new YouTubeApiError("quota_exceeded", "Daily YouTube Data API quota is used up; it resets at midnight Pacific time.");
        if (reason === "keyInvalid" || res.status === 400 && /API key/i.test(message))
          throw new YouTubeApiError("key_invalid", "The YouTube Data API key was rejected. Check the key and that the API is enabled.");
        throw new YouTubeApiError("http", `YouTube Data API: ${message}`);
      }
      quotaUsed += cost;
      return body;
    }

    async function videos(ids) {
      const unique = [...new Set(ids.filter(Boolean))];
      const out = [];
      for (const part of chunk(unique, 50)) {
        const body = await get("videos", { part: "snippet,statistics,contentDetails", id: part.join(","), maxResults: 50 });
        out.push(...(body.items ?? []).map(normalizeVideo));
      }
      return out;
    }

    async function channels(ids) {
      const unique = [...new Set(ids.filter(Boolean))];
      const out = [];
      for (const part of chunk(unique, 50)) {
        const body = await get("channels", { part: "snippet,statistics,contentDetails", id: part.join(","), maxResults: 50 });
        out.push(...(body.items ?? []).map(normalizeChannel));
      }
      return out;
    }

    // Resolve a URL, @handle or UC… id to a channel. Custom /c/ names cost a 100-unit search.
    async function resolveChannel(input) {
      const ref = parseChannelRef(input);
      if (!ref) throw new YouTubeApiError("not_found", `Not a YouTube channel reference: ${input}`);
      let params;
      if (ref.kind === "id") params = { id: ref.value };
      else if (ref.kind === "handle") params = { forHandle: ref.value };
      else if (ref.kind === "username") params = { forUsername: ref.value };
      else {
        const found = await get("search", { part: "snippet", type: "channel", q: ref.value, maxResults: 1 }, 100);
        const id = found.items?.[0]?.id?.channelId;
        if (!id) throw new YouTubeApiError("not_found", `No channel found for ${input}`);
        params = { id };
      }
      const body = await get("channels", { part: "snippet,statistics,contentDetails", ...params });
      const item = body.items?.[0];
      if (!item) throw new YouTubeApiError("not_found", `No channel found for ${input}`);
      return normalizeChannel(item);
    }

    // Most recent uploads (newest first) with full statistics.
    async function recentUploads(channel, max = 50) {
      const playlistId = channel.uploadsPlaylistId;
      if (!playlistId) return [];
      const ids = [];
      let pageToken;
      while (ids.length < max) {
        const body = await get("playlistItems", {
          part: "contentDetails", playlistId, maxResults: Math.min(50, max - ids.length), pageToken,
        });
        ids.push(...(body.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean));
        pageToken = body.nextPageToken;
        if (!pageToken || !body.items?.length) break;
      }
      const list = await videos(ids);
      return list.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    }

    // search.list costs 100 units per page; results are enriched with statistics (1 unit/50).
    async function searchVideos({ query, max = 25, order = "relevance", publishedAfter, regionCode, videoDuration } = {}) {
      const ids = [];
      let pageToken;
      while (ids.length < max) {
        const body = await get("search", {
          part: "id", type: "video", q: query, order, publishedAfter, regionCode, videoDuration,
          maxResults: Math.min(50, max - ids.length), pageToken,
        }, 100);
        ids.push(...(body.items ?? []).map((i) => i.id?.videoId).filter(Boolean));
        pageToken = body.nextPageToken;
        if (!pageToken || !body.items?.length) break;
      }
      const byId = new Map((await videos(ids)).map((v) => [v.videoId, v]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    }

    // search.list type=channel (100 units), enriched with channel statistics.
    async function searchChannels({ query, max = 10, regionCode } = {}) {
      const body = await get("search", { part: "id", type: "channel", q: query, regionCode, maxResults: Math.min(50, max) }, 100);
      const ids = (body.items ?? []).map((i) => i.id?.channelId).filter(Boolean);
      const byId = new Map((await channels(ids)).map((c) => [c.channelId, c]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    }

    // The regional "most popular" chart: 1 unit per 50 videos.
    async function mostPopular({ regionCode = "US", categoryId, max = 25 } = {}) {
      const out = [];
      let pageToken;
      while (out.length < max) {
        const body = await get("videos", {
          part: "snippet,statistics,contentDetails", chart: "mostPopular", regionCode, videoCategoryId: categoryId,
          maxResults: Math.min(50, max - out.length), pageToken,
        });
        out.push(...(body.items ?? []).map(normalizeVideo));
        pageToken = body.nextPageToken;
        if (!pageToken || !body.items?.length) break;
      }
      return out;
    }

    async function videoCategories(regionCode = "US") {
      const body = await get("videoCategories", { part: "snippet", regionCode });
      return (body.items ?? [])
        .filter((c) => c.snippet?.assignable)
        .map((c) => ({ id: c.id, title: c.snippet.title }));
    }

    // Public top-level comments (1 unit per 100), optionally with the replies the API returns inline.
    async function commentThreads({ videoId, max = 100, order = "relevance", includeReplies = false } = {}) {
      const out = [];
      let pageToken;
      while (out.length < max) {
        let body;
        try {
          body = await get("commentThreads", {
            part: includeReplies ? "snippet,replies" : "snippet", videoId, order, textFormat: "plainText",
            maxResults: Math.min(100, max - out.length), pageToken,
          });
        } catch (err) {
          if (err.code === "http" && /disabled comments/i.test(err.message))
            throw new YouTubeApiError("not_found", "Comments are disabled on this video.");
          throw err;
        }
        for (const t of body.items ?? []) {
          const c = t.snippet?.topLevelComment?.snippet ?? {};
          out.push({
            commentId: t.id,
            author: c.authorDisplayName ?? null,
            text: c.textDisplay ?? "",
            likes: toNumber(c.likeCount) ?? 0,
            publishedAt: c.publishedAt ?? null,
            replyCount: toNumber(t.snippet?.totalReplyCount) ?? 0,
            replies: includeReplies
              ? (t.replies?.comments ?? []).map((r) => ({ author: r.snippet?.authorDisplayName ?? null, text: r.snippet?.textDisplay ?? "", likes: toNumber(r.snippet?.likeCount) ?? 0 }))
              : undefined,
          });
        }
        pageToken = body.nextPageToken;
        if (!pageToken || !body.items?.length) break;
      }
      return out;
    }

    return {
      videos, channels, resolveChannel, recentUploads, searchVideos, searchChannels, mostPopular,
      videoCategories, commentThreads, quotaUsed: () => quotaUsed,
    };
  }

  const api = { createClient, parseIsoDuration, parseChannelRef, normalizeVideo, normalizeChannel, YouTubeApiError };
  root.TubeLensApi = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

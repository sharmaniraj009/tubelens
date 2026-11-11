#!/usr/bin/env node
// TubeLens MCP server: YouTube research tools and writing prompts for Claude Code / Claude Desktop.
// Runs locally over stdio. Data API tools need YOUTUBE_API_KEY in the environment.
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { addItems, listItems, recordSnapshots, removeItems, snapshots, summarizeHistory } from "./store.mjs";

const require = createRequire(import.meta.url);
const seo = require("../lib/seo.js");
const yt = require("../lib/youtube.js");
const { keywordIdeas } = require("../lib/keywords.js");
const { createClient, YouTubeApiError } = require("../lib/ytapi.js");
const research = require("../lib/research.js");
const clips = require("../lib/clips.js");
const pkg = require("../package.json");

const WATCH_TIMEOUT_MS = 15000;
// TUBELENS_YOUTUBE_WEB_BASE points public-page reads at a test double; production uses YouTube.
const WEB_BASE = (process.env.TUBELENS_YOUTUBE_WEB_BASE || "https://www.youtube.com").replace(/\/+$/, "");
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

// One client per process so quota accounting covers the whole session.
let client = null;
function api() {
  // TUBELENS_YOUTUBE_API_BASE points the client at a test double; production uses Google.
  client ??= createClient({ key: process.env.YOUTUBE_API_KEY, baseUrl: process.env.TUBELENS_YOUTUBE_API_BASE || undefined });
  return client;
}
const hasKey = () => Boolean(process.env.YOUTUBE_API_KEY?.trim());

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

// Expected failures become tool errors with a reason; anything else is rethrown.
async function run(fn) {
  try {
    const data = await fn();
    if (client && data && typeof data === "object" && !Array.isArray(data)) data.quotaUnitsUsedThisSession = client.quotaUsed();
    return ok(data);
  } catch (err) {
    if (err instanceof YouTubeApiError) return fail(`${err.code}: ${err.message}`);
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return fail("timeout: YouTube did not respond in time.");
    if (err instanceof UserError) return fail(err.message);
    throw err;
  }
}
class UserError extends Error {}

function videoIdFrom(input) {
  const raw = String(input).trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  const id = yt.videoIdFromUrl(/^https?:/i.test(raw) ? raw : `https://${raw}`);
  if (!id) throw new UserError(`Not a YouTube video URL or 11-character id: ${input}`);
  return id;
}

async function fetchWatchHtml(videoId) {
  const res = await fetch(`${WEB_BASE}/watch?v=${encodeURIComponent(videoId)}`, {
    headers: BROWSER_HEADERS, signal: AbortSignal.timeout(WATCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new UserError(`YouTube returned HTTP ${res.status} for video ${videoId}`);
  return res.text();
}

function parseWatchOrThrow(html, videoId) {
  const video = yt.parseWatchPage(html);
  if (!video) throw new UserError(`Couldn't read video ${videoId}: it may be private, removed, age-restricted, or behind a consent page.`);
  return video;
}

const fetchWatchPage = async (videoId) => parseWatchOrThrow(await fetchWatchHtml(videoId), videoId);

const scoreSummary = (r) => ({
  score: r.score,
  keyword: r.keyword,
  failed: r.checks.filter((c) => !c.pass).map((c) => ({ check: c.label, points: c.weight, detail: c.detail })),
  passed: r.checks.filter((c) => c.pass).map((c) => c.label),
});

const server = new McpServer({ name: "tubelens", version: pkg.version });
const readOnly = { readOnlyHint: true, openWorldHint: true };

const NO_KEY_VIDEO_LIMIT = 10;

// Shape one video for output; descriptions are long, so they are opt-in for batches.
function videoOut(v, { keyword, includeDescription, subscribers }) {
  const derived = seo.videoStats({ views: v.views, likes: v.likes, comments: v.comments, publishedAt: v.publishedAt });
  return {
    videoId: v.videoId, title: v.title, url: `https://www.youtube.com/watch?v=${v.videoId}`,
    channelId: v.channelId, channel: v.channelTitle ?? v.channelName ?? null, channelSubscribers: subscribers ?? null,
    publishedAt: v.publishedAt, durationSeconds: v.durationSeconds ?? v.lengthSeconds ?? null, category: v.category ?? v.categoryId ?? null,
    views: v.views, likes: v.likes ?? null, comments: v.comments ?? null,
    viewsPerHour: derived.viewsPerHour == null ? null : Math.round(derived.viewsPerHour),
    engagementRate: derived.engagementRate == null ? null : Number(derived.engagementRate.toFixed(2)),
    tags: v.tags, thumbnail: v.thumbnail ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    description: includeDescription ? v.description : undefined,
    seo: scoreSummary(seo.score({ title: v.title, description: v.description, tags: v.tags, keyword })),
  };
}

server.registerTool("get_videos", {
  title: "Get YouTube videos",
  description: "Facts for 1–50 videos: title, tags, views, likes, comments, views/hour, engagement, duration, channel subscribers, plus each video's TubeLens SEO score. With YOUTUBE_API_KEY (1–2 units per call) it also records a snapshot for video_history. Without a key it reads public pages (up to 10 videos; no likes/comments).",
  inputSchema: {
    videos: z.array(z.string()).min(1).max(50).describe("Video URLs (watch, shorts, youtu.be) or 11-character ids"),
    keyword: z.string().optional().describe("Target keyword for the SEO score; defaults to each video's first tag"),
    include_description: z.boolean().optional().describe("Return full descriptions (default: only when one video is requested)"),
  },
  annotations: { ...readOnly, title: "Get YouTube videos" },
}, ({ videos, keyword, include_description }) => run(async () => {
  const ids = [...new Set(videos.map(videoIdFrom))];
  const includeDescription = include_description ?? ids.length === 1;
  if (!hasKey()) {
    if (ids.length > NO_KEY_VIDEO_LIMIT) throw new UserError(`Without YOUTUBE_API_KEY, request at most ${NO_KEY_VIDEO_LIMIT} videos at a time.`);
    const pages = [];
    for (const id of ids) pages.push(await fetchWatchPage(id));
    return { videos: pages.map((v) => videoOut(v, { keyword, includeDescription })),
      note: "Set YOUTUBE_API_KEY for likes, comments, subscribers and history snapshots." };
  }
  const found = await api().videos(ids);
  const subs = new Map((await api().channels(found.map((v) => v.channelId))).map((c) => [c.channelId, c.subscribers]));
  await recordSnapshots(found);
  const missing = ids.filter((id) => !found.some((v) => v.videoId === id));
  return {
    videos: found.map((v) => videoOut(v, { keyword, includeDescription, subscribers: subs.get(v.channelId) })),
    notFound: missing.length ? missing : undefined,
  };
}));

server.registerTool("get_channels", {
  title: "Get YouTube channels",
  description: "Stats for 1–50 channels (URLs, @handles or UC… ids): subscribers, total views, video count, average views per video, country, creation date. Needs YOUTUBE_API_KEY (1 unit per id/handle).",
  inputSchema: { channels: z.array(z.string()).min(1).max(50) },
  annotations: { ...readOnly, title: "Get channels" },
}, ({ channels }) => run(async () => {
  const out = [];
  const errors = [];
  for (const ref of channels) {
    try {
      const c = await api().resolveChannel(ref);
      out.push({ ...channelOut(c), description: c.description.slice(0, 500) });
    } catch (err) {
      if (!(err instanceof YouTubeApiError) || err.code !== "not_found") throw err;
      errors.push({ channel: ref, error: err.message });
    }
  }
  return { channels: out, errors: errors.length ? errors : undefined };
}));

function channelOut(c) {
  return {
    channelId: c.channelId, title: c.title, handle: c.handle, url: `https://www.youtube.com/channel/${c.channelId}`,
    subscribers: c.subscribers, totalViews: c.views, videoCount: c.videoCount,
    averageViewsPerVideo: c.views && c.videoCount ? Math.round(c.views / c.videoCount) : null,
    country: c.country, createdAt: c.publishedAt,
  };
}

server.registerTool("channel_videos", {
  title: "Channel videos",
  description: "A channel's recent uploads with stats, filtered to long-form or likely Shorts (≤3 min) and sorted by newest, views, views/day or outlier ratio. Needs YOUTUBE_API_KEY (~1 unit per 50 videos).",
  inputSchema: {
    channel: z.string().describe("Channel URL, @handle or UC… id"),
    scan: z.number().int().min(5).max(500).default(50).describe("How many recent uploads to fetch"),
    format: z.enum(["all", "long", "shorts"]).default("all"),
    sort: z.enum(["newest", "views", "views_per_day", "outlier"]).default("newest"),
    limit: z.number().int().min(1).max(100).default(25).describe("How many to return after sorting"),
  },
  annotations: { ...readOnly, title: "Channel videos" },
}, ({ channel, scan, format, sort, limit }) => run(async () => {
  const ch = await api().resolveChannel(channel);
  const uploads = await api().recentUploads(ch, scan);
  await recordSnapshots(uploads);
  const isShort = (v) => v.durationSeconds != null && v.durationSeconds <= research.SHORT_MAX_SECONDS;
  const picked = uploads.filter((v) => format === "all" || (format === "shorts" ? isShort(v) : !isShort(v)));
  const baseline = research.median(picked.filter((v) => (Date.now() - Date.parse(v.publishedAt)) / 86400000 >= research.MIN_AGE_DAYS).map((v) => v.views));
  const now = Date.now();
  const rows = picked.map((v) => ({
    videoId: v.videoId, title: v.title, url: `https://www.youtube.com/watch?v=${v.videoId}`, publishedAt: v.publishedAt,
    durationSeconds: v.durationSeconds, views: v.views, likes: v.likes, comments: v.comments,
    viewsPerDay: v.views == null ? null : Math.round(v.views / Math.max((now - Date.parse(v.publishedAt)) / 86400000, 1)),
    outlierRatio: baseline && v.views != null ? Number((v.views / baseline).toFixed(2)) : null,
  }));
  const key = { views: "views", views_per_day: "viewsPerDay", outlier: "outlierRatio" }[sort];
  if (key) rows.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  return { channel: channelOut(ch), scanned: uploads.length, matched: rows.length, medianViews: baseline, videos: rows.slice(0, limit),
    note: "outlierRatio = views ÷ median views of this filtered sample (videos ≥7 days old)." };
}));

server.registerTool("search_channels", {
  title: "Search channels",
  description: "Find YouTube channels for a topic or name, with subscriber and view stats. Needs YOUTUBE_API_KEY; costs 100 quota units.",
  inputSchema: {
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(50).default(10),
    region: z.string().length(2).optional(),
  },
  annotations: { ...readOnly, title: "Search channels" },
}, ({ query, max_results, region }) => run(async () => ({
  query, channels: (await api().searchChannels({ query, max: max_results, regionCode: region })).map(channelOut),
})));

server.registerTool("trending_videos", {
  title: "Trending videos",
  description: "What's gaining views now. mode='chart' reads YouTube's regional most-popular chart (1 unit, optionally by category). mode='rising' searches a topic for videos published in the last N hours and ranks them by views/hour (100 units).",
  inputSchema: {
    mode: z.enum(["chart", "rising"]).default("chart"),
    region: z.string().length(2).default("US"),
    category_id: z.string().optional().describe("chart mode: id from trend_categories"),
    query: z.string().optional().describe("rising mode: topic to search (required)"),
    within_hours: z.number().int().min(1).max(720).default(72).describe("rising mode: published within this many hours"),
    max_results: z.number().int().min(1).max(50).default(20),
  },
  annotations: { ...readOnly, title: "Trending videos" },
}, ({ mode, region, category_id, query, within_hours, max_results }) => run(async () => {
  let videos;
  if (mode === "chart") {
    videos = await api().mostPopular({ regionCode: region, categoryId: category_id, max: max_results });
  } else {
    if (!query) throw new UserError("rising mode needs a query.");
    videos = await api().searchVideos({ query, max: max_results, order: "viewCount", regionCode: region,
      publishedAfter: new Date(Date.now() - within_hours * 3.6e6).toISOString() });
  }
  await recordSnapshots(videos);
  const rows = videos.map((v) => ({
    videoId: v.videoId, title: v.title, channel: v.channelTitle, url: `https://www.youtube.com/watch?v=${v.videoId}`,
    publishedAt: v.publishedAt, durationSeconds: v.durationSeconds, views: v.views,
    viewsPerHour: Math.round(research.viewsPerHour(v) ?? 0), engagementRate: research.engagementRate(v) == null ? null : Number(research.engagementRate(v).toFixed(2)),
  }));
  if (mode === "rising") rows.sort((a, b) => b.viewsPerHour - a.viewsPerHour);
  return { mode, region, videos: rows };
}));

server.registerTool("trend_categories", {
  title: "Trend categories",
  description: "YouTube video category ids for a region (use with trending_videos chart mode). 1 quota unit.",
  inputSchema: { region: z.string().length(2).default("US") },
  annotations: { ...readOnly, title: "Trend categories" },
}, ({ region }) => run(async () => ({ region, categories: await api().videoCategories(region) })));

server.registerTool("similar_videos", {
  title: "Similar videos",
  description: "Find high-performing videos on the same topic as a seed video, ranked by outlier ratio. The topic comes from the seed's tags and title. Needs YOUTUBE_API_KEY; ~102 units.",
  inputSchema: {
    video: z.string().describe("Seed video URL or id"),
    max_results: z.number().int().min(1).max(50).default(20),
    published_within_days: z.number().int().min(1).max(3650).optional(),
    query: z.string().optional().describe("Override the search phrase derived from the seed"),
  },
  annotations: { ...readOnly, title: "Similar videos" },
}, ({ video, max_results, published_within_days, query }) => run(async () => {
  const id = videoIdFrom(video);
  const [seed] = await api().videos([id]);
  if (!seed) throw new UserError(`Video ${id} was not found.`);
  const phrase = query ?? (seed.tags[0] ? seo.words(seed.tags[0]).join(" ") : research.topicTerms([seed], 3).join(" "));
  const found = (await api().searchVideos({ query: phrase, max: max_results + 1,
    publishedAfter: published_within_days ? new Date(Date.now() - published_within_days * 86400000).toISOString() : undefined }))
    .filter((v) => v.videoId !== id && v.channelId !== seed.channelId);
  const ranked = research.rankOutliers(found, await api().channels(found.map((v) => v.channelId)));
  return { seed: { videoId: id, title: seed.title, channel: seed.channelTitle }, searchedFor: phrase, results: ranked.slice(0, max_results) };
}));

server.registerTool("similar_channels", {
  title: "Similar channels",
  description: "Find channels covering the same topics as a channel (yours or a competitor's), from the topic terms in its recent titles and tags. Needs YOUTUBE_API_KEY; ~100 units per topic searched.",
  inputSchema: {
    channel: z.string(),
    topics: z.number().int().min(1).max(3).default(2).describe("How many topic terms to search (100 units each)"),
    max_results: z.number().int().min(1).max(25).default(10),
  },
  annotations: { ...readOnly, title: "Similar channels" },
}, ({ channel, topics, max_results }) => run(async () => {
  const ch = await api().resolveChannel(channel);
  const terms = research.topicTerms(await api().recentUploads(ch, 30), topics);
  if (terms.length === 0) throw new UserError("The channel has no recent uploads to derive topics from.");
  const seen = new Map();
  for (const term of terms) {
    for (const c of await api().searchChannels({ query: term, max: max_results + 1 })) {
      if (c.channelId === ch.channelId) continue;
      const row = seen.get(c.channelId) ?? { ...channelOut(c), matchedTopics: [] };
      row.matchedTopics.push(term);
      seen.set(c.channelId, row);
    }
  }
  const rows = [...seen.values()].sort((a, b) => b.matchedTopics.length - a.matchedTopics.length || (b.subscribers ?? 0) - (a.subscribers ?? 0));
  return { channel: channelOut(ch), topics: terms, similar: rows.slice(0, max_results) };
}));

server.registerTool("video_comments", {
  title: "Video comments",
  description: "Public comments on a video with a digest (most-liked, top questions). Use for comment insights, content ideas from viewer questions, and drafting replies. Needs YOUTUBE_API_KEY (1 unit per 100 comments).",
  inputSchema: {
    video: z.string(),
    max_comments: z.number().int().min(1).max(500).default(100),
    order: z.enum(["relevance", "time"]).default("relevance"),
    include_replies: z.boolean().default(false),
    digest_only: z.boolean().default(false).describe("Return only the digest, not every comment"),
  },
  annotations: { ...readOnly, title: "Video comments" },
}, ({ video, max_comments, order, include_replies, digest_only }) => run(async () => {
  const comments = await api().commentThreads({ videoId: videoIdFrom(video), max: max_comments, order, includeReplies: include_replies });
  return {
    digest: research.commentDigest(comments),
    comments: digest_only ? undefined : comments.map((c) => ({ ...c, text: c.text.slice(0, 1000), publishedAt: c.publishedAt?.slice(0, 10) })),
  };
}));

server.registerTool("find_clips", {
  title: "Find clip moments",
  description: "Suggest clip-worthy moments in a video (for Shorts, highlights or sharing) from YouTube's 'Most replayed' heatmap, the video's chapters and, with YOUTUBE_API_KEY, timestamps viewers mention in comments (1 unit). Returns start/end times, replay intensity, chapter, and share/embed links. The heatmap needs no key, but YouTube only shows it on videos with enough views. TubeLens does not download or cut video.",
  inputSchema: {
    video: z.string().describe("Video URL or 11-character id"),
    count: z.number().int().min(1).max(10).default(5).describe("How many clips to suggest"),
    min_seconds: z.number().int().min(5).max(180).default(15),
    max_seconds: z.number().int().min(10).max(180).default(60).describe("Longest clip; Shorts allow up to 180 s, 15–60 s is typical"),
    use_comments: z.boolean().default(true).describe("Also scan the top 100 comments for timestamps (needs YOUTUBE_API_KEY, 1 unit)"),
  },
  annotations: { ...readOnly, title: "Find clips" },
}, ({ video, count, min_seconds, max_seconds, use_comments }) => run(async () => {
  if (min_seconds > max_seconds) throw new UserError("min_seconds can't be larger than max_seconds.");
  const id = videoIdFrom(video);
  const html = await fetchWatchHtml(id);
  const meta = parseWatchOrThrow(html, id);
  const duration = meta.lengthSeconds;
  if (!duration) throw new UserError("This video has no fixed length (live stream?), so clips can't be suggested.");
  const heatmap = clips.heatmapFromInitialData(yt.extractJsonAfter(html, "ytInitialData"), id);
  const chapters = clips.chapterList(meta.description);
  const notes = [];

  let mentions = [];
  if (use_comments && hasKey()) {
    try {
      mentions = clips.timestampMentions(await api().commentThreads({ videoId: id, max: 100 }), { durationSeconds: duration });
    } catch (err) {
      if (!(err instanceof YouTubeApiError) || err.code !== "not_found") throw err;
      notes.push(err.message);
    }
  } else if (use_comments) {
    notes.push("Set YOUTUBE_API_KEY to also use timestamps viewers mention in comments.");
  }

  const limits = { durationSeconds: duration, minSeconds: min_seconds, maxSeconds: max_seconds };
  const picked = clips.suggestClips(heatmap, { ...limits, count }).map((c) => ({ ...c, source: "most_replayed" }));
  // Comment moments that no heatmap clip covers become clips of their own. With a heatmap,
  // a moment needs 2+ mentions to count; without one, any mention is the best signal there is.
  for (const m of mentions) {
    if (picked.length >= count) break;
    if (m.mentions < 2 && heatmap.length) continue;
    const range = clips.clipAround(m.at, limits);
    if (picked.some((c) => c.start < range.end && range.start < c.end)) continue;
    picked.push({ ...range, length: range.end - range.start, peak: m.at, intensity: null, source: "comments" });
  }

  if (!heatmap.length) notes.push("YouTube shows no 'Most replayed' data for this video (it appears once a video has enough views).");
  else notes.push("replayVsTypical is how many times as often viewers replay the clip's peak as a typical moment of this video; replayIntensity is relative to its most replayed segment (100). The opening seconds are skipped: almost every heatmap starts high because playback starts there. Only moments that clearly stand out are suggested, so evenly watched videos and Shorts can get few or none.");
  if (!picked.length) notes.push("No clip moments found. Ask the creator for a transcript or the moments they have in mind.");
  notes.push("Clips are suggestions. Cut them in an editor, or with YouTube's 'Edit into a Short' on your own videos.");

  return {
    video: { videoId: id, title: meta.title, channel: meta.channelName, durationSeconds: duration, url: `https://www.youtube.com/watch?v=${id}` },
    heatmap: heatmap.length
      ? { available: true, segments: heatmap.length, segmentSeconds: Number(heatmap[0].duration.toFixed(2)), sparkline: clips.sparkline(heatmap, 50) }
      : { available: false },
    clips: picked.map((c, i) => {
      const inClip = mentions.filter((m) => m.at >= c.start && m.at <= c.end);
      return {
        rank: i + 1, source: c.source,
        start: c.start, end: c.end, startTimestamp: clips.formatTime(c.start), endTimestamp: clips.formatTime(c.end), lengthSeconds: c.length,
        peakTimestamp: clips.formatTime(c.peak), replayIntensity: c.intensity, replayVsTypical: c.lift ?? undefined,
        commentMentions: inClip.reduce((n, m) => n + m.mentions, 0) || undefined,
        chapter: clips.chapterAt(chapters, c.peak)?.title,
        url: clips.shareUrl(id, c.start), embedUrl: clips.embedUrl(id, c.start, c.end),
      };
    }),
    commentMoments: mentions.length
      ? mentions.slice(0, 8).map((m) => ({ timestamp: clips.formatTime(m.at), mentions: m.mentions, likes: m.likes, samples: m.samples }))
      : undefined,
    chapters: chapters.length ? chapters.map((c) => ({ timestamp: clips.formatTime(c.start), title: c.title })) : undefined,
    notes,
  };
}));

server.registerTool("video_history", {
  title: "Video history",
  description: "Growth and title/thumbnail changes for a video from TubeLens's local snapshots (taken whenever get_videos, channel_videos or trending_videos fetch it with an API key). Set record=true to take a snapshot now. History starts from the first snapshot; YouTube does not provide past data.",
  inputSchema: { video: z.string(), record: z.boolean().default(true) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, title: "Video history" },
}, ({ video, record }) => run(async () => {
  const id = videoIdFrom(video);
  if (record) {
    const found = await api().videos([id]);
    if (found.length === 0) throw new UserError(`Video ${id} was not found.`);
    await recordSnapshots(found);
  }
  return { videoId: id, ...summarizeHistory(await snapshots(id)) };
}));

server.registerTool("library", {
  title: "Saved competitors and bookmarks",
  description: "Your local TubeLens library. collection='competitors' tracks channels (add resolves them, needs YOUTUBE_API_KEY); collection='bookmarks' saves videos, channels, ideas or titles. Stored in ~/.tubelens on this machine.",
  inputSchema: {
    collection: z.enum(["competitors", "bookmarks"]),
    action: z.enum(["list", "add", "remove"]),
    items: z.array(z.string()).max(50).optional().describe("add: channel refs (competitors) or text/URLs (bookmarks); remove: keys from list"),
    note: z.string().max(500).optional().describe("Bookmark note applied to added items"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: "Library" },
}, ({ collection, action, items = [], note }) => run(async () => {
  if (action === "list") return { collection, items: await listItems(collection) };
  if (items.length === 0) throw new UserError(`${action} needs at least one item.`);
  if (action === "remove") return { collection, ...(await removeItems(collection, items)) };
  if (collection === "competitors") {
    const resolved = [];
    for (const ref of items) {
      const c = await api().resolveChannel(ref);
      resolved.push({ key: c.channelId, title: c.title, handle: c.handle, url: `https://www.youtube.com/channel/${c.channelId}` });
    }
    return { collection, ...(await addItems(collection, resolved)) };
  }
  return { collection, ...(await addItems(collection, items.map((text) => {
    let videoId = null;
    try { videoId = videoIdFrom(text); } catch { /* not a video */ }
    return { key: videoId ?? text.trim().toLowerCase(), value: text.trim(), type: videoId ? "video" : "text", note };
  }))) };
}));

server.registerTool("score_metadata", {
  title: "Score title, description and tags",
  description: "Score draft metadata with the TubeLens 100-point SEO checklist and list failed checks. Use it to compare and improve drafts before upload. It is a transparent checklist, not YouTube's ranking.",
  inputSchema: {
    title: z.string(),
    description: z.string().default(""),
    tags: z.array(z.string()).default([]),
    keyword: z.string().optional().describe("Target keyword; defaults to the first tag"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false, title: "Score metadata" },
}, (args) => run(async () => scoreSummary(seo.score(args))));

server.registerTool("keyword_ideas", {
  title: "Keyword ideas",
  description: "Expand a seed topic through YouTube search autocomplete (seed, then seed + a..z). 'appearances' counts how many of the probes suggested each phrase: a popularity hint, not search volume. No API key needed.",
  inputSchema: {
    seed: z.string().min(1),
    expand: z.boolean().default(true).describe("false = one lookup for the seed only"),
    limit: z.number().int().min(1).max(300).default(40),
    language: z.string().default("en").describe("Interface language code, e.g. en, hi, es"),
    region: z.string().length(2).optional().describe("Two-letter country code, e.g. US, IN"),
  },
  annotations: { ...readOnly, title: "Keyword ideas" },
}, ({ seed, expand, limit, language, region }) => run(async () => {
  const r = await keywordIdeas(seed, { expand, language, region });
  return { seed: r.seed, probes: r.probes, failedProbes: r.failed, totalIdeas: r.ideas.length,
    ideas: r.ideas.slice(0, limit).map((i) => ({ keyword: i.keyword, appearances: i.appearances })) };
}));

server.registerTool("search_videos", {
  title: "Search videos and find outliers",
  description: "Search YouTube and rank results. sort='outlier' ranks by views relative to the channel's average views per video (finds videos that beat their channel). Needs YOUTUBE_API_KEY; costs 100 quota units per 50 results.",
  inputSchema: {
    query: z.string().min(1),
    max_results: z.number().int().min(1).max(50).default(20),
    sort: z.enum(["outlier", "views", "views_per_day", "relevance"]).default("outlier"),
    published_within_days: z.number().int().min(1).max(3650).optional(),
    region: z.string().length(2).optional(),
    duration: z.enum(["any", "short", "medium", "long"]).default("any").describe("YouTube filter: short <4 min, medium 4–20, long >20"),
  },
  annotations: { ...readOnly, title: "Search videos" },
}, ({ query, max_results, sort, published_within_days, region, duration }) => run(async () => {
  const publishedAfter = published_within_days ? new Date(Date.now() - published_within_days * 86400000).toISOString() : undefined;
  const videos = await api().searchVideos({ query, max: max_results, publishedAfter, regionCode: region,
    videoDuration: duration === "any" ? undefined : duration });
  const channels = await api().channels(videos.map((v) => v.channelId));
  let ranked = research.rankOutliers(videos, channels);
  if (sort === "views") ranked.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  if (sort === "views_per_day") ranked.sort((a, b) => (b.viewsPerDay ?? 0) - (a.viewsPerDay ?? 0));
  if (sort === "relevance") {
    const order = new Map(videos.map((v, i) => [v.videoId, i]));
    ranked.sort((a, b) => order.get(a.videoId) - order.get(b.videoId));
  }
  return { query, sort, results: ranked,
    note: "outlierRatio = views ÷ channel lifetime average views per video (approximate; includes old videos and Shorts)." };
}));

server.registerTool("channel_report", {
  title: "Channel report",
  description: "Analyse a channel's recent uploads: median views, upload cadence, best days/hours to post, Shorts vs long-form, top videos, outliers and underperformers, plus an SEO audit of titles/descriptions/tags. Needs YOUTUBE_API_KEY (~3 quota units).",
  inputSchema: {
    channel: z.string().describe("Channel URL, @handle or UC… id"),
    videos: z.number().int().min(5).max(200).default(50).describe("How many recent uploads to analyse"),
    utc_offset_minutes: z.number().int().min(-720).max(840).default(0).describe("Report posting times in this offset, e.g. 330 for India"),
    audit: z.boolean().default(true),
  },
  annotations: { ...readOnly, title: "Channel report" },
}, ({ channel, videos, utc_offset_minutes, audit }) => run(async () => {
  const ch = await api().resolveChannel(channel);
  const uploads = await api().recentUploads(ch, videos);
  return {
    ...research.summarizeChannel(ch, uploads, { utcOffsetMinutes: utc_offset_minutes }),
    seoAudit: audit ? research.auditVideos(uploads) : undefined,
  };
}));

server.registerTool("compare_channels", {
  title: "Compare channels",
  description: "Side-by-side comparison of up to 10 channels (e.g. you vs competitors) from their recent uploads: subscribers, median views, views per subscriber, cadence, engagement and each channel's top outlier. Needs YOUTUBE_API_KEY.",
  inputSchema: {
    channels: z.array(z.string()).min(2).max(10).describe("Channel URLs, @handles or UC… ids"),
    videos: z.number().int().min(5).max(50).default(25),
  },
  annotations: { ...readOnly, title: "Compare channels" },
}, ({ channels, videos }) => run(async () => {
  const rows = [];
  const errors = [];
  for (const ref of channels) {
    try {
      const ch = await api().resolveChannel(ref);
      const s = research.summarizeChannel(ch, await api().recentUploads(ch, videos));
      rows.push({
        channel: s.channel.title, handle: s.channel.handle, subscribers: s.channel.subscribers,
        medianViews: s.medianViews, medianViewsPerSubscriber: s.medianViewsPerSubscriber,
        uploadsPerWeek: s.uploadsPerWeek, medianEngagementRate: s.medianEngagementRate,
        bestDay: s.bestDays[0]?.label ?? null, topOutlier: s.outliers[0] ?? null,
      });
    } catch (err) {
      if (!(err instanceof YouTubeApiError) || err.code === "quota_exceeded" || err.code === "key_invalid" || err.code === "missing_key") throw err;
      errors.push({ channel: ref, error: err.message });
    }
  }
  return { channels: rows, errors };
}));

// Writing prompts: Claude does the writing, grounded by the tools above.
server.registerPrompt("write_titles", {
  title: "Write video titles",
  description: "Research a topic and write high-CTR titles, scored with the TubeLens checklist.",
  argsSchema: {
    topic: z.string().describe("What the video is about"),
    keyword: z.string().optional().describe("Target search phrase"),
    notes: z.string().optional().describe("Transcript, outline or key points"),
  },
}, ({ topic, keyword, notes }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Write YouTube titles for a video about: ${topic}
${keyword ? `Target keyword: ${keyword}` : "Pick the target keyword from research."}
${notes ? `Video notes/transcript:\n${notes}\n` : ""}
Steps:
1. Call keyword_ideas for the topic; choose the strongest specific phrase as the target keyword.
2. If search_videos is available (needs YOUTUBE_API_KEY), search the keyword with sort="outlier" and published_within_days=365. Note the title patterns of the top outliers (number, curiosity gap, outcome, timeframe, contrast). Don't copy titles.
3. Draft 10 original titles under 60 characters with the keyword early, each using a different angle.
4. Score each with score_metadata (title + keyword) and keep the best 5.
Return a table: title, characters, angle, SEO score, and one line on why it should earn clicks. Only claim facts the notes support.` } }],
}));

server.registerPrompt("write_description", {
  title: "Write description, tags and chapters",
  description: "Write an SEO description with chapters, hashtags and tags, then score it.",
  argsSchema: {
    title: z.string(),
    keyword: z.string().optional(),
    transcript_or_notes: z.string().optional().describe("Transcript with timestamps gives real chapters"),
    links: z.string().optional().describe("Links/CTAs to include"),
  },
}, ({ title, keyword, transcript_or_notes, links }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Write the YouTube description, tags and hashtags for: "${title}"
${keyword ? `Target keyword: ${keyword}` : "Infer the target keyword from the title, and check it with keyword_ideas."}
${transcript_or_notes ? `Transcript/notes:\n${transcript_or_notes}\n` : "No transcript given: write chapters only if the user supplies timestamps; otherwise leave a placeholder chapter block."}
${links ? `Links/CTAs:\n${links}\n` : ""}
Requirements: first 2 lines hook the viewer and contain the keyword naturally; 1,000+ characters of genuinely useful text; chapters starting at 0:00 (only from real timestamps); links block; 1–3 hashtags at the end; 10–15 tags (keyword first, then variations from keyword_ideas) staying within 500 tag characters.
Score the result with score_metadata and revise until it scores ≥ 85, without keyword stuffing. Output: description, comma-separated tags, and the final score.` } }],
}));

server.registerPrompt("video_ideas", {
  title: "Video ideas for a channel",
  description: "Find proven video ideas for a channel from its outliers, competitors and search demand.",
  argsSchema: {
    channel: z.string().describe("Your channel URL or @handle"),
    competitors: z.string().optional().describe("Comma-separated competitor channels"),
    niche: z.string().optional(),
  },
}, ({ channel, competitors, niche }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Suggest 10 video ideas for ${channel}${niche ? ` (niche: ${niche})` : ""}.
1. channel_report for ${channel}: what topics and formats are its outliers? What underperforms?
2. ${competitors ? `compare_channels with ${channel}, ${competitors}; then search_videos for their best topics with sort="outlier".` : "Identify 2–3 core topics and run search_videos with sort=\"outlier\", published_within_days=180 for each."}
3. keyword_ideas for each promising topic to find specific search phrases.
For each idea give: working title, target keyword, why it should work (cite the outlier videos/ratios you found), format (Short or long-form), and the best day/time from the channel report. Rank by expected upside. Note quota spent.` } }],
}));

server.registerPrompt("channel_audit", {
  title: "Channel audit",
  description: "Audit a channel's performance and metadata, with a prioritised action plan.",
  argsSchema: { channel: z.string(), utc_offset_minutes: z.string().optional().describe("e.g. 330 for India") },
}, ({ channel, utc_offset_minutes }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Audit the YouTube channel ${channel}.
Call channel_report with videos=100${utc_offset_minutes ? ` and utc_offset_minutes=${utc_offset_minutes}` : ""}. Then call get_videos once for the top 2 outliers and the 2 lowest SEO-score videos.
Report: 1) snapshot (subscribers, median views, cadence, engagement); 2) what works (outlier topics, formats, posting times); 3) what doesn't; 4) metadata issues from the SEO audit with concrete rewrites for the 2 weakest videos (re-score them with score_metadata); 5) a prioritised 30-day plan. Separate observed numbers from your inferences.` } }],
}));

server.registerPrompt("write_script", {
  title: "Write a video script",
  description: "Research a topic and write a retention-focused long-form script with hook, structure and CTA.",
  argsSchema: {
    topic: z.string(),
    length_minutes: z.string().optional().describe("Target length, e.g. 8"),
    audience: z.string().optional(),
    notes: z.string().optional().describe("Facts, outline, or your own research to use"),
  },
}, ({ topic, length_minutes, audience, notes }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Write a YouTube script about: ${topic}${length_minutes ? ` (~${length_minutes} minutes, ≈${Number(length_minutes) * 150} spoken words)` : ""}${audience ? ` for ${audience}` : ""}.
${notes ? `Use these notes as the factual basis:\n${notes}\n` : "Only state facts you are confident about; mark anything that needs checking with [VERIFY]."}
Research first: keyword_ideas for the topic, then search_videos with sort="outlier" to see which angles over-perform (don't copy them), and video_comments (digest_only=true) on the top 1–2 results to find unanswered viewer questions.
Script format: a 15-second hook that states the payoff; an open loop; 3–6 sections each opening with a re-hook; pattern interrupts / B-roll cues in [brackets]; a CTA that fits the content; an end-screen line leading to a next video. Finish with 3 title options (scored with score_metadata) and a thumbnail concept (≤5 words of text).` } }],
}));

server.registerPrompt("comment_insights", {
  title: "Comment insights and replies",
  description: "Analyse a video's comments for themes, questions and ideas, and draft replies.",
  argsSchema: { video: z.string(), reply_tone: z.string().optional().describe("e.g. friendly, witty, expert") },
}, ({ video, reply_tone }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Analyse the comments on ${video}. Call video_comments with max_comments=300.
Report: overall sentiment; the 5 main themes with example quotes; unanswered questions (each a potential video idea); complaints or confusion to fix; and 5 follow-up video ideas grounded in what viewers asked.
Then draft replies to the 5 most-liked comments and the 5 best questions${reply_tone ? ` in a ${reply_tone} tone` : ""} — two options each, short and human. These are drafts for me to post myself; do not claim they were posted.` } }],
}));

server.registerPrompt("video_chapters", {
  title: "Video chapters",
  description: "Turn a timestamped transcript into YouTube chapters.",
  argsSchema: { transcript: z.string().describe("Transcript with timestamps (e.g. exported from YouTube Studio)") },
}, ({ transcript }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Create YouTube chapters from this timestamped transcript. Rules: first chapter at 0:00; at least 3 chapters; each at least 10 seconds long; titles 2–6 words, keyword-rich but natural; use the real timestamps from the transcript only.
Output just the chapter block, then check it with score_metadata (put the block in the description) to confirm the chapters check passes.

${transcript}` } }],
}));

server.registerPrompt("clip_shorts", {
  title: "Find Shorts in a video",
  description: "Find the most clip-worthy moments in a long video and package each as a Short: timestamps, hook, title and caption.",
  argsSchema: {
    video: z.string().describe("Video URL or id (ideally your own)"),
    count: z.string().optional().describe("How many Shorts, default 5"),
    transcript: z.string().optional().describe("Timestamped transcript, to name moments and check each clip stands alone"),
  },
}, ({ video, count, transcript }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Find ${count || 5} Shorts in ${video}.
1. Call find_clips for the video with count=${count || 5}. If it returns no clips, ask me for a transcript or the moments I have in mind; don't guess timestamps.
${transcript ? `2. Use this transcript to name each moment, tighten its start/end to whole sentences, and drop clips that don't make sense on their own:\n${transcript}\n` : "2. Without a transcript you can't see what is said in each clip: say so, and phrase hooks and titles as suggestions for me to check against the footage.\n"}3. For each clip give: start–end with its link, why it should work (replays vs a typical moment, comment mentions, chapter), a suggested trim so the hook lands in the first 2 seconds, on-screen hook text (≤ 6 words), a Short title (≤ 60 characters, scored with score_metadata), and a caption with 2–3 hashtags.
Rank them by expected performance. Remind me to cut the clips in an editor or with YouTube's "Edit into a Short", and only from videos I own or have rights to.` } }],
}));

server.registerPrompt("title_review", {
  title: "Review titles for clicks",
  description: "Critique and rank candidate titles for click-through and search, and suggest improvements.",
  argsSchema: { titles: z.string().describe("One title per line"), keyword: z.string().optional(), topic: z.string().optional() },
}, ({ titles, keyword, topic }) => ({
  messages: [{ role: "user", content: { type: "text", text:
`Review these YouTube titles${topic ? ` for a video about ${topic}` : ""}${keyword ? ` (target keyword: ${keyword})` : ""}:
${titles}

For each: score_metadata it, then rate curiosity, clarity, specificity, emotional pull and promise/payoff match (1–5 each, with one-line reasons). Check truncation risk (first ~50 characters carry the meaning?). Rank them, and write 3 improved variants of the best one. Be clear these ratings are judgement, not measured CTR.` } }],
}));

await server.connect(new StdioServerTransport());

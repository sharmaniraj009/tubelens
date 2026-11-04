"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ytapi = require("../lib/ytapi.js");
const research = require("../lib/research.js");

const DAY = 86400000;
const NOW = Date.parse("2026-06-01T00:00:00Z");

test("parseIsoDuration", () => {
  assert.equal(ytapi.parseIsoDuration("PT1H2M3S"), 3723);
  assert.equal(ytapi.parseIsoDuration("PT45S"), 45);
  assert.equal(ytapi.parseIsoDuration("P1DT1M"), 86460);
  assert.equal(ytapi.parseIsoDuration("P0D"), 0);
  assert.equal(ytapi.parseIsoDuration(undefined), null);
  assert.equal(ytapi.parseIsoDuration("PT"), null);
});

test("parseChannelRef recognises ids, handles and URLs", () => {
  const id = "UC4QobU6STFB0P71PMvOGN5A";
  assert.deepEqual(ytapi.parseChannelRef(id), { kind: "id", value: id });
  assert.deepEqual(ytapi.parseChannelRef(`https://www.youtube.com/channel/${id}/videos`), { kind: "id", value: id });
  assert.deepEqual(ytapi.parseChannelRef("https://youtube.com/@MrBeast"), { kind: "handle", value: "@MrBeast" });
  assert.deepEqual(ytapi.parseChannelRef("@mkbhd"), { kind: "handle", value: "@mkbhd" });
  assert.deepEqual(ytapi.parseChannelRef("youtube.com/user/pewdiepie"), { kind: "username", value: "pewdiepie" });
  assert.deepEqual(ytapi.parseChannelRef("https://www.youtube.com/c/SomeName"), { kind: "custom", value: "SomeName" });
  assert.equal(ytapi.parseChannelRef("https://example.com/@x"), null);
  assert.equal(ytapi.parseChannelRef(""), null);
});

test("createClient requires a key", () => {
  assert.throws(() => ytapi.createClient({ key: " " }), (e) => e.code === "missing_key");
});

// Minimal fake of the Data API endpoints the client uses.
function fakeFetch(log) {
  const video = (id, views, daysAgo) => ({
    id, snippet: { title: `Video ${id}`, description: "", channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", publishedAt: new Date(NOW - daysAgo * DAY).toISOString() },
    statistics: { viewCount: String(views), likeCount: "10" }, contentDetails: { duration: "PT10M" },
  });
  const videos = { v1: video("v1", 1000, 10), v2: video("v2", 5000, 20), v3: video("v3", 900, 30) };
  return async (url) => {
    const u = new URL(url);
    const resource = u.pathname.split("/").pop();
    log.push(resource);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.searchParams.get("key") === "bad") return json({ error: { message: "API key not valid", errors: [{ reason: "keyInvalid" }] } }, 400);
    if (u.searchParams.get("key") === "spent") return json({ error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }, 403);
    if (resource === "channels") {
      return json({ items: [{ id: "UCaaaaaaaaaaaaaaaaaaaaaa", snippet: { title: "Chan", customUrl: "@chan" },
        statistics: { subscriberCount: "2000", viewCount: "100000", videoCount: "50" },
        contentDetails: { relatedPlaylists: { uploads: "UUaaaa" } } }] });
    }
    if (resource === "playlistItems") {
      const page = u.searchParams.get("pageToken");
      return page
        ? json({ items: [{ contentDetails: { videoId: "v3" } }] })
        : json({ items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }], nextPageToken: "p2" });
    }
    if (resource === "videos") return json({ items: u.searchParams.get("id").split(",").map((id) => videos[id]).filter(Boolean) });
    if (resource === "search") return json({ items: [{ id: { videoId: "v2" } }, { id: { videoId: "v1" } }] });
    return json({ error: { message: "unexpected" } }, 404);
  };
}

test("client resolves a handle, pages uploads, and counts quota", async () => {
  const log = [];
  const c = ytapi.createClient({ key: "k", fetchImpl: fakeFetch(log) });
  const ch = await c.resolveChannel("@chan");
  assert.equal(ch.subscribers, 2000);
  const uploads = await c.recentUploads(ch, 10);
  assert.deepEqual(uploads.map((v) => v.videoId), ["v1", "v2", "v3"]); // newest first
  assert.equal(uploads[0].durationSeconds, 600);
  assert.equal(c.quotaUsed(), 4); // channels + 2 playlist pages + videos
  const found = await c.searchVideos({ query: "x", max: 2 });
  assert.deepEqual(found.map((v) => v.videoId), ["v2", "v1"]); // search order kept
  assert.equal(c.quotaUsed(), 105);
});

test("client maps API failures to error codes", async () => {
  await assert.rejects(ytapi.createClient({ key: "bad", fetchImpl: fakeFetch([]) }).videos(["v1"]), (e) => e.code === "key_invalid");
  await assert.rejects(ytapi.createClient({ key: "spent", fetchImpl: fakeFetch([]) }).videos(["v1"]), (e) => e.code === "quota_exceeded");
});

const vid = (id, views, daysAgo, extra = {}) => ({
  videoId: id, title: `t ${id}`, description: "", tags: [], channelId: "UC1", channelTitle: "C",
  publishedAt: new Date(NOW - daysAgo * DAY).toISOString(), views, likes: views / 10, comments: 0, durationSeconds: 600, ...extra,
});

test("summarizeChannel: baseline excludes young videos and flags outliers", () => {
  const videos = [vid("new", 99999, 1), vid("a", 100, 10), vid("b", 200, 17), vid("c", 1000, 24), vid("d", 40, 31, { durationSeconds: 50 })];
  const s = research.summarizeChannel({ channelId: "UC1", title: "C", subscribers: 1000 }, videos, { now: NOW });
  assert.equal(s.sample.matureVideos, 4);
  assert.equal(s.medianViews, 150); // median of 40,100,200,1000
  assert.deepEqual(s.outliers.map((o) => [o.videoId, o.outlierRatio]), [["c", 6.7]]);
  assert.deepEqual(s.underperformers.map((o) => o.videoId), ["d"]);
  assert.equal(s.formats.likelyShorts.videos, 1);
  assert.equal(s.medianEngagementRate, 10);
  assert.equal(s.medianDaysBetweenUploads, 7);
});

test("summarizeChannel applies the caller's UTC offset to posting times", () => {
  // 20:00 UTC Sunday is 01:30 Monday in India (+330 minutes).
  const videos = [vid("a", 100, 10, { publishedAt: "2026-05-17T20:00:00Z" })];
  const s = research.summarizeChannel({ channelId: "UC1" }, videos, { now: NOW, utcOffsetMinutes: 330 });
  assert.equal(s.bestDays[0].label, "Monday");
  assert.equal(s.bestHours[0].label, "01:00");
});

test("summarizeChannel handles an empty channel", () => {
  const s = research.summarizeChannel({ channelId: "UC1" }, [], { now: NOW });
  assert.equal(s.medianViews, null);
  assert.deepEqual(s.outliers, []);
  assert.equal(s.uploadsPerWeek, null);
});

test("auditVideos ranks the costliest failing checks", () => {
  const a = research.auditVideos([vid("a", 1, 10), vid("b", 1, 10, { title: "A reasonably long descriptive title here" })]);
  assert.equal(a.videos, 2);
  assert.ok(a.averageScore < 30);
  assert.equal(a.commonIssues[0].failingVideos, 2);
  assert.equal(a.lowest.length, 2);
});

test("rankOutliers uses channel average views per video", () => {
  const ranked = research.rankOutliers(
    [vid("x", 1000, 10, { channelId: "A" }), vid("y", 1000, 10, { channelId: "B" }), vid("z", 5, 10, { channelId: "missing" })],
    [{ channelId: "A", views: 10000, videoCount: 100, subscribers: 50 }, { channelId: "B", views: 1e6, videoCount: 10, subscribers: 1e4 }],
    { now: NOW }
  );
  assert.deepEqual(ranked.map((r) => [r.videoId, r.outlierRatio]), [["x", 10], ["y", 0.01], ["z", null]]);
  assert.equal(ranked[0].viewsPerSubscriber, 20);
  assert.equal(ranked[0].viewsPerDay, 100);
});

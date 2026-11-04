// Offline MCP integration test: the real server over stdio, talking to a local fake Data API.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const CH = { A: "UCaaaaaaaaaaaaaaaaaaaaaa", B: "UCbbbbbbbbbbbbbbbbbbbbbb", C: "UCcccccccccccccccccccccc" };

const videos = {
  vid00000001: { channel: CH.A, title: "Sourdough Bread for Beginners", tags: ["sourdough bread", "baking"], views: 10000, days: 30, dur: "PT12M" },
  vid00000002: { channel: CH.A, title: "Sourdough Starter Mistakes", tags: ["sourdough starter"], views: 90000, days: 20, dur: "PT9M" },
  vid00000003: { channel: CH.A, title: "Quick bread hack", tags: ["bread"], views: 3000, days: 10, dur: "PT45S" },
  vid00000004: { channel: CH.B, title: "Best Sourdough Bread Recipe", tags: ["sourdough bread"], views: 500000, days: 15, dur: "PT15M" },
  vid00000005: { channel: CH.C, title: "Sourdough bread in 1 day", tags: [], views: 2000, days: 2, dur: "PT8M" },
};
const channels = {
  [CH.A]: { title: "Home Baker", handle: "@homebaker", subs: 50000, views: 1000000, count: 100 },
  [CH.B]: { title: "Bread Lab", handle: "@breadlab", subs: 800000, views: 50000000, count: 500 },
  [CH.C]: { title: "Crumb Club", handle: "@crumbclub", subs: 1000, views: 20000, count: 10 },
};
const quota = { search: 0, other: 0 };
let currentTitle1 = videos.vid00000001.title;

function videoItem(id) {
  const v = videos[id];
  return { id, snippet: { title: id === "vid00000001" ? currentTitle1 : v.title, description: `About ${v.title}`, tags: v.tags, channelId: v.channel,
    channelTitle: channels[v.channel].title, publishedAt: iso(v.days), categoryId: "26", thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hq.jpg` } } },
    statistics: { viewCount: String(v.views), likeCount: String(v.views / 20), commentCount: String(v.views / 200) }, contentDetails: { duration: v.dur } };
}
function channelItem(id) {
  const c = channels[id];
  return { id, snippet: { title: c.title, customUrl: c.handle, description: "desc", publishedAt: iso(900) },
    statistics: { subscriberCount: String(c.subs), viewCount: String(c.views), videoCount: String(c.count) },
    contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } } };
}

function handle(url) {
  const p = url.searchParams;
  const resource = url.pathname.split("/").pop();
  if (p.get("key") !== "test-key") return [400, { error: { message: "API key not valid", errors: [{ reason: "keyInvalid" }] } }];
  if (resource === "search") {
    quota.search++;
    const items = p.get("type") === "channel"
      ? Object.keys(channels).map((id) => ({ id: { channelId: id } }))
      : Object.keys(videos).filter((id) => videos[id].title.toLowerCase().includes((p.get("q") ?? "").split(" ")[0].toLowerCase())).map((id) => ({ id: { videoId: id } }));
    return [200, { items }];
  }
  quota.other++;
  if (resource === "videos") {
    if (p.get("chart") === "mostPopular") return [200, { items: Object.keys(videos).map(videoItem) }];
    return [200, { items: p.get("id").split(",").filter((id) => videos[id]).map(videoItem) }];
  }
  if (resource === "channels") {
    if (p.get("forHandle")) {
      const id = Object.keys(channels).find((k) => channels[k].handle === p.get("forHandle"));
      return [200, { items: id ? [channelItem(id)] : [] }];
    }
    return [200, { items: p.get("id").split(",").filter((id) => channels[id]).map(channelItem) }];
  }
  if (resource === "playlistItems") {
    const ch = `UC${p.get("playlistId").slice(2)}`;
    return [200, { items: Object.keys(videos).filter((id) => videos[id].channel === ch).map((id) => ({ contentDetails: { videoId: id } })) }];
  }
  if (resource === "videoCategories") return [200, { items: [{ id: "26", snippet: { title: "Howto & Style", assignable: true } }, { id: "18", snippet: { title: "Short Movies", assignable: false } }] }];
  if (resource === "commentThreads") {
    if (p.get("videoId") === "vid00000005") return [403, { error: { message: "The video identified by the videoId parameter has disabled comments.", errors: [{ reason: "commentsDisabled" }] } }];
    return [200, { items: [
      { id: "c1", snippet: { totalReplyCount: 1, topLevelComment: { snippet: { authorDisplayName: "Ann", textDisplay: "How long should I proof the dough?", likeCount: 40, publishedAt: iso(3) } } }, replies: { comments: [{ snippet: { authorDisplayName: "Home Baker", textDisplay: "About 4 hours", likeCount: 5 } }] } },
      { id: "c2", snippet: { totalReplyCount: 0, topLevelComment: { snippet: { authorDisplayName: "Bo", textDisplay: "Great video", likeCount: 90, publishedAt: iso(2) } } } },
    ] }];
  }
  return [404, { error: { message: "unknown" } }];
}

let http, home, client;
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { error: r.isError ? text : null, data: r.isError ? null : JSON.parse(text) };
};

test.before(async () => {
  http = createServer((req, res) => {
    const [status, body] = handle(new URL(req.url, "http://x"));
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  home = await mkdtemp(join(tmpdir(), "tubelens-test-"));
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [new URL("../mcp/server.mjs", import.meta.url).pathname],
    env: { PATH: process.env.PATH, YOUTUBE_API_KEY: "test-key", TUBELENS_HOME: home,
      TUBELENS_YOUTUBE_API_BASE: `http://127.0.0.1:${http.address().port}/youtube/v3/` },
  }));
});
test.after(async () => {
  await client?.close();
  http?.close();
  await rm(home, { recursive: true, force: true });
});

test("advertises the full tool and prompt set", async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["channel_report", "channel_videos", "compare_channels", "get_channels", "get_videos", "keyword_ideas", "library",
    "score_metadata", "search_channels", "search_videos", "similar_channels", "similar_videos", "trend_categories", "trending_videos",
    "video_comments", "video_history"]);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ["channel_audit", "comment_insights", "title_review", "video_chapters", "video_ideas", "write_description", "write_script", "write_titles"]);
});

test("get_videos batches with subscribers and SEO, reports missing ids", async () => {
  const { data } = await call("get_videos", { videos: ["vid00000001", "https://youtu.be/vid00000004", "nonexist000"] });
  assert.deepEqual(data.videos.map((v) => v.videoId), ["vid00000001", "vid00000004"]);
  assert.equal(data.videos[1].channelSubscribers, 800000);
  assert.equal(data.videos[0].description, undefined); // batch → descriptions opt-in
  assert.ok(Number.isInteger(data.videos[0].seo.score));
  assert.deepEqual(data.notFound, ["nonexist000"]);
});

test("get_channels resolves handles and ids; unknown handles are reported", async () => {
  const { data } = await call("get_channels", { channels: ["@breadlab", CH.A, "@nobody"] });
  assert.deepEqual(data.channels.map((c) => c.title), ["Bread Lab", "Home Baker"]);
  assert.equal(data.channels[0].averageViewsPerVideo, 100000);
  assert.equal(data.errors[0].channel, "@nobody");
});

test("channel_videos filters formats and sorts by outlier", async () => {
  const { data } = await call("channel_videos", { channel: "@homebaker", format: "long", sort: "outlier" });
  assert.deepEqual(data.videos.map((v) => v.videoId), ["vid00000002", "vid00000001"]);
  assert.equal(data.matched, 2);
  const shorts = await call("channel_videos", { channel: "@homebaker", format: "shorts" });
  assert.deepEqual(shorts.data.videos.map((v) => v.videoId), ["vid00000003"]);
});

test("search_channels, trend_categories and trending chart", async () => {
  assert.equal((await call("search_channels", { query: "bread" })).data.channels.length, 3);
  assert.deepEqual((await call("trend_categories", {})).data.categories, [{ id: "26", title: "Howto & Style" }]);
  const chart = await call("trending_videos", { mode: "chart" });
  assert.equal(chart.data.videos.length, 5);
  assert.match((await call("trending_videos", { mode: "rising" })).error, /needs a query/);
});

test("trending rising ranks by views per hour", async () => {
  const { data } = await call("trending_videos", { mode: "rising", query: "sourdough" });
  const vph = data.videos.map((v) => v.viewsPerHour);
  assert.deepEqual(vph, [...vph].sort((a, b) => b - a));
});

test("similar_videos excludes the seed's own channel", async () => {
  const { data } = await call("similar_videos", { video: "vid00000001" });
  assert.equal(data.searchedFor, "sourdough bread");
  assert.ok(data.results.length > 0);
  assert.ok(data.results.every((r) => r.videoId !== "vid00000001" && r.channelTitle !== "Home Baker"));
});

test("similar_channels excludes the channel itself", async () => {
  const { data } = await call("similar_channels", { channel: "@homebaker", topics: 1 });
  assert.equal(data.topics.length, 1);
  assert.ok(data.similar.every((c) => c.channelId !== CH.A));
});

test("video_comments returns a digest and maps disabled comments", async () => {
  const { data } = await call("video_comments", { video: "vid00000001", include_replies: true });
  assert.equal(data.digest.questions, 1);
  assert.equal(data.digest.topLiked[0].likes, 90);
  assert.equal(data.comments[0].replies[0].text, "About 4 hours");
  assert.match((await call("video_comments", { video: "vid00000005" })).error, /disabled/);
});

test("video_history accumulates snapshots and detects title changes", async () => {
  await call("video_history", { video: "vid00000001" });
  currentTitle1 = "Sourdough Bread for Total Beginners";
  const { data } = await call("video_history", { video: "vid00000001" });
  assert.ok(data.snapshots >= 2);
  assert.deepEqual(data.changes.map((c) => [c.field, c.to]), [["title", "Sourdough Bread for Total Beginners"]]);
  currentTitle1 = videos.vid00000001.title;
});

test("library saves, lists and removes competitors and bookmarks on disk", async () => {
  assert.equal((await call("library", { collection: "competitors", action: "add", items: ["@breadlab", "@breadlab"] })).data.added, 1);
  assert.equal((await call("library", { collection: "bookmarks", action: "add", items: ["https://youtu.be/vid00000004", "Idea: proofing times"], note: "n" })).data.total, 2);
  const list = await call("library", { collection: "bookmarks", action: "list" });
  assert.deepEqual(list.data.items.map((i) => i.key), ["vid00000004", "idea: proofing times"]);
  assert.equal((await call("library", { collection: "bookmarks", action: "remove", items: ["vid00000004"] })).data.total, 1);
  const onDisk = JSON.parse(await readFile(join(home, "library.json"), "utf8"));
  assert.equal(onDisk.competitors[0].key, CH.B);
});

test("channel_report and compare_channels still work", async () => {
  const report = await call("channel_report", { channel: "@homebaker" });
  assert.equal(report.data.channel.title, "Home Baker");
  assert.ok(report.data.seoAudit.videos === 3);
  const cmp = await call("compare_channels", { channels: ["@homebaker", "@breadlab"] });
  assert.equal(cmp.data.channels.length, 2);
});

test("API errors surface as tool errors with a reason", async () => {
  const bad = new Client({ name: "t2", version: "0" });
  await bad.connect(new StdioClientTransport({
    command: process.execPath, args: [new URL("../mcp/server.mjs", import.meta.url).pathname],
    env: { PATH: process.env.PATH, YOUTUBE_API_KEY: "wrong", TUBELENS_HOME: home,
      TUBELENS_YOUTUBE_API_BASE: `http://127.0.0.1:${http.address().port}/youtube/v3/` },
  }));
  const r = await bad.callTool({ name: "get_channels", arguments: { channels: ["@breadlab"] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^key_invalid/);
  await bad.close();
});

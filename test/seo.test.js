"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const seo = require("../lib/seo.js");
const yt = require("../lib/youtube.js");

const strong = {
  title: "Home Workout for Beginners – 20 Minute Full Body",
  description:
    "This home workout for beginners needs no equipment. " + "Follow along at your own pace. ".repeat(40) +
    "\n0:00 Warm up\n2:30 Squats\n6:10 Push ups\n12:00 Cool down\n#homeworkout #fitness",
  tags: ["home workout for beginners", "home workout", "beginner workout", "full body workout",
    "20 minute workout", "no equipment workout", "workout at home", "easy workout"],
};

test("well-optimised video scores 100 and every check passes", () => {
  const r = seo.score(strong);
  assert.equal(r.keyword, "home workout for beginners");
  assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => c.id), []);
  assert.equal(r.score, 100);
});

test("weights sum to 100", () => {
  assert.equal(seo.score({}).checks.reduce((n, c) => n + c.weight, 0), 100);
});

test("empty input scores 0 without throwing", () => {
  const r = seo.score({});
  assert.equal(r.score, 0);
  assert.equal(r.keyword, "");
});

test("keyword matching is whole-word", () => {
  assert.equal(seo.containsPhrase("Best category picks", "cat"), false);
  assert.equal(seo.containsPhrase("My CAT video", "cat"), true);
  assert.equal(seo.containsPhrase("Café tour", "café"), true);
});

test("caller keyword overrides the default", () => {
  const r = seo.score({ ...strong, keyword: "yoga" });
  assert.equal(r.keyword, "yoga");
  assert.equal(r.checks.find((c) => c.id === "kw-title").pass, false);
});

test("chapters need 3+ stamps starting at 0:00", () => {
  assert.deepEqual(seo.chapters("0:00 a\n1:00 b\n1:01:30 c"), { count: 3, valid: true });
  assert.equal(seo.chapters("0:10 a\n1:00 b\n2:00 c").valid, false);
  assert.equal(seo.chapters("0:00 a\n1:00 b").valid, false);
});

test("tag characters count commas and quotes like YouTube", () => {
  assert.equal(seo.tagCharacters(["ab", "c d"]), 2 + (3 + 2) + 1);
  assert.equal(seo.tagCharacters([]), 0);
});

test("duplicate and blank tags are dropped case-insensitively", () => {
  assert.deepEqual(seo.cleanTags([" Cat ", "cat", "", "dog"]), ["Cat", "dog"]);
});

test("videoStats keeps unknowns null", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const s = seo.videoStats({ views: 2400, likes: 100, comments: 20, publishedAt: "2026-01-01T00:00:00Z", now });
  assert.equal(s.viewsPerHour, 100);
  assert.equal(s.engagementRate, 5);
  assert.deepEqual(seo.videoStats({}), { hoursSincePublish: null, viewsPerHour: null, engagementRate: null });
});

test("parseWatchPage reads player response including braces inside strings", () => {
  const player = {
    videoDetails: { videoId: "abc123def45", title: "T {x}", shortDescription: "d \"q\" }", keywords: ["k1", "k2"],
      viewCount: "1234", lengthSeconds: "61", channelId: "UC1", author: "Chan", isLiveContent: false },
    microformat: { playerMicroformatRenderer: { publishDate: "2026-01-01T00:00:00-08:00", category: "Education" } },
  };
  const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = {};</script>`;
  const v = yt.parseWatchPage(html);
  assert.equal(v.title, "T {x}");
  assert.equal(v.description, 'd "q" }');
  assert.deepEqual(v.tags, ["k1", "k2"]);
  assert.equal(v.views, 1234);
  assert.equal(v.category, "Education");
  assert.equal(yt.parseWatchPage("<html>nothing</html>"), null);
});

test("videoIdFromUrl handles watch, shorts and youtu.be", () => {
  assert.equal(yt.videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1"), "dQw4w9WgXcQ");
  assert.equal(yt.videoIdFromUrl("https://www.youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(yt.videoIdFromUrl("https://youtu.be/xyz987abc12"), "xyz987abc12");
  assert.equal(yt.videoIdFromUrl("https://www.youtube.com/feed/subscriptions"), null);
});

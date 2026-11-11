"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../lib/clips.js");

// 100 segments over `total` seconds; `level(i)` gives each segment's intensity.
const heat = (level, total = 600) =>
  Array.from({ length: 100 }, (_, i) => ({ start: (i * total) / 100, duration: total / 100, intensity: level(i) }));
const introSpike = (i) => (i < 4 ? 1 - i * 0.2 : 0.1);

test("formatTime and parseTime round-trip common formats", () => {
  assert.equal(C.formatTime(0), "0:00");
  assert.equal(C.formatTime(130), "2:10");
  assert.equal(C.formatTime(3730), "1:02:10");
  assert.equal(C.parseTime("2:10"), 130);
  assert.equal(C.parseTime("1:02:10"), 3730);
  assert.equal(C.parseTime("130"), 130);
  assert.equal(C.parseTime("2m10s"), 130);
  assert.equal(C.parseTime("1h"), 3600);
  assert.equal(C.parseTime("soon"), null);
  assert.equal(C.parseTime(""), null);
});

test("heatmapFromInitialData reads the current and the older layout", () => {
  const current = { frameworkUpdates: { entityBatchUpdate: { mutations: [{ payload: { other: 1 } }, { payload: { macroMarkersListEntity: {
    externalVideoId: "abc", markersList: { markerType: "MARKER_TYPE_HEATMAP", markers: [
      { startMillis: "2000", durationMillis: "2000", intensityScoreNormalized: 0.5 },
      { startMillis: "0", durationMillis: "2000", intensityScoreNormalized: 1 }] } } } }] } } };
  assert.deepEqual(C.heatmapFromInitialData(current, "abc"), [{ start: 0, duration: 2, intensity: 1 }, { start: 2, duration: 2, intensity: 0.5 }]);
  assert.deepEqual(C.heatmapFromInitialData(current, "other-video"), []);

  const legacy = { playerOverlays: { a: { b: [{ heatMarkers: [
    { heatMarkerRenderer: { timeRangeStartMillis: 0, markerDurationMillis: 3000, heatMarkerIntensityScoreNormalized: 0.2 } }] }] } } };
  assert.deepEqual(C.heatmapFromInitialData(legacy), [{ start: 0, duration: 3, intensity: 0.2 }]);
  assert.deepEqual(C.heatmapFromInitialData(null), []);
  assert.deepEqual(C.heatmapFromInitialData({ contents: {} }), []);
});

test("suggestClips skips the opening spike and finds the real peak", () => {
  const hm = heat((i) => (i === 60 ? 0.8 : Math.abs(i - 60) === 1 ? 0.6 : introSpike(i)));
  const [best] = C.suggestClips(hm, { durationSeconds: 600 });
  assert.ok(best.start <= 360 && best.end >= 366, `${best.start}-${best.end}`);
  assert.equal(best.peak, 360);
  assert.equal(best.intensity, 80);
  assert.ok(C.suggestClips(hm, { durationSeconds: 600 }).every((c) => c.start >= 24));
});

test("suggestClips respects length limits, count and never overlaps", () => {
  const hm = heat((i) => 0.5 + 0.4 * Math.sin(i / 4)); // many bumps
  const clips = C.suggestClips(hm, { durationSeconds: 600, count: 4, minSeconds: 20, maxSeconds: 40 });
  assert.equal(clips.length, 4);
  for (const c of clips) {
    assert.ok(c.end - c.start >= 20 && c.end - c.start <= 40, `${c.start}-${c.end}`);
    assert.equal(c.length, c.end - c.start);
    assert.ok(c.end <= 600);
  }
  for (let i = 0; i < clips.length; i++)
    for (let j = i + 1; j < clips.length; j++) assert.ok(clips[i].end <= clips[j].start || clips[j].end <= clips[i].start);
});

test("suggestClips ignores cold stretches and handles empty input", () => {
  const hm = heat((i) => (i === 50 ? 0.9 : introSpike(i) > 0.1 ? introSpike(i) : 0.02));
  assert.equal(C.suggestClips(hm, { durationSeconds: 600, count: 5 }).length, 1);
  assert.deepEqual(C.suggestClips([], {}), []);
});

test("suggestClips picks the choruses of an evenly watched video instead of tiling it", () => {
  // A music video: a broad warm plateau with two choruses a little above it.
  const hm = heat((i) => (i < 3 ? 0.9 - i * 0.1 : Math.abs(i - 30) <= 2 ? 1 - Math.abs(i - 30) * 0.03
    : Math.abs(i - 60) <= 2 ? 0.97 - Math.abs(i - 60) * 0.03 : 0.8), 280);
  const clips = C.suggestClips(hm, { durationSeconds: 280, count: 5 });
  assert.equal(clips.length, 2, JSON.stringify(clips));
  assert.ok(clips[0].start <= 84 && clips[0].end >= 87, "first chorus first");
  assert.ok(clips[1].start <= 168 && clips[1].end >= 171);
  assert.ok(clips.every((c) => c.length <= 30), "a clip covers the chorus, not a whole minute of plateau");
  assert.equal(clips[0].lift, 1.3);
});

test("suggestClips suggests nothing for a Short whose heatmap only falls from the start", () => {
  const hm = heat((i) => Math.max(0.005, Math.exp(-i / 6) + (i === 90 ? 0.01 : 0)), 60);
  assert.deepEqual(C.suggestClips(hm, { durationSeconds: 60 }), []);
  const flat = heat(() => 0.5, 300);
  assert.deepEqual(C.suggestClips(flat, { durationSeconds: 300 }), []);
});

test("heatProfile finds the end of the opening spike, the typical level and the peak", () => {
  const hm = heat((i) => (i === 60 ? 0.8 : introSpike(i)));
  const p = C.heatProfile(hm, { durationSeconds: 600 });
  assert.ok(p.intro >= 18 && p.intro <= 30, String(p.intro));
  assert.equal(p.typical, 0.1);
  assert.equal(p.peak, 0.8);
  assert.equal(C.heatProfile([]), null);
  assert.equal(C.suggestClips(hm, { durationSeconds: 600 })[0].lift, 8);
});

test("suggestClips keeps clips inside short videos", () => {
  const hm = heat((i) => (i === 80 ? 1 : 0.3), 40);
  for (const c of C.suggestClips(hm, { durationSeconds: 40, minSeconds: 15, maxSeconds: 60 })) {
    assert.ok(c.start >= 0 && c.end <= 40);
    assert.ok(c.end - c.start <= 40);
  }
});

test("chapterList follows YouTube's chapter rule", () => {
  assert.deepEqual(C.chapterList("Intro text\n0:00 Start\n1:30 - Middle\n(12:05) End part"), [
    { start: 0, title: "Start" }, { start: 90, title: "Middle" }, { start: 725, title: "End part" }]);
  assert.deepEqual(C.chapterList("1:00 a\n2:00 b\n3:00 c"), [], "must start at 0:00");
  assert.deepEqual(C.chapterList("0:00 a\n2:00 b"), [], "needs 3 chapters");
  assert.equal(C.chapterAt(C.chapterList("0:00 a\n2:00 b\n5:00 c"), 299).title, "b");
});

test("timestampMentions groups nearby stamps, one count per comment", () => {
  const out = C.timestampMentions([
    { text: "4:05 is the best part", likes: 10 },
    { text: "lol 4:08 and also 4:09", likes: 3 },
    { text: "at 1:02:00?", likes: 1 },
    { text: "12:30", likes: 50 },
    { text: "posted at 10:00:00 sharp", likes: 0 },
  ], { durationSeconds: 1000 });
  assert.equal(out[0].at, 245);
  assert.equal(out[0].mentions, 2);
  assert.equal(out[0].likes, 13);
  assert.ok(!out.some((m) => m.at > 1000), "stamps past the end are dropped");
  assert.equal(out.find((m) => m.at === 750).mentions, 1);
});

test("clipAround starts a little before the moment and stays in the video", () => {
  assert.deepEqual(C.clipAround(100, { durationSeconds: 600, minSeconds: 15, maxSeconds: 60 }), { start: 97, end: 127 });
  assert.deepEqual(C.clipAround(1, { durationSeconds: 600 }), { start: 0, end: 30 });
  assert.deepEqual(C.clipAround(595, { durationSeconds: 600 }), { start: 570, end: 600 });
});

test("exports: links, text list, chapters and CSV", () => {
  assert.equal(C.shareUrl("abc", 130.7), "https://youtu.be/abc?t=130");
  assert.equal(C.embedUrl("abc", 10.2, 20.1), "https://www.youtube.com/embed/abc?start=10&end=21");
  assert.equal(C.watchUrl("abc", 5), "https://www.youtube.com/watch?v=abc&t=5s");
  const clips = [{ start: 130, end: 168, note: "Best tip" }, { start: 30, end: 50, note: "" }];
  assert.equal(C.clipsAsText(clips, "abc"), "0:30–0:50 (20s) — https://youtu.be/abc?t=30\n2:10–2:48 (38s) Best tip — https://youtu.be/abc?t=130");
  assert.equal(C.clipsAsChapters(clips), "0:00 Intro\n0:30 Clip at 0:30\n2:10 Best tip");
  assert.equal(C.clipsAsChapters([{ start: 4, end: 20, note: "Hook" }, { start: 9, end: 30, note: "too close" }]), "0:00 Hook");
  const csv = C.clipsAsCsv([{ videoId: "abc", title: 'Say "hi", ok', start: 130, end: 168, note: "Best tip" }]);
  assert.equal(csv.split("\n")[1], 'abc,"Say ""hi"", ok",2:10,2:48,130,168,38,Best tip,https://youtu.be/abc?t=130');
});

test("sparkline has the requested width", () => {
  const line = C.sparkline(heat((i) => i / 100), 20);
  assert.equal(line.length, 20);
  assert.equal(line[0], "▁");
  assert.equal(line.at(-1), "█");
  assert.equal(C.sparkline([]), "");
});

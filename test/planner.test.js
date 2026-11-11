"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../lib/planner.js");

const NOW = Date.parse("2026-11-11T12:00:00Z");
const DAY = 86400000;
// A video `daysAgo` days before NOW at `hour`:00 UTC.
const vid = (daysAgo, views, { hour = 17, duration = 600 } = {}) => {
  const d = new Date(NOW - daysAgo * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return { videoId: `v${daysAgo}`, publishedAt: d.toISOString(), views, durationSeconds: duration };
};

test("postingGrid compares each day and time block with the channel median", () => {
  // Weekly uploads on Tuesdays (NOW is a Wednesday: 8, 15, 22… days ago) and Sundays, which do 3× better.
  const videos = Array.from({ length: 12 }, (_, i) => vid(8 + i * 7, 1000)).concat(Array.from({ length: 12 }, (_, i) => vid(10 + i * 7, 3000)));
  const grid = P.postingGrid(videos, { now: NOW });
  assert.equal(grid.videos, 24);
  assert.equal(grid.cells.length, 56);
  const [best] = P.bestSlots(grid);
  assert.equal(best.label, "Sunday 15:00–18:00");
  assert.equal(best.videos, 12);
  assert.equal(best.ratio, 1.5);
  assert.equal(grid.cells.find((c) => c.label === "Tuesday 15:00–18:00").ratio, 0.5);
  // The time zone shifts the cells.
  const shifted = P.postingGrid(videos, { now: NOW, utcOffsetMinutes: 330 });
  assert.equal(P.bestSlots(shifted)[0].label, "Sunday 21:00–24:00");
  // Videos younger than a week are left out.
  assert.equal(P.postingGrid([vid(2, 99999)], { now: NOW }).videos, 0);
});

test("bestSlots needs enough uploads in a slot", () => {
  const grid = P.postingGrid([vid(8, 100000), vid(9, 10), vid(16, 10), vid(23, 10)], { now: NOW });
  assert.ok(P.bestSlots(grid).every((s) => s.videos >= 2));
  assert.deepEqual(P.bestSlots(null), []);
});

test("cadence measures rate, gaps, steadiness and the Shorts share", () => {
  const steady = Array.from({ length: 10 }, (_, i) => vid(3 + i * 7, 100));
  const c = P.cadence(steady, { now: NOW });
  assert.equal(c.perWeek, 1);
  assert.equal(c.medianGapDays, 7);
  assert.equal(c.consistency, "steady");
  assert.equal(c.daysSinceLast, 2.8);
  assert.equal(c.shortsShare, 0);

  const bursty = [vid(1, 1), vid(2, 1), vid(3, 1, { duration: 40 }), vid(40, 1), vid(41, 1), vid(80, 1)];
  const b = P.cadence(bursty, { now: NOW });
  assert.equal(b.consistency, "irregular");
  assert.equal(b.longestGapDays, 39);
  assert.equal(b.shortsShare, 17);
  // A sample shorter than 90 days isn't diluted: 3 uploads a day for 10 days is ~21 a week.
  const daily = Array.from({ length: 30 }, (_, i) => vid(i / 3 + 0.1, 1));
  assert.ok(P.cadence(daily, { now: NOW }).perWeek >= 20);
  assert.equal(P.cadence([]), null);
});

test("recommendations react to gaps, steadiness, slots and formats", () => {
  const tips = P.recommendations({
    cadence: { daysSinceLast: 40, medianGapDays: 7, consistency: "irregular", longestGapDays: 40, perWeek: 0.5 },
    slots: [{ label: "Tuesday 15:00–18:00", ratio: 1.8, videos: 4 }],
    formats: { likelyShorts: { videos: 0, medianViews: null }, longForm: { videos: 20, medianViews: 5000 } },
  });
  assert.match(tips.join("\n"), /40 days since the last upload/);
  assert.match(tips.join("\n"), /irregular/);
  assert.match(tips.join("\n"), /Tuesday 15:00–18:00 got 1.8×/);
  assert.match(tips.join("\n"), /No Shorts/);
  const shortsWin = P.recommendations({ formats: { likelyShorts: { videos: 5, medianViews: 9000 }, longForm: { videos: 5, medianViews: 3000 } } });
  assert.match(shortsWin.join("\n"), /Shorts get 3× the median views/);
  assert.match(P.recommendations().at(-1), /pin a comment/);
});

test("planSchedule puts long-form on the best days and spreads Shorts between them", () => {
  const from = new Date(2026, 10, 8); // Sunday 8 Nov 2026
  const slots = P.planSchedule({ from, weeks: 2, longPerWeek: 1, shortsPerWeek: 2, longDays: [2] });
  const days = (type) => slots.filter((s) => s.type === type).map((s) => P.parseDate(s.date).getDay());
  assert.deepEqual(days("long"), [2, 2]);
  assert.equal(days("short").length, 4);
  assert.ok(days("short").every((d) => d !== 2), "Shorts get days of their own");
  assert.deepEqual([...new Set(days("short"))].sort(), [0, 5], "Tue, Fri, Sun: as evenly spread as a week allows");
  assert.equal(slots[0].date, "2026-11-10");
  assert.equal(slots.find((s) => s.type === "long").time, "17:00");
  assert.ok(slots.every((s) => s.date > "2026-11-08"), "starts after today");
  // Without history, long-form defaults to Tuesday then Thursday.
  assert.deepEqual([...new Set(P.planSchedule({ from, weeks: 1, longPerWeek: 2, shortsPerWeek: 0 }).map((s) => P.parseDate(s.date).getDay()))], [2, 4]);
  // More Shorts than free days share days with long-form.
  assert.equal(P.planSchedule({ from, weeks: 1, longPerWeek: 3, shortsPerWeek: 7 }).filter((s) => s.type === "short").length, 7);
});

test("nextFreeDate prefers empty days, then days without that type", () => {
  const from = new Date(2026, 10, 8);
  const items = [{ date: "2026-11-09", type: "long" }, { date: "2026-11-10", type: "short" }];
  assert.equal(P.nextFreeDate(items, { type: "short", from }), "2026-11-11");
  const full = Array.from({ length: 5 }, (_, i) => ({ date: P.isoDate(P.addDays(from, i + 1)), type: "long" }));
  assert.equal(P.nextFreeDate(full, { type: "short", from, horizonDays: 5 }), "2026-11-09");
});

test("shortFromClip plans a clip on the next free day with a link back", () => {
  const from = new Date(2026, 10, 8);
  const item = P.shortFromClip([{ date: "2026-11-09", type: "long" }], { id: "c1", start: 130, end: 160, note: "" },
    { videoId: "abc", title: "Sourdough masterclass" }, { time: "12:30", from });
  assert.equal(item.type, "short");
  assert.equal(item.date, "2026-11-10");
  assert.equal(item.time, "12:30");
  assert.equal(item.clipId, "c1");
  assert.equal(item.title, "Short from “Sourdough masterclass”");
  assert.deepEqual(item.clip, { videoId: "abc", start: 130, end: 160, videoTitle: "Sourdough masterclass" });
  assert.match(item.notes, /From 2:10–2:40 of “Sourdough masterclass”/);
  assert.equal(P.shortFromClip([], { id: "c2", start: 0, end: 20, note: "The hook" }, { videoId: "x" }, { from }).title, "The hook");
});

test("newItem, sortItems, checklists and progress", () => {
  const a = P.newItem({ title: "B", date: "2026-11-12", time: "17:00" });
  const b = P.newItem({ title: "A", date: "2026-11-12", time: "09:00", type: "short" });
  const c = P.newItem({ title: "Idea" });
  assert.equal(a.status, "idea");
  assert.notEqual(a.id, b.id);
  assert.deepEqual(P.sortItems([c, a, b]).map((i) => i.title), ["A", "B", "Idea"]);
  assert.equal(P.checklist("short").length, 6);
  assert.equal(P.checklist("nope"), P.checklist("long"));
  assert.deepEqual(P.progress({ ...a, checks: { title: true, thumb: true, nope: true } }), { done: 2, total: 12 });
});

test("toICS writes timed and all-day events, escaped and folded", () => {
  const items = [
    { id: "1", title: "Sourdough, part 2; the bake", type: "long", date: "2026-11-12", time: "17:30", status: "ready", notes: "Line one\nLine two" },
    { id: "2", title: "", type: "short", date: "2026-11-13", time: "", status: "idea", clip: { videoId: "abc", start: 130.4, end: 160 } },
    { id: "3", title: "Undated idea", type: "long", date: null },
    { id: "4", title: "x".repeat(120), type: "post", date: "2026-11-14", time: "09:00", status: "idea" },
  ];
  const ics = P.toICS(items, { now: new Date("2026-11-11T10:00:00Z") });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 3);
  assert.match(ics, /DTSTART:20261112T173000\r\nDURATION:PT30M/);
  assert.match(ics, /SUMMARY:Video: Sourdough\\, part 2\\; the bake/);
  assert.match(ics, /DESCRIPTION:Status: ready\\nLine one\\nLine two/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261113\r\nDURATION:P1D/);
  assert.match(ics, /SUMMARY:Short: Untitled/);
  assert.match(ics, /watch\?v=abc&t=130s/);
  assert.match(ics, /DTSTAMP:20261111T100000Z/);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  assert.match(ics, /\r\n x/, "long lines are folded");
});

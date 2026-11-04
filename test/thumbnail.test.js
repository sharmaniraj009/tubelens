"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../lib/thumbnail-checks.js");

test("hexToRgb parses short and long forms and rejects junk", () => {
  assert.deepEqual(t.hexToRgb("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(t.hexToRgb("ff8000"), { r: 255, g: 128, b: 0 });
  assert.equal(t.hexToRgb("red"), null);
});

test("contrast ratio matches WCAG reference values", () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  assert.equal(t.contrastRatio(white, black).toFixed(0), "21");
  assert.equal(t.contrastRatio(black, white).toFixed(0), "21");
  assert.equal(t.contrastRatio(white, white), 1);
  assert.equal(t.contrastRatio(white, { r: 118, g: 118, b: 118 }).toFixed(1), "4.5");
});

test("averageColor weights by alpha and clips to the image", () => {
  const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 0, 0, 255, 0, 0]);
  const img = { data, width: 2, height: 2 };
  assert.deepEqual(t.averageColor(img, { x: 0, y: 0, w: 2, h: 1 }), { r: 127.5, g: 0, b: 127.5 });
  assert.deepEqual(t.averageColor(img, { x: -5, y: 1, w: 10, h: 5 }), { r: 0, g: 0, b: 0 }); // transparent row
  assert.equal(t.averageColor(img, { x: 5, y: 5, w: 1, h: 1 }), null);
});

test("cap height scales from 1280 to the 168px preview", () => {
  assert.equal(t.capHeightPx(160).toFixed(2), (160 * 0.7 * 168 / 1280).toFixed(2));
  assert.ok(t.capHeightPx(120) >= 8);
  assert.ok(t.capHeightPx(60) < 8);
});

test("word count spans layers and counts numbers", () => {
  assert.equal(t.countWords(["7 things", "you MISSED!", ""]), 4);
});

test("rotated AABB grows with rotation", () => {
  const a = t.rotatedAabb({ cx: 0, cy: 0, w: 100, h: 0, rotation: 90 });
  assert.ok(Math.abs(a.h - 100) < 1e-9 && Math.abs(a.w) < 1e-9);
});

test("runChecks flags small, low-contrast, wordy text and badge collisions", () => {
  const res = t.runChecks({
    texts: [
      { id: "a", name: "Headline", text: "one two three four five six", fontSize: 60, fill: "#777777", strokeWidth: 0, background: { r: 120, g: 120, b: 120 } },
    ],
    boxes: [{ id: "a", name: "Headline", aabb: { x: 1200, y: 680, w: 50, h: 20 } }],
    exportBytes: 3 * 1024 * 1024,
  });
  const byId = Object.fromEntries(res.map((r) => [r.id, r.status]));
  assert.deepEqual(byId, { "legible-a": "warn", "contrast-a": "warn", "word-count": "warn", "badge-zone": "warn", size: "warn" });
});

test("runChecks passes a clean design and lets a thick stroke rescue contrast", () => {
  const res = t.runChecks({
    texts: [
      { id: "a", name: "Big", text: "WAIT", fontSize: 180, fill: "#ffffff", strokeWidth: 8, background: { r: 230, g: 230, b: 230 } },
    ],
    boxes: [{ id: "a", name: "Big", aabb: { x: 50, y: 50, w: 400, h: 200 } }],
    exportBytes: 900 * 1024,
  });
  assert.ok(res.every((r) => r.status === "pass"), JSON.stringify(res));
});

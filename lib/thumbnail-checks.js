// TubeLens thumbnail checks. Pure functions shared by the thumbnail editor and tests.
(function (root) {
  "use strict";

  const LIMITS = Object.freeze({
    minCapHeightPx: 8, // cap height of text when the thumbnail is shown 168px wide (up-next list)
    previewWidth: 168,
    capHeightRatio: 0.7, // cap height ≈ 70% of the font size for typical sans fonts
    maxWords: 5,
    minContrast: 3,
    strokeOverridesContrastAt: 4,
    maxBytes: 2 * 1024 * 1024, // YouTube custom thumbnail limit
  });

  // Bottom-right area that YouTube covers with the duration badge (fractions of width/height).
  const BADGE_ZONE = Object.freeze({ x: 0.86, y: 0.88, w: 0.14, h: 0.12 });

  function hexToRgb(hex) {
    const m = String(hex ?? "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // WCAG 2.x relative luminance and contrast ratio.
  function luminance({ r, g, b }) {
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Average colour of `rect` in an ImageData-like {data, width, height}; alpha-weighted.
  // Returns null when the rect falls outside the image.
  function averageColor(image, rect) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(image.width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h));
    if (x1 <= x0 || y1 <= y0) return null;
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
    let r = 0, g = 0, b = 0, w = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * image.width + x) * 4;
        const a = image.data[i + 3] / 255;
        r += image.data[i] * a;
        g += image.data[i + 1] * a;
        b += image.data[i + 2] * a;
        w += a;
      }
    }
    if (w === 0) return { r: 0, g: 0, b: 0 }; // fully transparent canvas renders black on YouTube
    return { r: r / w, g: g / w, b: b / w };
  }

  function capHeightPx(fontSize, { canvasWidth = 1280, previewWidth = LIMITS.previewWidth, ratio = LIMITS.capHeightRatio } = {}) {
    return fontSize * ratio * (previewWidth / canvasWidth);
  }

  function countWords(texts) {
    return texts.reduce((n, t) => n + (String(t ?? "").match(/[\p{L}\p{N}'’]+/gu)?.length ?? 0), 0);
  }

  function badgeRect(width = 1280, height = 720) {
    return { x: width * BADGE_ZONE.x, y: height * BADGE_ZONE.y, w: width * BADGE_ZONE.w, h: height * BADGE_ZONE.h };
  }

  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // Axis-aligned bounds of a box given by centre, size and rotation in degrees.
  function rotatedAabb({ cx, cy, w, h, rotation = 0 }) {
    const t = (rotation * Math.PI) / 180;
    const c = Math.abs(Math.cos(t));
    const s = Math.abs(Math.sin(t));
    const bw = w * c + h * s;
    const bh = w * s + h * c;
    return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
  }

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  /**
   * texts:  [{ id, name, text, fontSize, fill (hex), strokeWidth, background ({r,g,b}|null) }]
   * boxes:  [{ id, name, aabb }]  — visible text/image/shape layers
   * canvas: { width, height }
   * exportBytes: PNG size in bytes, or null when not measured yet
   */
  function runChecks({ texts = [], boxes = [], canvas = { width: 1280, height: 720 }, exportBytes = null } = {}) {
    const out = [];
    const add = (id, status, label, detail, layerId) => out.push({ id, status, label, detail, layerId });

    if (texts.length === 0) add("text-none", "info", "No text layers", "Short, bold text usually helps a thumbnail.");

    for (const t of texts) {
      const cap = capHeightPx(t.fontSize, { canvasWidth: canvas.width });
      add(`legible-${t.id}`, cap >= LIMITS.minCapHeightPx ? "pass" : "warn", `${t.name} readable at small size`,
        `${cap.toFixed(1)} px letters at ${LIMITS.previewWidth}px wide (aim ≥ ${LIMITS.minCapHeightPx})`, t.id);

      const fg = hexToRgb(t.fill);
      if (fg && t.background) {
        const ratio = contrastRatio(fg, t.background);
        const stroked = (t.strokeWidth ?? 0) >= LIMITS.strokeOverridesContrastAt;
        const ok = ratio >= LIMITS.minContrast || stroked;
        add(`contrast-${t.id}`, ok ? "pass" : "warn", `${t.name} stands out from the background`,
          `contrast ${ratio.toFixed(1)}:1${stroked && ratio < LIMITS.minContrast ? " (thick outline compensates)" : ""} (aim ≥ ${LIMITS.minContrast}:1)`, t.id);
      }
    }

    const words = countWords(texts.map((t) => t.text));
    if (texts.length > 0) {
      add("word-count", words <= LIMITS.maxWords ? "pass" : "warn", `At most ${LIMITS.maxWords} words`, `${words} words`);
    }

    const zone = badgeRect(canvas.width, canvas.height);
    const covered = boxes.filter((b) => overlaps(b.aabb, zone));
    add("badge-zone", covered.length ? "warn" : "pass", "Bottom-right corner is clear of the duration badge",
      covered.length ? `covered: ${covered.map((b) => b.name).join(", ")}` : "nothing important there");

    if (exportBytes == null) add("size", "info", "File size under 2 MB", "measuring…");
    else add("size", exportBytes <= LIMITS.maxBytes ? "pass" : "warn", "File size under 2 MB",
      exportBytes <= LIMITS.maxBytes ? `PNG ${mb(exportBytes)}` : `PNG ${mb(exportBytes)} — export will switch to JPEG`);

    return out;
  }

  const api = { LIMITS, BADGE_ZONE, hexToRgb, luminance, contrastRatio, averageColor, capHeightPx, countWords,
    badgeRect, overlaps, rotatedAabb, runChecks };
  root.TubeLensThumb = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

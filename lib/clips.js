// Clip finding for YouTube videos: the "Most replayed" heatmap, description chapters and
// timestamps viewers mention in comments, turned into suggested clip ranges. Also time
// formatting and export helpers. Shared by the extension and the MCP server.
(function (root) {
  "use strict";

  // ---- Time ----

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  // "2:10", "1:02:10", "130", "2m10s" or "1h2m" → whole seconds; null when unreadable.
  function parseTime(text) {
    const t = String(text ?? "").trim().toLowerCase();
    if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
    let m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
    m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
    return null;
  }

  // ---- Sources ----

  const heatPoint = (start, duration, intensity) => ({ start: Number(start) / 1000, duration: Number(duration) / 1000, intensity: Number(intensity) });

  // YouTube's "Most replayed" heatmap from a watch page's ytInitialData, as
  // [{start, duration, intensity}] in seconds with intensity 0–1 (1 = the video's most
  // replayed segment). Empty when YouTube has none, which is usual for videos with few views.
  function heatmapFromInitialData(data, videoId) {
    let found = null;
    const take = (node) => {
      const entity = node?.macroMarkersListEntity;
      const list = entity?.markersList;
      if (list?.markerType === "MARKER_TYPE_HEATMAP" && Array.isArray(list.markers)) {
        if (!videoId || !entity.externalVideoId || entity.externalVideoId === videoId)
          found = list.markers.map((m) => heatPoint(m.startMillis, m.durationMillis, m.intensityScoreNormalized));
        return true;
      }
      if (Array.isArray(node?.heatMarkers)) { // layout used until 2023
        found = node.heatMarkers.map((h) => h.heatMarkerRenderer ?? h)
          .map((m) => heatPoint(m.timeRangeStartMillis, m.markerDurationMillis, m.heatMarkerIntensityScoreNormalized));
        return true;
      }
      return false;
    };
    // Usual location first; then a bounded walk in case YouTube moves it.
    for (const mutation of data?.frameworkUpdates?.entityBatchUpdate?.mutations ?? []) if (take(mutation?.payload)) break;
    if (!found) {
      (function walk(node, depth) {
        if (found || !node || typeof node !== "object" || depth > 60) return;
        if (take(node)) return;
        for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v, depth + 1);
      })(data, 0);
    }
    return (found ?? [])
      .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.duration) && m.duration > 0 && Number.isFinite(m.intensity))
      .sort((a, b) => a.start - b.start);
  }

  const CHAPTER_LINE = /^\s*[([]?((?:\d{1,2}:)?\d{1,2}:\d{2})[)\]]?\s*[-–—:|]?\s*(.*)$/;

  // Chapters from description timestamps, following YouTube's rule (3+ stamps, first at 0:00).
  function chapterList(description) {
    const out = [];
    for (const line of String(description ?? "").split(/\r?\n/)) {
      const m = line.match(CHAPTER_LINE);
      const start = m ? parseTime(m[1]) : null;
      if (start != null) out.push({ start, title: m[2].trim() || formatTime(start) });
    }
    out.sort((a, b) => a.start - b.start);
    return out.length >= 3 && out[0].start === 0 ? out : [];
  }

  const chapterAt = (chapters, seconds) => [...(chapters ?? [])].reverse().find((c) => c.start <= seconds) ?? null;

  const STAMP = /(?:^|[^\d:])((?:\d{1,2}:)?\d{1,2}:\d{2})(?![\d:])/g;

  // Moments viewers point at in comments ("3:45 had me crying"), grouped into buckets and
  // ranked by how many comments mention them, then by those comments' likes.
  function timestampMentions(comments, { durationSeconds = null, bucketSeconds = 10 } = {}) {
    const buckets = new Map();
    for (const c of comments ?? []) {
      const counted = new Set();
      for (const m of String(c.text ?? "").matchAll(STAMP)) {
        const at = parseTime(m[1]);
        if (at == null || (durationSeconds != null && at > durationSeconds)) continue;
        const key = Math.floor(at / bucketSeconds);
        if (counted.has(key)) continue;
        counted.add(key);
        const b = buckets.get(key) ?? { at, mentions: 0, likes: 0, samples: [] };
        b.at = Math.min(b.at, at);
        b.mentions++;
        b.likes += Number(c.likes) || 0;
        if (b.samples.length < 3) b.samples.push(String(c.text).slice(0, 200));
        buckets.set(key, b);
      }
    }
    return [...buckets.values()].sort((a, b) => b.mentions - a.mentions || b.likes - a.likes || a.at - b.at);
  }

  // ---- Suggestions ----

  const overlaps = (a, b) => a.start < b.end && b.start < a.end;

  // Fit [start, end] to the length limits and the video, keeping it around the same moment.
  function fitRange(start, end, { total, minLen, maxLen, min = 0 }) {
    if (end - start > maxLen) {
      const mid = (start + end) / 2;
      start = mid - maxLen / 2;
      end = mid + maxLen / 2;
    }
    if (end - start < minLen) {
      const pad = (minLen - (end - start)) / 2;
      start -= pad;
      end += pad;
    }
    if (start < min) { end += min - start; start = min; }
    if (end > total) { start = Math.max(min, start - (end - total)); end = total; }
    start = Math.floor(start);
    end = Math.min(Math.ceil(end), Math.ceil(total), start + Math.floor(maxLen));
    return { start, end };
  }

  // Non-overlapping clip suggestions around the heatmap's peaks, best first. The opening
  // seconds are skipped because nearly every heatmap starts high: that is where playback starts.
  function suggestClips(heatmap, { durationSeconds = null, count = 5, minSeconds = 15, maxSeconds = 60, skipIntroSeconds = null } = {}) {
    if (!heatmap?.length) return [];
    const last = heatmap[heatmap.length - 1];
    const total = durationSeconds ?? last.start + last.duration;
    const maxLen = Math.max(1, Math.min(maxSeconds, total));
    const minLen = Math.min(minSeconds, maxLen);
    const raw = heatmap.map((m) => m.intensity);
    const n = raw.length;
    const s = raw.map((x, i) => (raw[Math.max(i - 1, 0)] + 2 * x + raw[Math.min(i + 1, n - 1)]) / 4);
    let intro = skipIntroSeconds ?? Math.min(30, Math.max(5, total * 0.03));
    if (skipIntroSeconds == null) {
      // Also skip the slope down from the opening spike, within the first 15% of the video.
      let k = heatmap.findIndex((m) => m.start >= intro);
      while (k >= 0 && k < n - 1 && s[k + 1] < s[k] && heatmap[k + 1].start < total * 0.15) k++;
      if (k > 0) intro = heatmap[k].start;
    }

    // Local maxima after the intro, ranked by height and by how far they stand out.
    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (heatmap[i].start < intro) continue;
      if ((i > 0 && s[i - 1] > s[i]) || (i < n - 1 && s[i + 1] > s[i])) continue;
      let leftMin = s[i], rightMin = s[i];
      for (let j = i - 1; j >= 0 && s[j] <= s[i]; j--) leftMin = Math.min(leftMin, s[j]);
      for (let j = i + 1; j < n && s[j] <= s[i]; j++) rightMin = Math.min(rightMin, s[j]);
      const prominence = s[i] - Math.max(leftMin, rightMin);
      candidates.push({ i, rank: s[i] * 0.6 + prominence * 0.4 });
    }
    candidates.sort((a, b) => b.rank - a.rank);
    // Then the warmest remaining segments, so broad plateaus still yield several clips.
    const peaks = new Set(candidates.map((c) => c.i));
    for (const i of heatmap.map((m, k) => k).filter((k) => heatmap[k].start >= intro && !peaks.has(k)).sort((a, b) => s[b] - s[a]))
      candidates.push({ i, rank: -1 });

    // Ignore near-cold stretches: a clip should be at least a third as hot as the best one.
    const hottest = Math.max(0, ...candidates.map((c) => s[c.i]));
    const chosen = [];
    for (const { i } of candidates) {
      if (chosen.length >= count) break;
      if (s[i] < hottest / 3) continue;
      // Grow the window toward the warmer neighbour while it stays near the peak's heat.
      const seg = (k) => ({ start: heatmap[k].start, end: heatmap[k].start + heatmap[k].duration });
      if (chosen.some((c) => overlaps(c, seg(i)))) continue;
      let lo = i, hi = i;
      const floor = s[i] * 0.8;
      const free = (k) => !chosen.some((c) => overlaps(c, seg(k)));
      const span = () => seg(hi).end - seg(lo).start;
      while (span() < maxLen) {
        const left = lo > 0 && heatmap[lo - 1].start >= intro && s[lo - 1] >= floor && free(lo - 1) ? s[lo - 1] : -1;
        const right = hi < n - 1 && s[hi + 1] >= floor && free(hi + 1) ? s[hi + 1] : -1;
        if (left < 0 && right < 0) break;
        if (right >= left) hi++;
        else lo--;
      }
      const range = fitRange(seg(lo).start, seg(hi).end, { total, minLen, maxLen, min: Math.min(intro, seg(lo).start) });
      if (range.end - range.start < 1 || chosen.some((c) => overlaps(c, range))) continue;
      chosen.push({ ...range, length: range.end - range.start, peak: Math.round(heatmap[i].start), intensity: Math.round(raw[i] * 100) });
    }
    return chosen;
  }

  // A clip around a single moment (e.g. a timestamp from comments), starting a little before it.
  function clipAround(at, { durationSeconds = null, minSeconds = 15, maxSeconds = 60, leadIn = 3 } = {}) {
    const total = durationSeconds ?? at + maxSeconds;
    const len = Math.min(maxSeconds, Math.max(minSeconds, 30));
    return fitRange(at - leadIn, at - leadIn + len, { total, minLen: Math.min(minSeconds, len), maxLen: len });
  }

  // ---- Output ----

  const BARS = "▁▂▃▄▅▆▇█";
  // Heatmap as a text sparkline of `width` characters (for agents and logs).
  function sparkline(heatmap, width = 50) {
    if (!heatmap?.length) return "";
    const last = heatmap[heatmap.length - 1];
    const total = last.start + last.duration;
    let out = "";
    for (let b = 0; b < width; b++) {
      const from = (b / width) * total, to = ((b + 1) / width) * total;
      const inBin = heatmap.filter((m) => m.start < to && m.start + m.duration > from);
      const v = inBin.length ? inBin.reduce((a, m) => a + m.intensity, 0) / inBin.length : 0;
      out += BARS[Math.min(BARS.length - 1, Math.round(v * (BARS.length - 1)))];
    }
    return out;
  }

  const shareUrl = (videoId, start) => `https://youtu.be/${encodeURIComponent(videoId)}?t=${Math.max(0, Math.floor(start))}`;
  const watchUrl = (videoId, start) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.max(0, Math.floor(start))}s`;
  const embedUrl = (videoId, start, end) =>
    `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?start=${Math.max(0, Math.floor(start))}&end=${Math.ceil(end)}`;
  const rangeLabel = (c) => `${formatTime(c.start)}–${formatTime(c.end)}`;

  // One line per clip: "2:10–2:48 (38s) Best tip — https://youtu.be/…?t=130".
  function clipsAsText(clips, videoId) {
    return [...clips].sort((a, b) => a.start - b.start)
      .map((c) => `${rangeLabel(c)} (${Math.round(c.end - c.start)}s)${c.note ? ` ${c.note}` : ""} — ${shareUrl(videoId, c.start)}`)
      .join("\n");
  }

  // Clip starts as a YouTube chapter block: first chapter at 0:00, chapters at least 10 s apart.
  function clipsAsChapters(clips) {
    const rows = [...clips].sort((a, b) => a.start - b.start);
    const out = [];
    if (!rows.length || rows[0].start >= 10) out.push({ start: 0, title: "Intro" });
    for (const c of rows) {
      const start = out.length ? c.start : 0;
      if (out.length && start - out[out.length - 1].start < 10) continue;
      out.push({ start, title: c.note?.trim() || `Clip at ${formatTime(c.start)}` });
    }
    return out.map((ch) => `${formatTime(ch.start)} ${ch.title}`).join("\n");
  }

  const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  // Rows of {videoId, title, start, end, note} as CSV, for editors and spreadsheets.
  function clipsAsCsv(rows) {
    const head = ["video_id", "video_title", "start", "end", "start_seconds", "end_seconds", "length_seconds", "note", "link"];
    const lines = rows.map((r) => [r.videoId, r.title ?? "", formatTime(r.start), formatTime(r.end), Math.floor(r.start), Math.ceil(r.end),
      Math.round(r.end - r.start), r.note ?? "", shareUrl(r.videoId, r.start)].map(csvCell).join(","));
    return [head.join(","), ...lines].join("\n") + "\n";
  }

  const api = {
    formatTime, parseTime, heatmapFromInitialData, chapterList, chapterAt, timestampMentions,
    suggestClips, clipAround, sparkline, shareUrl, watchUrl, embedUrl, rangeLabel, clipsAsText, clipsAsChapters, clipsAsCsv,
  };
  root.TubeLensClips = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

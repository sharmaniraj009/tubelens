// Upload planning: when a channel's uploads do best, how steadily it uploads, a schedule of
// long-form and Shorts slots, publishing checklists, plan items and calendar (.ics) export.
// Pure functions, shared by the planner page, the video panel and tests.
(function (root) {
  "use strict";
  const clips = root.TubeLensClips ?? (typeof require === "function" ? require("./clips.js") : null);

  const DAY_MS = 86400000;
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const SHORT_MAX_SECONDS = 180;
  // Videos younger than this are still gathering views and are left out of comparisons.
  const MIN_AGE_DAYS = 7;

  const TYPES = { long: "Video", short: "Short", post: "Community post" };
  const STATUSES = ["idea", "scripting", "filming", "editing", "ready", "scheduled", "published"];

  function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }
  const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  const pad = (n) => String(n).padStart(2, "0");
  // Local calendar date as YYYY-MM-DD.
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  // ---- What the channel's history says ----

  // Day × time-of-day grid of median views, relative to the channel's median (1 = typical).
  // Times are shifted by `utcOffsetMinutes`, so cells are in the viewer's own time zone.
  function postingGrid(videos, { utcOffsetMinutes = 0, now = Date.now(), blockHours = 3 } = {}) {
    const mature = (videos ?? []).filter((v) => v.views != null && Number.isFinite(Date.parse(v.publishedAt))
      && (now - Date.parse(v.publishedAt)) / DAY_MS >= MIN_AGE_DAYS);
    const baseline = median(mature.map((v) => v.views));
    const blocks = Math.ceil(24 / blockHours);
    const views = Array.from({ length: 7 * blocks }, () => []);
    for (const v of mature) {
      const d = new Date(Date.parse(v.publishedAt) + utcOffsetMinutes * 60000);
      views[d.getUTCDay() * blocks + Math.floor(d.getUTCHours() / blockHours)].push(v.views);
    }
    const cells = views.map((list, i) => {
      const day = Math.floor(i / blocks), startHour = (i % blocks) * blockHours, endHour = Math.min(24, startHour + blockHours);
      const med = median(list);
      return { day, startHour, endHour, label: `${WEEKDAYS[day]} ${hh(startHour)}–${hh(endHour)}`, videos: list.length,
        medianViews: med, ratio: baseline && med != null ? round(med / baseline, 2) : null };
    });
    return { baseline, blockHours, videos: mature.length, cells };
  }

  // Slots whose uploads beat the channel's median the most, with at least `minVideos` uploads.
  function bestSlots(grid, { count = 3, minVideos = 2 } = {}) {
    return (grid?.cells ?? []).filter((c) => c.videos >= minVideos && c.ratio != null)
      .sort((a, b) => b.ratio - a.ratio || b.videos - a.videos).slice(0, count);
  }

  // How often and how steadily a channel uploads.
  function cadence(videos, { now = Date.now() } = {}) {
    const dated = (videos ?? []).filter((v) => Number.isFinite(Date.parse(v.publishedAt)));
    const times = dated.map((v) => Date.parse(v.publishedAt)).sort((a, b) => a - b);
    if (!times.length) return null;
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / DAY_MS);
    // Rate over the last 90 days, or over the whole sample when it covers less than that (plus
    // one usual gap, the stretch the first upload in the sample stands for).
    const windowDays = Math.max(Math.min(90, (now - times[0]) / DAY_MS + (median(gaps) ?? 0)), 1);
    const recent = times.filter((t) => now - t <= windowDays * DAY_MS).length;
    const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    const sd = gaps.length > 1 ? Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / (gaps.length - 1)) : null;
    const variation = mean && sd != null ? sd / mean : null;
    const shorts = dated.filter((v) => v.durationSeconds != null && v.durationSeconds <= SHORT_MAX_SECONDS).length;
    return {
      uploads: times.length,
      perWeek: round(recent / (windowDays / 7)),
      medianGapDays: round(median(gaps)),
      longestGapDays: gaps.length ? round(Math.max(...gaps)) : null,
      daysSinceLast: round((now - times.at(-1)) / DAY_MS),
      consistency: variation == null ? null : variation <= 0.5 ? "steady" : variation <= 1 ? "uneven" : "irregular",
      shortsShare: Math.round((shorts / dated.length) * 100),
    };
  }

  // Plain-language advice from the numbers above. `formats` is research.summarizeChannel's.
  function recommendations({ cadence: c = null, slots = [], formats = null } = {}) {
    const tips = [];
    if (c?.daysSinceLast != null && c.medianGapDays && c.daysSinceLast > Math.max(14, c.medianGapDays * 2)) {
      tips.push(`It's been ${Math.round(c.daysSinceLast)} days since the last upload, about ${Math.round(c.daysSinceLast / c.medianGapDays)}× the usual gap. A Short cut from an older video's most replayed moment is a quick way back.`);
    }
    if (c && (c.consistency === "uneven" || c.consistency === "irregular")) {
      tips.push(`Uploads are ${c.consistency}: the usual gap is ${c.medianGapDays} days but the longest was ${c.longestGapDays}. Pick a cadence you can keep, so viewers know when to come back, and plan it in the calendar.`);
    } else if (c?.consistency === "steady") {
      tips.push(`Uploads are steady at about ${c.perWeek} a week. Keep that rhythm; add Shorts between uploads rather than more long videos if you want to grow output.`);
    }
    if (slots[0]) {
      const s = slots[0];
      tips.push(`Uploads posted ${s.label} got ${s.ratio}× your median views (${s.videos} videos). Schedule long-form there, and treat it as a hint: small samples move a lot.`);
    }
    const shorts = formats?.likelyShorts, long = formats?.longForm;
    if (shorts && long) {
      if (!shorts.videos && long.videos) {
        tips.push("No Shorts in this sample. Two or three a week, cut from your videos' most replayed moments and linked back with the Short's Related video, give new viewers a way in.");
      } else if (shorts.videos >= 3 && long.videos >= 3 && shorts.medianViews && long.medianViews) {
        const r = shorts.medianViews / long.medianViews;
        if (r >= 2) tips.push(`Shorts get ${round(r)}× the median views of long videos. Use them as trailers: set each Short's Related video to the full video.`);
        else if (r <= 0.5) tips.push(`Long videos get ${round(1 / r)}× the median views of Shorts. Keep long-form first; post Shorts mainly as teasers for it.`);
      }
    }
    tips.push("In the first hours after publishing, pin a comment that asks a question and reply to early comments. The Engage tab in the video panel drafts both.");
    return tips;
  }

  // ---- Planning ----

  const circular = (a, b) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
  // `k` weekdays from `candidates`, each as far as possible from `taken` and from each other.
  function spread(candidates, taken, k) {
    const picked = [];
    const pool = [...candidates];
    while (picked.length < k && pool.length) {
      const busy = [...taken, ...picked];
      let best = 0, bestGap = -1;
      pool.forEach((d, i) => {
        const gap = busy.length ? Math.min(...busy.map((b) => circular(d, b))) : 7;
        if (gap > bestGap) { best = i; bestGap = gap; }
      });
      picked.push(pool.splice(best, 1)[0]);
    }
    return picked;
  }

  // Default long-form days when the channel's history doesn't suggest any: Tue, Thu, Sat, …
  const DEFAULT_LONG_DAYS = [2, 4, 6, 1, 3, 5, 0];

  // Dated slots for the `weeks` weeks after `from`: long-form on `longDays` (best first), Shorts
  // on the days furthest from them so each upload gets a day of its own where possible.
  function planSchedule({ from = new Date(), weeks = 4, longPerWeek = 1, shortsPerWeek = 2, longDays = [],
    longTime = "17:00", shortTime = "12:00" } = {}) {
    const nLong = Math.max(0, Math.min(7, Math.round(longPerWeek)));
    const nShort = Math.max(0, Math.min(7, Math.round(shortsPerWeek)));
    const long = [...new Set([...longDays.filter((d) => d >= 0 && d <= 6), ...DEFAULT_LONG_DAYS])].slice(0, nLong);
    const free = [0, 1, 2, 3, 4, 5, 6].filter((d) => !long.includes(d));
    const short = spread(free, long, nShort);
    if (short.length < nShort) short.push(...long.slice(0, nShort - short.length)); // more Shorts than free days
    const start = from instanceof Date ? from : parseDate(from) ?? new Date();
    const out = [];
    for (let i = 1; i <= weeks * 7; i++) {
      const day = addDays(start, i);
      if (long.includes(day.getDay())) out.push({ date: isoDate(day), time: longTime, type: "long" });
      if (short.includes(day.getDay())) out.push({ date: isoDate(day), time: shortTime, type: "short" });
    }
    return out;
  }

  const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  function newItem(fields = {}) {
    const now = Date.now();
    return { id: newId(), title: "", type: "long", date: null, time: "", status: "idea", notes: "", checks: {},
      createdAt: now, updatedAt: now, ...fields };
  }

  // The first date after `from` with nothing planned, or failing that with no item of `type`.
  function nextFreeDate(items, { type = "short", from = new Date(), horizonDays = 180 } = {}) {
    const start = from instanceof Date ? from : parseDate(from) ?? new Date();
    const byDate = new Map();
    for (const it of items ?? []) if (it.date) byDate.set(it.date, [...(byDate.get(it.date) ?? []), it.type]);
    for (const ok of [(types) => !types, (types) => !types || !types.includes(type)]) {
      for (let i = 1; i <= horizonDays; i++) {
        const d = isoDate(addDays(start, i));
        if (ok(byDate.get(d))) return d;
      }
    }
    return isoDate(addDays(start, 1));
  }

  // A Short made from a clip saved on `video`, on the next day with nothing planned.
  function shortFromClip(items, clip, video, { time = "12:00", from = new Date() } = {}) {
    const name = video.title || video.videoId;
    return newItem({
      type: "short", date: nextFreeDate(items, { type: "short", from }), time,
      title: clip.note || `Short from “${name}”`.slice(0, 100), clipId: clip.id,
      clip: { videoId: video.videoId, start: clip.start, end: clip.end, videoTitle: video.title ?? "" },
      notes: `From ${clips.rangeLabel(clip)} of “${name}”. Set the full video as the Short's Related video.`,
    });
  }

  // Items sorted by date and time; undated ideas last.
  const sortItems = (items) => [...(items ?? [])].sort((a, b) =>
    (a.date ?? "9999") < (b.date ?? "9999") ? -1 : (a.date ?? "9999") > (b.date ?? "9999") ? 1 : (a.time ?? "").localeCompare(b.time ?? ""));

  // ---- Checklists ----

  const CHECKLISTS = {
    long: [
      { id: "title", phase: "Before", label: "Title checked in the SEO checker: keyword early, about 60 characters or fewer" },
      { id: "thumb", phase: "Before", label: "Thumbnail readable at phone size" },
      { id: "desc", phase: "Before", label: "Description: a hook in the first two lines, a question, links, 1–3 hashtags" },
      { id: "chapters", phase: "Before", label: "Chapters: 3 or more timestamps starting at 0:00" },
      { id: "captions", phase: "Before", label: "Captions checked or uploaded" },
      { id: "endscreen", phase: "Publish", label: "End screen pointing to your next video or a playlist" },
      { id: "playlist", phase: "Publish", label: "Added to a playlist" },
      { id: "schedule", phase: "Publish", label: "Scheduled at your best time" },
      { id: "pinned", phase: "After", label: "Pinned comment with a question (the Engage tab drafts one)" },
      { id: "replies", phase: "After", label: "Replied to comments in the first hours" },
      { id: "shorts", phase: "After", label: "Best moments planned as Shorts that link back here" },
      { id: "review", phase: "After", label: "Views per hour checked after 24 hours" },
    ],
    short: [
      { id: "hook", phase: "Before", label: "Hook in the first 2 seconds" },
      { id: "format", phase: "Before", label: "Vertical 9:16, 3 minutes or shorter" },
      { id: "title", phase: "Before", label: "Title with the keyword, plus 1–3 hashtags" },
      { id: "related", phase: "Publish", label: "Related video set to the full video" },
      { id: "schedule", phase: "Publish", label: "Posted on a day without a long-form upload" },
      { id: "replies", phase: "After", label: "Replied to the first comments" },
    ],
    post: [
      { id: "ask", phase: "Before", label: "A poll or question that's quick to answer" },
      { id: "link", phase: "Before", label: "Links to your newest video" },
      { id: "timing", phase: "Publish", label: "Posted between uploads" },
      { id: "follow", phase: "After", label: "Used the answers to pick a next video" },
    ],
  };
  const checklist = (type) => CHECKLISTS[type] ?? CHECKLISTS.long;
  function progress(item) {
    const list = checklist(item?.type);
    return { done: list.filter((c) => item?.checks?.[c.id]).length, total: list.length };
  }

  // ---- Calendar export ----

  const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  // RFC 5545 folds lines longer than 75 octets.
  function fold(line) {
    const enc = new TextEncoder();
    const out = [];
    let cur = "", size = 0;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (size + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; size = 0; }
      cur += ch;
      size += n;
    }
    out.push(cur);
    return out.join("\r\n ");
  }

  // Dated items as an iCalendar file. Timed items are 30-minute events in local ("floating")
  // time; items without a time are all-day events.
  function toICS(items, { now = new Date(), watchUrl = (id, t) => `https://www.youtube.com/watch?v=${id}&t=${Math.floor(t)}s` } = {}) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TubeLens//Upload planner//EN", "CALSCALE:GREGORIAN"];
    for (const it of sortItems(items)) {
      const date = parseDate(it.date);
      if (!date) continue;
      const ymd = it.date.replace(/-/g, "");
      const time = /^(\d{2}):(\d{2})$/.exec(it.time ?? "");
      const details = [`Status: ${it.status}`, it.notes, it.clip ? `Clip: ${watchUrl(it.clip.videoId, it.clip.start)}` : null].filter(Boolean).join("\n");
      lines.push("BEGIN:VEVENT", `UID:${it.id}@tubelens`, `DTSTAMP:${stamp}`,
        time ? `DTSTART:${ymd}T${time[1]}${time[2]}00` : `DTSTART;VALUE=DATE:${ymd}`,
        time ? "DURATION:PT30M" : "DURATION:P1D",
        `SUMMARY:${icsText(`${TYPES[it.type] ?? "Upload"}: ${it.title || "Untitled"}`)}`,
        `DESCRIPTION:${icsText(details)}`, "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  const api = {
    WEEKDAYS, TYPES, STATUSES, MIN_AGE_DAYS, postingGrid, bestSlots, cadence, recommendations, planSchedule,
    newItem, nextFreeDate, shortFromClip, sortItems, checklist, progress, toICS, isoDate, parseDate, addDays,
  };
  root.TubeLensPlanner = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

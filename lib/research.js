// Channel research: summaries, audits, outliers and posting-time patterns. Pure functions.
(function (root) {
  "use strict";
  const seo = root.TubeLensSEO ?? (typeof require === "function" ? require("./seo.js") : null);

  const DAY_MS = 86400000;
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  // YouTube Shorts can be up to 3 minutes; duration alone cannot tell a short 2-minute video
  // from a Short, so this is labelled "likely".
  const SHORT_MAX_SECONDS = 180;
  // Videos younger than this are still accumulating views and are excluded from baselines.
  const MIN_AGE_DAYS = 7;

  function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  const ageDays = (video, now) => (now - Date.parse(video.publishedAt)) / DAY_MS;
  const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

  function engagementRate(v) {
    if (!v.views || v.likes == null) return null;
    return ((v.likes + (v.comments ?? 0)) / v.views) * 100;
  }

  function slim(v, extra = {}) {
    return {
      videoId: v.videoId, title: v.title, publishedAt: v.publishedAt, views: v.views,
      durationSeconds: v.durationSeconds, url: `https://www.youtube.com/watch?v=${v.videoId}`, ...extra,
    };
  }

  // Group by a key and report median views per group, best first.
  function groupMedians(videos, keyOf, labelOf) {
    const groups = new Map();
    for (const v of videos) {
      const k = keyOf(v);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v.views);
    }
    return [...groups.entries()]
      .map(([k, views]) => ({ key: k, label: labelOf(k), videos: views.length, medianViews: median(views) }))
      .sort((a, b) => b.medianViews - a.medianViews);
  }

  function summarizeChannel(channel, videos, { now = Date.now(), utcOffsetMinutes = 0 } = {}) {
    const dated = videos.filter((v) => Number.isFinite(Date.parse(v.publishedAt)) && v.views != null);
    const mature = dated.filter((v) => ageDays(v, now) >= MIN_AGE_DAYS);
    const baseline = median(mature.map((v) => v.views));
    const times = dated.map((v) => Date.parse(v.publishedAt)).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / DAY_MS);
    const spanWeeks = times.length > 1 ? (times.at(-1) - times[0]) / (7 * DAY_MS) : null;

    // Posting patterns use the caller's offset so "Tuesday 17:00" means local time.
    const local = (v) => new Date(Date.parse(v.publishedAt) + utcOffsetMinutes * 60000);
    const byDay = groupMedians(mature, (v) => local(v).getUTCDay(), (d) => WEEKDAYS[d]);
    const byHour = groupMedians(mature, (v) => local(v).getUTCHours(), (h) => `${String(h).padStart(2, "0")}:00`);

    const isShort = (v) => v.durationSeconds != null && v.durationSeconds <= SHORT_MAX_SECONDS;
    const formats = {
      likelyShorts: { videos: mature.filter(isShort).length, medianViews: median(mature.filter(isShort).map((v) => v.views)) },
      longForm: { videos: mature.filter((v) => !isShort(v)).length, medianViews: median(mature.filter((v) => !isShort(v)).map((v) => v.views)) },
    };

    const outliers = baseline
      ? mature
          .map((v) => ({ v, ratio: v.views / baseline }))
          .filter((x) => x.ratio >= 2)
          .sort((a, b) => b.ratio - a.ratio)
          .slice(0, 10)
          .map(({ v, ratio }) => slim(v, { outlierRatio: round(ratio) }))
      : [];
    const underperformers = baseline
      ? mature
          .map((v) => ({ v, ratio: v.views / baseline }))
          .filter((x) => x.ratio <= 0.5)
          .sort((a, b) => a.ratio - b.ratio)
          .slice(0, 5)
          .map(({ v, ratio }) => slim(v, { outlierRatio: round(ratio, 2) }))
      : [];

    return {
      channel: {
        channelId: channel.channelId, title: channel.title, handle: channel.handle,
        subscribers: channel.subscribers, totalViews: channel.views, videoCount: channel.videoCount,
        url: `https://www.youtube.com/channel/${channel.channelId}`,
      },
      sample: {
        videos: dated.length, matureVideos: mature.length,
        from: times.length ? new Date(times[0]).toISOString() : null,
        to: times.length ? new Date(times.at(-1)).toISOString() : null,
      },
      medianViews: baseline,
      medianViewsPerSubscriber: baseline != null && channel.subscribers ? round(baseline / channel.subscribers, 3) : null,
      medianEngagementRate: round(median(mature.map(engagementRate)), 2),
      uploadsPerWeek: spanWeeks ? round((times.length - 1) / spanWeeks) : null,
      medianDaysBetweenUploads: round(median(gaps)),
      formats,
      bestDays: byDay.slice(0, 3),
      bestHours: byHour.slice(0, 3),
      top: [...mature].sort((a, b) => b.views - a.views).slice(0, 5).map((v) => slim(v)),
      outliers,
      underperformers,
      notes: [
        `Baselines use videos at least ${MIN_AGE_DAYS} days old.`,
        `"Likely Shorts" means ≤ ${SHORT_MAX_SECONDS / 60} minutes; duration alone cannot confirm a Short.`,
        `Posting times are shifted by ${utcOffsetMinutes} minutes from UTC.`,
      ],
    };
  }

  // Run the SEO checklist over a channel's uploads and rank the most common failures.
  function auditVideos(videos) {
    if (!seo) throw new Error("TubeLensSEO is not loaded");
    const scored = videos.map((v) => ({ v, r: seo.score({ title: v.title, description: v.description, tags: v.tags }) }));
    if (scored.length === 0) return { videos: 0, averageScore: null, commonIssues: [], lowest: [] };
    const fails = new Map();
    for (const { r } of scored)
      for (const c of r.checks) if (!c.pass) fails.set(c.id, { label: c.label, weight: c.weight, count: (fails.get(c.id)?.count ?? 0) + 1 });
    return {
      videos: scored.length,
      averageScore: round(scored.reduce((n, x) => n + x.r.score, 0) / scored.length),
      commonIssues: [...fails.entries()]
        .map(([id, f]) => ({ id, label: f.label, failingVideos: f.count, share: round((f.count / scored.length) * 100, 0), pointsEach: f.weight }))
        .sort((a, b) => b.failingVideos * b.pointsEach - a.failingVideos * a.pointsEach),
      lowest: scored.sort((a, b) => a.r.score - b.r.score).slice(0, 5).map(({ v, r }) => slim(v, { seoScore: r.score })),
    };
  }

  // Rank videos by views relative to their channel's lifetime average views per video.
  // That baseline is approximate (it includes old videos and Shorts) and is labelled as such.
  function rankOutliers(videos, channels, { now = Date.now() } = {}) {
    const byId = new Map(channels.map((c) => [c.channelId, c]));
    return videos
      .map((v) => {
        const c = byId.get(v.channelId);
        const baseline = c?.views && c?.videoCount ? c.views / c.videoCount : null;
        const days = Math.max(ageDays(v, now), 1);
        return {
          ...slim(v),
          channelTitle: v.channelTitle,
          channelSubscribers: c?.subscribers ?? null,
          viewsPerDay: v.views == null ? null : Math.round(v.views / days),
          outlierRatio: baseline && v.views != null ? round(v.views / baseline, 2) : null,
          viewsPerSubscriber: c?.subscribers && v.views != null ? round(v.views / c.subscribers, 2) : null,
          engagementRate: round(engagementRate(v), 2),
        };
      })
      .sort((a, b) => (b.outlierRatio ?? -1) - (a.outlierRatio ?? -1));
  }

  // Most frequent meaningful words/phrases in a set of titles and tags: a channel's or video's
  // topic fingerprint, used to search for similar videos and channels.
  function topicTerms(videos, limit = 5) {
    if (!seo) throw new Error("TubeLensSEO is not loaded");
    const counts = new Map();
    const bump = (term, w) => counts.set(term, (counts.get(term) ?? 0) + w);
    for (const v of videos) {
      const seen = new Set();
      for (const tag of v.tags ?? []) {
        const t = seo.words(tag).join(" ");
        if (t.length > 2 && t.split(" ").length <= 4 && !seen.has(t)) { seen.add(t); bump(t, 2); }
      }
      for (const w of new Set(seo.words(v.title).filter((x) => x.length > 3))) bump(w, 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
  }

  // Views per hour since publish, for "rising" rankings.
  function viewsPerHour(v, now = Date.now()) {
    const hours = Math.max((now - Date.parse(v.publishedAt)) / 3.6e6, 1);
    return v.views == null || !Number.isFinite(hours) ? null : v.views / hours;
  }

  // Lightweight comment digest; deeper analysis is left to the caller (e.g. Claude).
  function commentDigest(comments) {
    const questions = comments.filter((c) => /\?\s*$|^(how|what|why|when|where|which|can|could|should|is|are|do|does)\b/i.test(c.text.trim()));
    return {
      comments: comments.length,
      totalLikes: comments.reduce((n, c) => n + c.likes, 0),
      questions: questions.length,
      topLiked: [...comments].sort((a, b) => b.likes - a.likes).slice(0, 5).map((c) => ({ text: c.text.slice(0, 280), likes: c.likes })),
      topQuestions: [...questions].sort((a, b) => b.likes - a.likes).slice(0, 5).map((c) => ({ text: c.text.slice(0, 280), likes: c.likes })),
    };
  }

  const api = {
    median, summarizeChannel, auditVideos, rankOutliers, engagementRate, topicTerms, viewsPerHour, commentDigest,
    SHORT_MAX_SECONDS, MIN_AGE_DAYS,
  };
  root.TubeLensResearch = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

// TubeLens SEO scoring. Pure functions, shared by the content script, popup and tests.
// The score is a transparent heuristic (100 points over the checks below), not a ranking model.
(function (root) {
  "use strict";

  const STOP_WORDS = new Set(
    ("a an and are as at be by for from how i in is it my of on or so that the this to " +
      "was we what when why with you your vs not do does can will just get").split(" ")
  );

  const normalize = (s) => String(s ?? "").normalize("NFKC").toLowerCase();
  const words = (s) => normalize(s).match(/[\p{L}\p{N}']+/gu) ?? [];
  const meaningfulWords = (s) => words(s).filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Whole-word phrase match: "cat" matches "my cat video" but not "category".
  function containsPhrase(text, phrase) {
    const p = words(phrase);
    if (p.length === 0) return false;
    return ` ${words(text).join(" ")} `.includes(` ${p.join(" ")} `);
  }

  // Index of the phrase in the title's word list, or -1.
  function phraseWordIndex(text, phrase) {
    const t = words(text);
    const p = words(phrase);
    if (p.length === 0) return -1;
    outer: for (let i = 0; i + p.length <= t.length; i++) {
      for (let j = 0; j < p.length; j++) if (t[i + j] !== p[j]) continue outer;
      return i;
    }
    return -1;
  }

  const TIMESTAMP_LINE = /^\s*[([]?((\d{1,2}):)?(\d{1,2}):(\d{2})[)\]]?\s*[-–—:|]?\s*\S/;

  // YouTube builds chapters from >=3 timestamps whose first one is 0:00.
  function chapters(description) {
    const stamps = [];
    for (const line of String(description ?? "").split(/\r?\n/)) {
      const m = line.match(TIMESTAMP_LINE);
      if (m) stamps.push((Number(m[2] ?? 0) * 60 + Number(m[3])) * 60 + Number(m[4]));
    }
    const valid = stamps.length >= 3 && stamps[0] === 0;
    return { count: stamps.length, valid };
  }

  function hashtags(description) {
    return [...String(description ?? "").matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
  }

  // YouTube's 500-character tag limit counts the commas between tags,
  // and quotes around tags that contain spaces.
  function tagCharacters(tags) {
    if (tags.length === 0) return 0;
    const body = tags.reduce((n, t) => n + [...t].length + (t.includes(" ") ? 2 : 0), 0);
    return body + tags.length - 1;
  }

  function cleanTags(tags) {
    const seen = new Set();
    const out = [];
    for (const raw of tags ?? []) {
      const t = String(raw).trim();
      const key = normalize(t);
      if (t && !seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }

  // Default target keyword: the first tag, else the first two meaningful title words.
  function suggestKeyword(title, tags) {
    if (tags.length > 0) return tags[0];
    return meaningfulWords(title).slice(0, 2).join(" ");
  }

  function score({ title = "", description = "", tags = [], keyword = "" } = {}) {
    const tagList = cleanTags(tags);
    const kw = String(keyword).trim() || suggestKeyword(title, tagList);
    const checks = [];
    const add = (id, label, weight, pass, detail) =>
      checks.push({ id, label, weight, pass: Boolean(pass), points: pass ? weight : 0, detail });

    const titleLen = [...title].length;
    add("title-length", "Title is 20–70 characters", 10, titleLen >= 20 && titleLen <= 70, `${titleLen} characters`);

    const kwIndex = kw ? phraseWordIndex(title, kw) : -1;
    add("kw-title", "Target keyword in title", 15, kwIndex >= 0, kw ? `"${kw}"` : "no target keyword");
    add("kw-title-early", "Keyword in the first 3 words of the title", 5, kwIndex >= 0 && kwIndex <= 2,
      kwIndex >= 0 ? `starts at word ${kwIndex + 1}` : "not in title");

    const descLen = [...description].length;
    add("desc-length", "Description is at least 300 characters", 10, descLen >= 300, `${descLen} characters`);
    add("desc-long", "Description is at least 1,000 characters", 5, descLen >= 1000, `${descLen} characters`);

    const intro = [...description].slice(0, 200).join("");
    add("kw-desc", "Keyword in the first 200 characters of the description", 10,
      kw && containsPhrase(intro, kw), kw ? "checked description opening" : "no target keyword");

    add("tag-count", "5–20 tags", 10, tagList.length >= 5 && tagList.length <= 20, `${tagList.length} tags`);

    const tagChars = tagCharacters(tagList);
    add("tag-length", "Tags use 100–500 characters (YouTube's limit is 500)", 5,
      tagChars >= 100 && tagChars <= 500, `${tagChars} characters`);

    const kwTag = kw && tagList.some((t) => containsPhrase(t, kw));
    add("kw-tags", "Keyword appears in a tag", 10, kwTag, kwTag ? "found" : "missing");

    const titleWords = [...new Set(meaningfulWords(title))];
    const tagText = tagList.join(" ");
    const covered = titleWords.filter((w) => containsPhrase(tagText, w));
    const coverage = titleWords.length ? covered.length / titleWords.length : 0;
    add("title-tag-coverage", "At least half the title's key words appear in tags", 10, coverage >= 0.5,
      `${covered.length}/${titleWords.length} words`);

    const ch = chapters(description);
    add("chapters", "Description has chapters (3+ timestamps from 0:00)", 5, ch.valid, `${ch.count} timestamps`);

    // YouTube ignores every hashtag on a video that has more than 15; up to 3 show above the title.
    const tagsInDesc = hashtags(description);
    add("hashtags", "1–3 hashtags in the description", 5, tagsInDesc.length >= 1 && tagsInDesc.length <= 3,
      `${tagsInDesc.length} hashtags`);

    return { score: checks.reduce((n, c) => n + c.points, 0), keyword: kw, checks };
  }

  // Derived stats from public numbers. Missing inputs stay null instead of becoming 0.
  function videoStats({ views = null, likes = null, comments = null, publishedAt = null, now = Date.now() } = {}) {
    const published = publishedAt ? Date.parse(publishedAt) : NaN;
    const hours = Number.isFinite(published) ? Math.max((now - published) / 3.6e6, 1) : null;
    const vph = views != null && hours != null ? views / hours : null;
    const engagement = views && likes != null ? ((likes + (comments ?? 0)) / views) * 100 : null;
    return { hoursSincePublish: hours, viewsPerHour: vph, engagementRate: engagement };
  }

  root.TubeLensSEO = { score, videoStats, words, containsPhrase, chapters, hashtags, tagCharacters, cleanTags, suggestKeyword };
  if (typeof module === "object" && module.exports) module.exports = root.TubeLensSEO;
})(typeof globalThis !== "undefined" ? globalThis : this);

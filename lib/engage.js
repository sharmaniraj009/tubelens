// Engagement helpers: a checklist of what a video's title and description do to invite
// comments, subscriptions and more watching; pinned-comment drafts; and which comments to
// reply to first. Pure functions, shared by the video panel and tests.
(function (root) {
  "use strict";
  const req = (name) => (typeof require === "function" ? require(name) : null);
  const seo = root.TubeLensSEO ?? req("./seo.js");
  const clips = root.TubeLensClips ?? req("./clips.js");

  const LINK_TO_YOUTUBE = /(?:youtube\.com\/(?:watch\?|playlist\?|shorts\/|@|channel\/|c\/)|youtu\.be\/)/i;
  const COMMENT_ASK = /\b(comments?|let me know|tell me|reply|drop (?:a|your)|down below)\b/i;
  const SUBSCRIBE_ASK = /\bsubscrib/i;
  const QUESTION = /\?\s*$|^(how|what|why|when|where|which|who|can|could|should|would|is|are|do|does|did|will|has|have)\b/i;

  // TubeLens's own checklist (0–100), like the SEO score: transparent, not YouTube's ranking.
  function engagementChecks({ title = "", description = "", lengthSeconds = null } = {}) {
    const desc = String(description ?? "");
    const checks = [];
    const add = (id, label, weight, pass, detail, tip) => checks.push({ id, label, weight, pass: Boolean(pass), points: pass ? weight : 0, detail, tip });
    const found = (ok) => (ok ? "found" : "missing");

    const question = desc.split(/\r?\n/).map((l) => l.trim()).find((l) => /\?$/.test(l) && !/^https?:/i.test(l));
    add("question", "Asks viewers a question", 20, question, question ? `“${question.slice(0, 28)}${question.length > 28 ? "…" : ""}”` : "none",
      "A line ending in “?” gives viewers an easy first comment.");
    add("comment-ask", "Invites comments", 15, COMMENT_ASK.test(desc), found(COMMENT_ASK.test(desc)), "e.g. “Tell me in the comments”.");
    add("links", "Links to more of your videos", 20, LINK_TO_YOUTUBE.test(desc), found(LINK_TO_YOUTUBE.test(desc)),
      "A link to another video, a playlist or your channel keeps viewers watching your videos.");
    add("subscribe", "Asks viewers to subscribe", 10, SUBSCRIBE_ASK.test(desc), found(SUBSCRIBE_ASK.test(desc)), "A short, specific reason to subscribe works best.");
    // About this much shows before "…more" under the video.
    const opening = [...desc].slice(0, 150).join("").trim();
    add("opening", "Description opens with a sentence", 15, opening && !/^(https?:\/\/|#)/i.test(opening),
      !opening ? "empty" : /^#/.test(opening) ? "starts with #" : /^https?:/i.test(opening) ? "starts with a link" : "yes",
      "The first ~150 characters show before “…more”: say what the video gives the viewer.");
    if (lengthSeconds == null || lengthSeconds > 180) {
      const ch = seo.chapters(desc);
      add("chapters", "Chapters (3+ timestamps from 0:00)", 10, ch.valid, `${ch.count} timestamps`, "Chapters let viewers jump to the part they came for instead of leaving.");
    }
    const titleLen = [...String(title)].length;
    add("title-mobile", "Title fits on a phone (≤ 60 characters)", 10, titleLen > 0 && titleLen <= 60, `${titleLen} characters`,
      "Longer titles are often cut off in search results and on phones.");

    const max = checks.reduce((n, c) => n + c.weight, 0);
    return { score: Math.round((checks.reduce((n, c) => n + c.points, 0) / max) * 100), checks };
  }

  // Drafts for a pinned comment: a question for viewers, the moments worth rewatching (from
  // saved clips or "Most replayed" suggestions) and an ask for the next topic. The creator edits
  // them before posting; timestamps in comments become links on YouTube.
  function pinnedComments({ title = "", tags = [], description = "", moments = [] } = {}) {
    const topic = seo.suggestKeyword(title, seo.cleanTags(tags)) || "this";
    const chapters = clips.chapterList(description).filter((c) => c.start > 0);
    const drafts = [];
    if (chapters.length >= 2) {
      const [a, b] = chapters;
      drafts.push({ id: "pick", label: "Which part helped", text: `Which part was most useful for you: “${a.title}” or “${b.title}”? Tell me below 👇` });
    }
    drafts.push({ id: "question", label: "Ask for questions", text: `What's your biggest question about ${topic}? Ask below and I'll answer as many as I can 👇` });
    const best = [...moments].sort((x, y) => x.start - y.start).slice(0, 3);
    if (best.length) {
      drafts.push({ id: "moments", label: "Point to the best moments", text: [
        best.length > 1 ? "The moments people rewatch most:" : "The moment people rewatch most:",
        ...best.map((m) => `${clips.formatTime(m.start)}${m.note ? ` ${m.note}` : ""}`),
        best.length > 1 ? "Which one's your favourite?" : "Did it get you too?"].join("\n") });
    }
    drafts.push({ id: "next", label: "Ask what to make next", text: `What should I make next about ${topic}? Reply with your ideas; I read them all 👇` });
    return drafts;
  }

  const isQuestion = (text) => QUESTION.test(String(text ?? "").trim());

  // Comments worth answering first: unanswered questions, then other unanswered comments,
  // most liked first. Each gets a link that opens the video with that comment highlighted.
  function replyQueue(comments, { videoId = null, limit = 10 } = {}) {
    const list = (comments ?? []).map((c) => ({ ...c, question: isQuestion(c.text) }));
    const open = list.filter((c) => !c.replyCount);
    return {
      total: list.length,
      unanswered: open.length,
      questions: list.filter((c) => c.question).length,
      unansweredQuestions: open.filter((c) => c.question).length,
      queue: open
        .sort((a, b) => b.question - a.question || b.likes - a.likes || Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0))
        .slice(0, limit)
        .map((c) => ({
          commentId: c.commentId, author: c.author, text: String(c.text ?? "").slice(0, 300), likes: c.likes ?? 0,
          question: c.question, publishedAt: c.publishedAt ?? null,
          url: videoId && c.commentId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(c.commentId)}` : null,
        })),
    };
  }

  const api = { engagementChecks, pinnedComments, replyQueue, isQuestion };
  root.TubeLensEngage = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

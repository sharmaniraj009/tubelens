"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../lib/engage.js");

test("engagementChecks scores the asks, links and structure of a description", () => {
  const good = E.engagementChecks({
    title: "Sourdough for beginners: my 5-step method",
    description: "The easiest sourdough I've made, step by step.\n\nWhat's your favourite flour?\nTell me in the comments and subscribe for part 2.\n" +
      "Part 1: https://youtu.be/abc123def45\n\n0:00 Intro\n1:00 Starter\n4:00 Bake",
    lengthSeconds: 600,
  });
  assert.equal(good.score, 100);
  assert.ok(good.checks.every((c) => c.pass), JSON.stringify(good.checks.filter((c) => !c.pass)));

  const bare = E.engagementChecks({ title: "x".repeat(80), description: "https://example.com\n#bread", lengthSeconds: 600 });
  assert.equal(bare.score, 0);
  assert.equal(bare.checks.find((c) => c.id === "question").detail, "none");
  assert.equal(bare.checks.find((c) => c.id === "opening").detail, "starts with a link");
  assert.ok(!bare.checks.find((c) => c.id === "opening").pass, "a link first isn't an opening sentence");
});

test("engagementChecks skips chapters for Shorts and stays out of 100", () => {
  const short = E.engagementChecks({ title: "Quick tip", description: "Did you know this? Comment below!", lengthSeconds: 40 });
  assert.ok(!short.checks.some((c) => c.id === "chapters"));
  assert.ok(short.score > 0 && short.score < 100);
  // A URL that ends with "?" isn't a question.
  assert.ok(!E.engagementChecks({ description: "https://example.com/?" }).checks.find((c) => c.id === "question").pass);
});

test("pinnedComments drafts questions, best moments and next-topic asks", () => {
  const drafts = E.pinnedComments({
    title: "Sourdough masterclass", tags: ["sourdough bread", "baking"],
    description: "0:00 Intro\n2:00 Shaping\n5:00 The bake",
    moments: [{ start: 310, note: "the oven spring" }, { start: 130 }],
  });
  const byId = Object.fromEntries(drafts.map((d) => [d.id, d.text]));
  assert.match(byId.pick, /“Shaping” or “The bake”/);
  assert.match(byId.question, /about sourdough bread\?/);
  assert.equal(byId.moments, "The moments people rewatch most:\n2:10\n5:10 the oven spring\nWhich one's your favourite?");
  assert.match(byId.next, /next about sourdough bread/);
  const plain = E.pinnedComments({ title: "Morning routine" });
  assert.deepEqual(plain.map((d) => d.id), ["question", "next"]);
  assert.match(plain[0].text, /about morning routine\?/);
});

test("replyQueue puts unanswered questions first, then liked comments", () => {
  const comments = [
    { commentId: "a", text: "Great video", likes: 50, replyCount: 0, publishedAt: "2026-11-01T00:00:00Z" },
    { commentId: "b", text: "How long do you proof it?", likes: 3, replyCount: 0, publishedAt: "2026-11-02T00:00:00Z" },
    { commentId: "c", text: "What flour is that?", likes: 9, replyCount: 2, publishedAt: "2026-11-02T00:00:00Z" },
    { commentId: "d", text: "Can I use rye", likes: 8, replyCount: 0, publishedAt: "2026-11-03T00:00:00Z" },
  ];
  const r = E.replyQueue(comments, { videoId: "vid12345678" });
  assert.deepEqual(r.queue.map((c) => c.commentId), ["d", "b", "a"]);
  assert.equal(r.total, 4);
  assert.equal(r.unanswered, 3);
  assert.equal(r.questions, 3);
  assert.equal(r.unansweredQuestions, 2);
  assert.equal(r.queue[0].url, "https://www.youtube.com/watch?v=vid12345678&lc=d");
  assert.equal(E.replyQueue(comments, { limit: 1 }).queue[0].url, null);
  assert.equal(E.replyQueue([]).queue.length, 0);
});

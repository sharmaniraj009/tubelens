// Keyword ideas from YouTube search autocomplete. Shared by the extension and the MCP server.
(function (root) {
  "use strict";

  const SUGGEST_URL = "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt";
  const MAX_PARALLEL = 6;
  const TIMEOUT_MS = 10000;
  const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];

  async function suggest(query, { fetchImpl = globalThis.fetch.bind(globalThis), language = "en", region } = {}) {
    const qs = new URLSearchParams({ q: query, hl: language });
    if (region) qs.set("gl", region);
    const res = await fetchImpl(`${SUGGEST_URL}&${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Autocomplete returned HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body?.[1]) ? body[1].map(String) : [];
  }

  // Probe the seed and seed + " a".." z"; count how many probes return each suggestion.
  // The count is a popularity hint from autocomplete, not search volume.
  async function keywordIdeas(seed, { expand = true, ...opts } = {}) {
    const base = String(seed ?? "").trim();
    if (!base) return { seed: base, probes: 0, failed: 0, ideas: [] };
    const probes = expand ? [base, ...LETTERS.map((c) => `${base} ${c}`)] : [base];
    const hits = new Map();
    let failed = 0;
    for (let i = 0; i < probes.length; i += MAX_PARALLEL) {
      const batch = await Promise.allSettled(probes.slice(i, i + MAX_PARALLEL).map((q) => suggest(q, opts)));
      for (const r of batch) {
        if (r.status === "rejected") {
          failed++;
          continue;
        }
        r.value.forEach((s, rank) => {
          const key = s.toLowerCase();
          const h = hits.get(key) ?? { keyword: s, appearances: 0, bestRank: rank };
          h.appearances++;
          h.bestRank = Math.min(h.bestRank, rank);
          hits.set(key, h);
        });
      }
    }
    if (failed === probes.length) throw new Error("YouTube autocomplete is unreachable");
    const ideas = [...hits.values()].sort((a, b) => b.appearances - a.appearances || a.bestRank - b.bestRank);
    return { seed: base, probes: probes.length, failed, ideas };
  }

  const api = { suggest, keywordIdeas };
  root.TubeLensKeywords = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

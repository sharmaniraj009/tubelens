# TubeLens

A YouTube growth toolkit: a Chrome extension plus an MCP server for Claude. Everything runs on
your machine — there is no TubeLens backend.

## Extension features
- **Video panel** on every watch/Shorts page: views, views/hour, publish date, length, category,
  tags (*Copy tags*), a 100-point SEO score with per-check reasons, and buttons for
  *Thumbnail from this frame*, *Edit current thumbnail* and *Channel report*.
- **Thumbnail maker** (`src/thumbnail.html`): 1280×720 editor with background controls, text,
  image, shape and effect layers, templates, undo/redo, YouTube-size previews (home, search,
  up-next, mobile; light/dark), legibility/contrast/duration-badge checks, and export under
  YouTube's 2 MB limit.
- **Channel research** (`src/research.html`, needs a Data API key):
  - *Channel report* — median views, cadence, best days/hours (your time zone), Shorts vs
    long-form, outliers, underperformers and an SEO audit of recent uploads.
  - *Competitors* — track channels and compare them side by side.
  - *Outlier finder* — search a topic and rank videos by how far they beat their channel's average.
- **Popup** — keyword ideas from YouTube autocomplete, and a pre-upload SEO checker.

## MCP server (Claude Code / Claude Desktop)
| Tool | What it does | Quota |
|---|---|---|
| `get_videos` | 1–50 videos: stats, tags, views/hour, engagement, SEO score | 1–2 (no key: ≤10 via public pages) |
| `get_channels` | 1–50 channels: subscribers, views, avg views/video | 1 each |
| `channel_videos` | A channel's uploads, long-form or Shorts, sorted by newest/views/outlier | ~1 per 50 |
| `channel_report` | Cadence, best posting times, formats, outliers, SEO audit | ~3 |
| `compare_channels` | You vs competitors, side by side | ~3 per channel |
| `search_videos` | Topic search ranked by outlier ratio | 100 |
| `search_channels` | Find channels for a topic | 100 |
| `trending_videos` | Regional most-popular chart (1) or rising videos for a topic (100) | 1 / 100 |
| `trend_categories` | Category ids for the chart | 1 |
| `similar_videos` | Top performers on a seed video's topic | ~102 |
| `similar_channels` | Channels covering the same topics | ~100 per topic |
| `video_comments` | Comments with a digest of top comments and questions | 1 per 100 |
| `video_history` | Growth and title/thumbnail changes from local snapshots | 1 |
| `library` | Saved competitors and bookmarks (`~/.tubelens`) | 0–1 |
| `keyword_ideas` | Autocomplete keyword expansion | none, no key |
| `score_metadata` | SEO checklist for drafts | none, no key |

Prompts (Claude writes; the tools ground and score it): `write_titles`, `write_description`,
`write_script`, `title_review`, `video_chapters`, `video_ideas`, `comment_insights` (with reply
drafts), `channel_audit`.

`video_history` only knows what TubeLens has observed since you started using it; YouTube
doesn't expose past snapshots. Set `TUBELENS_HOME` to store data somewhere other than `~/.tubelens`.

Register with Claude Code (from this folder, after `npm install`):
```
claude mcp add tubelens -e YOUTUBE_API_KEY=YOUR_KEY -- node "$PWD/mcp/server.mjs"
```
Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "tubelens": { "command": "node",
  "args": ["/absolute/path/to/tubelens/mcp/server.mjs"], "env": { "YOUTUBE_API_KEY": "YOUR_KEY" } } } }
```
Then ask e.g. *"Use tubelens to audit @mychannel"* or run the `write_titles` prompt.

## YouTube Data API key (free)
Google Cloud Console → enable **YouTube Data API v3** → Credentials → API key. The default
quota is 10,000 units/day: list calls cost 1 unit, each search costs 100 (≈100 outlier
searches/day). The extension stores the key only in `chrome.storage.local`.

## Limits
- Scores are TubeLens's transparent checklists, not YouTube's ranking. Weights live in
  `lib/seo.js`.
- Keyword "appearances" are an autocomplete popularity hint, not search volume; no free source
  provides search volume.
- Outlier ratios use channel averages from public counts, so they are approximate.
- Transcripts: YouTube now blocks unauthenticated caption downloads, so the writing prompts
  take a transcript or notes that you supply.

## Install the extension
`chrome://extensions` → Developer mode → **Load unpacked** → this folder. Add the API key in
the extension's Settings.

## Develop
```
npm install
npm test            # unit tests (scoring, parsing, Data API client, research, thumbnail checks)
npm run test:live   # MCP smoke test against live YouTube
```
Layout: `lib/` shared logic (used by the extension and the MCP server), `src/` extension
pages and scripts, `mcp/` server, `test/` tests.

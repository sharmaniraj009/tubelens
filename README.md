# TubeLens

A YouTube growth toolkit: a Chrome extension plus an MCP server for Claude. Everything runs on
your machine — there is no TubeLens backend.

## Extension features
A **Getting started** page opens on install. It explains what works with no setup and walks
through adding the optional API key, with a *Save and test* button. The **Academy**
(`src/academy.html`) is a 12-lesson user guide with screenshots and progress tracking; the
panel's **?** button opens the lesson for the tab you're on.
- **Video panel** on every watch/Shorts page, with five tabs:
  - *Overview*: views, views/hour, publish date, length, category, likes, comments,
    engagement and subscribers, plus buttons for the thumbnail maker, clips, engagement, the
    channel report and the upload planner.
  - *SEO*: a 100-point score with the failed checks listed first.
  - *Tags*: the video's tags, with *Copy tags*.
  - *Clips*: YouTube's "Most replayed" curve as a timeline (click to jump, drag to select a
    clip), suggested clips around the moments replayed clearly more than the rest ("2.4×
    typical"), start/end marking with buttons or `Alt+[` / `Alt+]` / `Alt+S`, *Clip the last
    30s* (`Alt+C`), ±1 s nudges for each edge, loop preview, and editing of saved clips. Saved
    clips can be previewed, copied as links or as a chapter block, planned as Shorts in the
    upload planner, and deleted with undo. TubeLens doesn't download or cut video.
  - *Engage*: an engagement checklist (a question for viewers, a comment ask, links to more of
    your videos, chapters, the opening line, title length), pinned-comment drafts built from
    the video's chapters and most replayed moments, and, with an API key, the top comments that
    have no reply yet, questions first, with links that open each one.
- **Upload planner** (`src/planner.html`): a month calendar for videos, Shorts and community
  posts (click a day to add, drag to move), *Fill my calendar* (video days plus Shorts spread
  between them), a status and before/at/after-publishing checklist per upload, undated ideas,
  `.ics` export for Google/Outlook/Apple Calendar, *Shorts from clips*, and a *Strategy* tab
  (needs a key): upload rhythm, a day × time-of-day grid of views against your median, best
  slots, plain-language recommendations and a weekly playbook.
- **Thumbnail maker** (`src/thumbnail.html`): 1280×720 editor with background controls, text,
  image, shape and effect layers, templates, undo/redo, YouTube-size previews (home, search,
  up-next, mobile; light/dark), legibility/contrast/duration-badge checks, and export under
  YouTube's 2 MB limit.
- **Channel research** (`src/research.html`, needs a Data API key):
  - *Channel report* — median views, cadence, best days/hours (your time zone), Shorts vs
    long-form, outliers, underperformers and an SEO audit of recent uploads.
  - *Competitors* — track channels and compare them side by side.
  - *Outlier finder* — search a topic and rank videos by how far they beat their channel's average.
- **Popup**: shortcuts to the Upload planner, Channel research and the Thumbnail maker, your
  next planned upload, a reminder when no API key is set, keyword ideas from YouTube autocomplete, a pre-upload SEO checker, and **My clips**,
  which lists saved clips from every video and can copy them all or download them as CSV.

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
| `find_clips` | Clip-worthy moments from "Most replayed", chapters and comment timestamps | 0 (1 with comments) |
| `library` | Saved competitors and bookmarks (`~/.tubelens`) | 0–1 |
| `keyword_ideas` | Autocomplete keyword expansion | none, no key |
| `score_metadata` | SEO checklist for drafts | none, no key |

Prompts (Claude writes; the tools ground and score it): `write_titles`, `write_description`,
`write_script`, `title_review`, `video_chapters`, `video_ideas`, `comment_insights` (with reply
drafts), `channel_audit`, `clip_shorts` (Shorts from a long video: timestamps, hook, title and
caption).

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
- "Most replayed" data appears only once a video has enough views, and its intensities are
  relative to that video's hottest moment. Clip suggestions are starting points to trim, not
  edits, and evenly watched videos or Shorts often get none.
- Best posting times come from your own uploads' views, so a slot with a few uploads is a hint;
  YouTube Studio's "When your viewers are on YouTube" is the authoritative audience view.
- Transcripts: YouTube now blocks unauthenticated caption downloads, so the writing prompts
  take a transcript or notes that you supply.

## Install the extension
`chrome://extensions` → Developer mode → **Load unpacked** → this folder. Add the API key in
the extension's Settings.

## Release
Every push and pull request runs the tests and packages the extension
(`.github/workflows/ci.yml`). On `main`, a version that has no GitHub release yet is uploaded
to the Chrome Web Store, submitted for review, and released on GitHub with the zip.
```
npm version patch          # bumps package.json, package-lock.json and manifest.json, commits and tags
git push --follow-tags
```
First-time store setup, listing copy, privacy answers and the CI secrets are covered in
[store/README.md](store/README.md). The privacy policy is in [PRIVACY.md](PRIVACY.md).

## Develop
```
npm install
npm test            # unit tests (scoring, parsing, Data API client, research, clips, planner, engagement, thumbnail checks)
npm run test:live   # MCP smoke test against live YouTube
npm run package     # dist/tubelens-extension-<version>.zip for the Chrome Web Store
```
Layout: `lib/` shared logic (used by the extension and the MCP server), `src/` extension
pages and scripts, `mcp/` server, `scripts/` packaging and publishing, `store/` Chrome Web
Store listing and assets, `test/` tests.

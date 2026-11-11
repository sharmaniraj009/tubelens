# TubeLens privacy policy

Effective 12 November 2026. This policy covers the TubeLens Chrome extension and the TubeLens
MCP server.

## Summary

TubeLens runs entirely on your device. It has no servers of its own and no accounts. It
collects no analytics or telemetry, and it never sells, shares or transfers your data to its
developer or anyone else.

## What TubeLens stores, and where

Everything TubeLens keeps stays on your device:

- **Chrome extension:** stored in the extension's local storage (`chrome.storage`) in your
  browser. This holds your YouTube Data API key (if you add one), saved clips, your upload
  plan and strategy report, tracked competitor channels, SEO-checker drafts, thumbnail projects,
  Academy progress, and panel preferences.
  Uninstalling the extension deletes it.
- **MCP server:** stored in `~/.tubelens`, or in `$TUBELENS_HOME` if you set it, on your
  computer. This holds video stat snapshots, saved competitors and bookmarks.

The developer can't see any of this data.

## Network requests

TubeLens sends requests from your browser or computer only to Google services, and only to
provide the feature you're using:

| Service | What is sent | Why |
|---|---|---|
| `www.youtube.com` | The id of the video you're viewing | Read the video's public details and "Most replayed" data |
| `i.ytimg.com` | A video id | Load a video's thumbnail into the thumbnail maker |
| `suggestqueries.google.com` | The seed phrase you type | Get keyword ideas from YouTube search autocomplete |
| `www.googleapis.com/youtube` | Video and channel ids, search terms, and your own API key | YouTube Data API features: likes, subscribers, channel research, the upload strategy report, comments to reply to |

These requests are covered by the [Google Privacy Policy](https://policies.google.com/privacy).
TubeLens doesn't send them anywhere else. Exporting the upload plan to a calendar creates a
file on your device; TubeLens doesn't send it anywhere.

## YouTube API Services

TubeLens uses YouTube API Services. By using TubeLens's YouTube features you agree to the
[YouTube Terms of Service](https://www.youtube.com/t/terms). Google's handling of data is
described in the [Google Privacy Policy](https://policies.google.com/privacy).

TubeLens uses an API key that you create and control; it never asks you to sign in. To stop
all access, remove the key in TubeLens Settings and delete it in
[Google Cloud Console](https://console.cloud.google.com/apis/credentials).

## Permissions

| Permission | Why it's needed |
|---|---|
| `storage`, `unlimitedStorage` | Keep your settings, clips and thumbnail projects on your device. Thumbnail images can be larger than the default storage limit. |
| `clipboardWrite` | Copy tags, links, chapters and thumbnails when you click a Copy button |
| Access to the four hosts above | Make the requests listed under "Network requests" |

## Children

TubeLens isn't directed at children and doesn't knowingly process children's data.

## Changes and contact

Changes to this policy are published in this file, and the effective date is updated.
For questions, open an issue at https://github.com/sharmaniraj009/tubelens/issues.

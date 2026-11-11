# Publishing TubeLens to the Chrome Web Store

The first submission is done by hand, because the Chrome Web Store API can't create a new item.
After that, every new version pushed to `main` is uploaded and submitted for review by CI
(`.github/workflows/ci.yml`).

## 1. One-time: developer account

1. Sign in at https://chrome.google.com/webstore/devconsole with the Google account that will
   own the extension. Its email can't be changed later.
2. Turn on 2-step verification for that account. Google requires it to publish.
3. Accept the developer agreement and pay the one-time registration fee.
4. Under **Account**, fill in the publisher name and verify the contact email.

New publishers can have at most two published extensions.

## 2. First submission

1. Get the zip:
   - From the latest run at https://github.com/sharmaniraj009/tubelens/actions, download the
     `tubelens-extension` artifact and unzip it once. The inner
     `tubelens-extension-<version>.zip` is the file to upload.
   - Or build it locally with `npm run package`, which writes
     `dist/tubelens-extension-<version>.zip`.
2. In the dashboard, click **Add new item** and upload the zip.
3. Fill in the **Store listing**, **Privacy** and **Distribution** tabs, using sections 3–5
   below.
4. Click **Submit for review**. Review usually takes a few days, but can take a few weeks.

## 3. Store listing tab

**Description** (paste as is):

```
TubeLens is a toolkit for video creators who publish on YouTube. It adds a panel next to every video and a toolbar popup, and it runs entirely in your browser.

CLIPS
• See the "Most replayed" curve for any video, and drag across it to select a clip
• Get suggested clips around the moments viewers replay far more than the rest
• Mark clips with Alt+[ and Alt+], nudge each edge by a second, and save with Alt+S
• Missed a great moment? Alt+C saves the last 30 seconds
• Preview or loop a clip, edit it, copy a link that starts at it, or copy your clips as chapters
• Plan clips as Shorts, and export every clip as CSV

ENGAGEMENT
• A checklist of what invites comments and keeps viewers watching
• Pinned-comment drafts with a question and your most replayed moments
• The top comments still waiting for a reply, questions first (with a free API key)

UPLOAD PLANNER
• A calendar for videos, Shorts and community posts, with drag to reschedule
• Fill a month in one click: your video days, with Shorts spread in between
• A before, at and after publishing checklist for every upload
• Your best days and times to post, from your own channel's numbers (with a free API key)
• Export the plan to Google Calendar, Outlook or Apple Calendar

SEO AND STATS
• Views, views per hour, publish date, length, category and tags for any video
• A transparent 100-point SEO checklist that shows exactly which checks fail
• A pre-upload checker for your draft title, description and tags
• Keyword ideas from search autocomplete

THUMBNAILS
• Start a 1280×720 thumbnail from any video frame or existing thumbnail
• Text, image, shape and effect layers, templates, and previews at real sizes
• Readability and contrast checks, and export under the 2 MB limit

CHANNEL RESEARCH (with an optional free API key)
• Channel reports: median views, upload cadence, best days and hours, outliers
• Track competitors side by side
• Outlier finder: videos that beat their channel's average

ACADEMY
• A built-in, step-by-step guide to every tool, with screenshots

PRIVACY
No account, no server and no tracking. Everything stays in your browser. An optional YouTube Data API key that you create yourself unlocks likes, subscribers and channel research.

TubeLens is an independent tool. It isn't affiliated with or endorsed by YouTube or Google. Scores are TubeLens's own checklist, not YouTube's ranking.
```

- **Category:** Productivity → Tools.
- **Language:** English.
- **Store icon:** `icons/icon128.png`.
- **Screenshots:** `store/assets/screenshot-1-clips.png` to `screenshot-4-thumbnails.png`
  (1280×800). The Academy screenshots in `src/academy/` can be recomposed at 1280×800 for a
  fifth (planner) image.
- **Small promo tile:** `store/assets/promo-small-440x280.png`.
- **Homepage URL:** https://github.com/sharmaniraj009/tubelens
- **Support URL:** https://github.com/sharmaniraj009/tubelens/issues

Keep "YouTube" out of the extension's name. YouTube's branding guidelines don't allow it in an
app's name, but saying the app works with YouTube in the description is fine. Don't use
YouTube logos in the listing.

## 4. Privacy tab

**Single purpose:**

> Help YouTube creators improve, reuse and schedule their videos: show a video's public stats,
> SEO and engagement checklists, find and save clip-worthy moments, plan uploads, suggest
> keywords, and make thumbnails.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, optional API key, saved clips, upload plan, tracked channels, drafts and thumbnail projects on their device. |
| `unlimitedStorage` | Thumbnail projects contain full-size images that can exceed the default local storage quota. |
| `clipboardWrite` | Copy buttons for tags, keyword ideas, clip links, chapters and the finished thumbnail image. |
| `https://www.youtube.com/*` | The content script shows the TubeLens panel on video pages, and reads the video's public details and "Most replayed" data. |
| `https://i.ytimg.com/*` | Loads a video's current thumbnail into the thumbnail maker. The canvas needs CORS access to the image. |
| `https://suggestqueries.google.com/*` | Gets keyword ideas from YouTube search autocomplete. |
| `https://www.googleapis.com/youtube/*` | Calls the YouTube Data API with the user's own key, for likes, comments, subscribers, comments awaiting a reply, the upload strategy report and channel research. |

**Remote code:** No, I am not using remote code. All JavaScript ships in the package.

**Data usage:** tick these two:
- **Authentication information:** the optional API key, which is sent only to Google's API.
- **Website content:** video ids and page data read from YouTube.

Then tick all three certifications: no selling, no unrelated use, and no use for credit
decisions. Nothing is sent to the developer, as explained in the privacy policy.

**Privacy policy URL:** https://github.com/sharmaniraj009/tubelens/blob/main/PRIVACY.md

## 5. Distribution tab

Free, public, all regions.

## 6. Automatic updates from CI

When these GitHub secrets are set, each push to `main` with a version that has no GitHub release
yet does three things:
1. Packages the extension.
2. Uploads it to the Chrome Web Store and submits it for review.
3. Creates release `v<version>` with the zip attached.

The update goes live automatically once it's approved. Without the secrets, CI still tests and
packages every push, and attaches the zip to the run.

### Secrets: service account (recommended, doesn't expire)

1. In https://console.cloud.google.com, create or pick a project, then enable the
   **Chrome Web Store API**.
2. Go to **IAM & Admin → Service accounts → Create service account**. It doesn't need any roles.
   Then open it, go to **Keys → Add key → JSON**, and download the file.
3. In the Developer Dashboard, go to **Account**, add the service account's email, and save. A
   publisher can have only one service account.
4. In the Developer Dashboard, find two IDs:
   - The **publisher ID**, under **Publisher → Settings**.
   - The **extension ID**, the 32-letter id shown on the item's page and in its store URL.
5. Add the secrets to the repo, from this folder:
   ```
   gh secret set CWS_PUBLISHER_ID --body "<publisher id>"
   gh secret set CWS_EXTENSION_ID --body "<extension id>"
   gh secret set CWS_SERVICE_ACCOUNT_KEY < path/to/key.json
   ```
   Then delete the downloaded key file.

### Secrets: OAuth refresh token (alternative)

Set `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN` instead of
`CWS_SERVICE_ACCOUNT_KEY`. Follow https://developer.chrome.com/docs/webstore/using-api and use
the scope `https://www.googleapis.com/auth/chromewebstore`. Set the OAuth consent screen to
**In production**, because refresh tokens from apps left in "Testing" expire after 7 days.

## 7. Shipping an update

```
npm version patch        # or minor; bumps package.json, package-lock.json and manifest.json, commits and tags
git push --follow-tags
```

CI tests the new version, uploads it, submits it for review and creates the GitHub release.
Pushes that don't change the version run the tests only.

- **A version is still in review:** the store takes one submission at a time, so the upload step
  stops with a message. Re-run the job once the review is done. Or go to **Actions → CI → Run
  workflow** and tick *Cancel a submission still in review* to replace it.
- **Rejected:** Google emails the reason. Fix it, bump the version again and push.

## Credits

The store screenshots use *Big Buck Bunny* © Blender Foundation, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The Academy screenshots use *Spring*
by Blender Studio, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

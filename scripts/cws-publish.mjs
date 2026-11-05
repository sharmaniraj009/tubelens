#!/usr/bin/env node
// Uploads a packaged extension to the Chrome Web Store and submits it for review (API v2).
//
//   node scripts/cws-publish.mjs dist/tubelens-extension-<version>.zip
//
// Environment (GitHub Actions secrets):
//   CWS_PUBLISHER_ID, CWS_EXTENSION_ID, and one of
//   CWS_SERVICE_ACCOUNT_KEY                              JSON key of a service account added in the dashboard
//   CWS_CLIENT_ID + CWS_CLIENT_SECRET + CWS_REFRESH_TOKEN OAuth client and refresh token
//   CWS_CANCEL_PENDING=true   cancel a submission that is still in review, then upload
// Writes result=submitted | in-store | skipped to $GITHUB_OUTPUT:
//   submitted  this version was uploaded and sent for review
//   in-store   the store already has this exact version (e.g. the first, manual upload)
//   skipped    no credentials, or the store has a newer version
import { createSign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = (process.env.CWS_API_BASE || "https://chromewebstore.googleapis.com").replace(/\/+$/, "");
const TOKEN_URL = process.env.CWS_TOKEN_URL || "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const POLL_MS = Number(process.env.CWS_POLL_MS) || 5000;

const env = (k) => process.env[k]?.trim() || "";
const gha = Boolean(process.env.GITHUB_ACTIONS);
const log = (msg) => console.log(msg);
const notice = (msg) => console.log(gha ? `::notice::${msg}` : msg);
const warn = (msg) => console.log(gha ? `::warning::${msg}` : `warning: ${msg}`);
const output = (result) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\n`);
  log(`result=${result}`);
};
class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function compareVersions(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

async function accessToken() {
  const saKey = env("CWS_SERVICE_ACCOUNT_KEY");
  let body;
  if (saKey) {
    let key;
    try {
      key = JSON.parse(saKey);
    } catch {
      fail("CWS_SERVICE_ACCOUNT_KEY isn't valid JSON. Paste the whole key file as the secret.");
    }
    const now = Math.floor(Date.now() / 1000);
    const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
    body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` });
  } else {
    body = new URLSearchParams({ grant_type: "refresh_token", client_id: env("CWS_CLIENT_ID"),
      client_secret: env("CWS_CLIENT_SECRET"), refresh_token: env("CWS_REFRESH_TOKEN") });
  }
  const res = await fetch(TOKEN_URL, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    fail(`Couldn't get an access token (HTTP ${res.status}: ${json.error_description || json.error || "no details"}). ` +
      (saKey ? "Check CWS_SERVICE_ACCOUNT_KEY and that the Chrome Web Store API is enabled in that Google Cloud project."
        : "Refresh tokens from an OAuth app left in 'Testing' expire after 7 days: set the consent screen to 'In production' and make a new token, or switch to a service account."));
  }
  return json.access_token;
}

async function call(token, method, url, init = {}) {
  const res = await fetch(url, { method, ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json.error?.message ?? json.raw?.slice(0, 500) ?? "no details";
    const hint = res.status === 403 || res.status === 401
      ? " Check that these credentials belong to the publisher (a service account must be added under Account in the Developer Dashboard)."
      : res.status === 404 ? " Check CWS_PUBLISHER_ID and CWS_EXTENSION_ID." : "";
    fail(`${method} ${new URL(url).pathname} failed with HTTP ${res.status}: ${detail}.${hint}`);
  }
  return json;
}

const versionsOf = (revision) => (revision?.distributionChannels ?? []).map((c) => c.crxVersion).filter(Boolean);

export async function main(zipPath, version) {
  const publisher = env("CWS_PUBLISHER_ID"), item = env("CWS_EXTENSION_ID");
  const hasCredentials = env("CWS_SERVICE_ACCOUNT_KEY") || (env("CWS_CLIENT_ID") && env("CWS_CLIENT_SECRET") && env("CWS_REFRESH_TOKEN"));
  if (!publisher || !item || !hasCredentials) {
    notice("Chrome Web Store secrets aren't set, so nothing was uploaded. The zip is attached to this run as an artifact; see store/README.md to set up publishing.");
    return output("skipped");
  }
  const zip = readFileSync(zipPath);
  const name = `publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`;
  const token = await accessToken();

  const status = await call(token, "GET", `${API}/v2/${name}:fetchStatus`);
  if (status.takenDown) fail("The item was taken down for a policy violation. Resolve it in the Developer Dashboard first.");
  if (status.warned) warn("The item has a policy warning in the Developer Dashboard. Resolve it, or the item may be taken down.");
  const live = versionsOf(status.publishedItemRevisionStatus);
  const submitted = versionsOf(status.submittedItemRevisionStatus);
  const submittedState = status.submittedItemRevisionStatus?.state;
  log(`Store: published ${live.join(", ") || "none"}; latest submission ${submitted.join(", ") || "none"} (${submittedState ?? "none"}).`);

  const newest = [...live, ...submitted].sort(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) === 0) {
    notice(`The store already has v${version}, so nothing was uploaded.`);
    return output("in-store");
  }
  if (newest && compareVersions(version, newest) < 0) {
    warn(`The store has v${newest}, which is newer than v${version}. Raise the version in manifest.json and package.json.`);
    return output("skipped");
  }

  if (submittedState === "PENDING_REVIEW") {
    if (env("CWS_CANCEL_PENDING") !== "true") {
      fail(`v${submitted.join(", ")} is still in review, and the store takes one submission at a time. Re-run this job when the review is done, or run the CI workflow manually with "Cancel a submission still in review" ticked.`);
    }
    await call(token, "POST", `${API}/v2/${name}:cancelSubmission`, { headers: { "content-type": "application/json" }, body: "{}" });
    log(`Cancelled the review of v${submitted.join(", ")}.`);
  }

  const upload = await call(token, "POST", `${API}/upload/v2/${name}:upload`, { headers: { "content-type": "application/zip" }, body: zip });
  let state = upload.uploadState;
  log(`Upload: ${state}${upload.crxVersion ? ` (v${upload.crxVersion})` : ""}`);
  for (let i = 0; /PROGRESS/.test(state ?? "") && i < 60; i++) {
    await sleep(POLL_MS);
    state = (await call(token, "GET", `${API}/v2/${name}:fetchStatus`)).lastAsyncUploadState ?? state;
    log(`Upload: ${state}`);
  }
  if (state !== "SUCCEEDED") fail(`The upload ended as ${state}. Open the item in the Developer Dashboard to see why.`);

  const published = await call(token, "POST", `${API}/v2/${name}:publish`, { headers: { "content-type": "application/json" }, body: "{}" });
  for (const w of published.warningInfo?.warnings ?? []) warn(`${w.reason}: ${w.description}`);
  notice(`v${version} was uploaded and submitted for review (${published.state ?? "submitted"}). It goes live automatically once approved, usually within a few days.`);
  return output("submitted");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [zipPath] = process.argv.slice(2);
  if (!zipPath) {
    console.error("usage: node scripts/cws-publish.mjs <extension.zip>");
    process.exit(2);
  }
  const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
  main(zipPath, version).catch((err) => {
    console.log(gha ? `::error::${err.message}` : `error: ${err.message}`);
    if (!(err instanceof Stop)) console.error(err);
    process.exit(1);
  });
}

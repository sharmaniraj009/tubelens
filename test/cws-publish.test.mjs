// The Chrome Web Store publish script against a local fake of the v2 API and token endpoint.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { compareVersions } from "../scripts/cws-publish.mjs";

const run = promisify(execFile);
const script = new URL("../scripts/cws-publish.mjs", import.meta.url).pathname;
const repo = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(await readFile(join(repo, "manifest.json"), "utf8"));
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

let store, calls, http, dir, zipPath;
const base = () => `http://127.0.0.1:${http.address().port}`;

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), "cws-test-"));
  zipPath = join(dir, "ext.zip");
  await writeFile(zipPath, Buffer.from("PK\u0003\u0004fake zip"));
  http = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body.toString());
      if (form.get("grant_type") === "refresh_token")
        return form.get("refresh_token") === "good" ? send(200, { access_token: "tok" }) : send(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const [h, p, sig] = form.get("assertion").split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url");
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      return ok && claims.scope === "https://www.googleapis.com/auth/chromewebstore" ? send(200, { access_token: "tok" }) : send(401, { error: "invalid_signature" });
    }
    if (req.headers.authorization !== "Bearer tok") return send(401, { error: { message: "unauthenticated" } });
    if (!url.pathname.includes("/publishers/pub1/items/item1:")) return send(404, { error: { message: "Item not found" } });
    const action = url.pathname.split(":").pop();
    if (action === "fetchStatus") return send(200, store.status());
    if (action === "upload") {
      assert.equal(req.headers["content-type"], "application/zip");
      assert.ok(body.toString().startsWith("PK"));
      store.uploaded = true;
      return send(200, { uploadState: "IN_PROGRESS" });
    }
    if (action === "publish") return send(200, { state: "PENDING_REVIEW", warningInfo: { warnings: [{ reason: "TEST", description: "a warning" }] } });
    if (action === "cancelSubmission") { store.pending = null; return send(200, {}); }
    send(404, { error: { message: "unknown" } });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
});
test.after(async () => {
  http?.close();
  await rm(dir, { recursive: true, force: true });
});

function fakeStore({ live = null, pending = null } = {}) {
  const s = {
    live, pending, uploaded: false,
    status: () => ({
      publishedItemRevisionStatus: s.live ? { state: "PUBLISHED", distributionChannels: [{ crxVersion: s.live, deployPercentage: 100 }] } : undefined,
      submittedItemRevisionStatus: s.pending ? { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: s.pending }] } : undefined,
      lastAsyncUploadState: s.uploaded ? "SUCCEEDED" : undefined,
    }),
  };
  return s;
}

async function publish(extraEnv) {
  const out = join(dir, `out-${Math.random()}`);
  await writeFile(out, "");
  const env = { PATH: process.env.PATH, GITHUB_OUTPUT: out, CWS_API_BASE: base(), CWS_TOKEN_URL: `${base()}/token`, CWS_POLL_MS: "10", ...extraEnv };
  let code = 0, stdout = "";
  try {
    ({ stdout } = await run(process.execPath, [script, zipPath], { cwd: repo, env }));
  } catch (err) {
    code = err.code;
    stdout = err.stdout;
  }
  return { code, stdout, result: (await readFile(out, "utf8")).match(/result=(\S+)/)?.[1] ?? null };
}
const oauth = { CWS_PUBLISHER_ID: "pub1", CWS_EXTENSION_ID: "item1", CWS_CLIENT_ID: "id", CWS_CLIENT_SECRET: "secret", CWS_REFRESH_TOKEN: "good" };

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
});

test("without secrets it skips and exits cleanly", async () => {
  calls = [];
  const r = await publish({});
  assert.equal(r.code, 0);
  assert.equal(r.result, "skipped");
  assert.deepEqual(calls, []);
});

test("uploads, waits for processing, then submits for review", async () => {
  calls = [];
  store = fakeStore({ live: "0.0.1" });
  const r = await publish(oauth);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.result, "submitted");
  assert.deepEqual(calls, ["POST /token", "GET /v2/publishers/pub1/items/item1:fetchStatus", "POST /upload/v2/publishers/pub1/items/item1:upload",
    "GET /v2/publishers/pub1/items/item1:fetchStatus", "POST /v2/publishers/pub1/items/item1:publish"]);
  assert.match(r.stdout, /warning: TEST: a warning/);
});

test("a service account key signs a valid JWT; an existing version is left alone", async () => {
  calls = [];
  store = fakeStore({ live: version });
  const key = JSON.stringify({ client_email: "ci@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const r = await publish({ CWS_PUBLISHER_ID: "pub1", CWS_EXTENSION_ID: "item1", CWS_SERVICE_ACCOUNT_KEY: key });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.result, "in-store");
  assert.ok(!calls.some((c) => c.includes(":upload")));
});

test("a newer version in the store skips the upload", async () => {
  store = fakeStore({ live: "99.0.0" });
  const r = await publish(oauth);
  assert.equal(r.code, 0);
  assert.equal(r.result, "skipped");
  assert.match(r.stdout, /newer than/);
});

test("a submission still in review fails clearly, or is cancelled on request", async () => {
  store = fakeStore({ live: "0.0.1", pending: "0.0.2" });
  const blocked = await publish(oauth);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /still in review/);
  assert.equal(store.uploaded, false);

  calls = [];
  const cancelled = await publish({ ...oauth, CWS_CANCEL_PENDING: "true" });
  assert.equal(cancelled.code, 0, cancelled.stdout);
  assert.equal(cancelled.result, "submitted");
  assert.ok(calls.includes("POST /v2/publishers/pub1/items/item1:cancelSubmission"));
});

test("bad credentials and wrong ids explain what to check", async () => {
  store = fakeStore();
  const expired = await publish({ ...oauth, CWS_REFRESH_TOKEN: "old" });
  assert.equal(expired.code, 1);
  assert.match(expired.stdout, /expire after 7 days/);
  const wrongItem = await publish({ ...oauth, CWS_EXTENSION_ID: "nope" });
  assert.equal(wrongItem.code, 1);
  assert.match(wrongItem.stdout, /CWS_PUBLISHER_ID and CWS_EXTENSION_ID/);
});

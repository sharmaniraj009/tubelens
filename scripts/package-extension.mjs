#!/usr/bin/env node
// Packages the Chrome extension for the Chrome Web Store: dist/extension/ and
// dist/tubelens-extension-<version>.zip, with manifest.json at the zip root.
// Fails when manifest.json and package.json disagree on the version, or when a file the
// extension references (manifest, HTML pages, importScripts) is missing from the package.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["manifest.json", "icons", "lib", "src"];
const fail = (msg) => {
  console.error(`package-extension: ${msg}`);
  process.exit(1);
};

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version } = manifest;
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail(`manifest version "${version}" must be 1–4 dot-separated numbers.`);
if (version !== pkg.version) fail(`manifest.json is ${version} but package.json is ${pkg.version}; keep them the same.`);
if ((manifest.description ?? "").length > 132) fail(`manifest description is ${manifest.description.length} characters; the limit is 132.`);
if ((manifest.name ?? "").length > 75) fail(`manifest name is ${manifest.name.length} characters; the limit is 75.`);

const dist = join(root, "dist");
const out = join(dist, "extension");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of INCLUDE) cpSync(join(root, entry), join(out, entry), { recursive: true });

// Every file the extension points at, as package-relative paths.
const refs = new Map(); // path -> where it was referenced
const ref = (from, path) => {
  if (!path || /^(?:[a-z]+:|#|\/\/)/i.test(path)) return; // URLs, anchors
  const clean = path.split(/[?#]/)[0];
  refs.set(posix.normalize(from ? posix.join(posix.dirname(from), clean) : clean), from || "manifest.json");
};
for (const icon of Object.values(manifest.icons ?? {})) ref("", icon);
for (const icon of Object.values(manifest.action?.default_icon ?? {})) ref("", icon);
ref("", manifest.action?.default_popup);
ref("", manifest.options_page);
ref("", manifest.options_ui?.page);
ref("", manifest.background?.service_worker);
for (const cs of manifest.content_scripts ?? []) for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) ref("", f);

const files = [];
(function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name), r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) walk(abs, r);
    else files.push(r);
  }
})(out, "");
for (const file of files) {
  const text = /\.(html|js)$/.test(file) ? readFileSync(join(out, file), "utf8") : "";
  if (file.endsWith(".html")) for (const m of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) ref(file, m[1]);
  if (file.endsWith(".js")) for (const m of text.matchAll(/importScripts\(([^)]*)\)/g))
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) ref(file, s[1]);
}
const missing = [...refs].filter(([path]) => !existsSync(join(out, path)));
if (missing.length) fail(`missing from the package:\n${missing.map(([p, from]) => `  ${p} (referenced by ${from})`).join("\n")}`);

const zip = join(dist, `tubelens-extension-${version}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-rqX", zip, "."], { cwd: out });
const kb = Math.round(statSync(zip).size / 1024);
console.log(`Packaged ${manifest.name} v${version}: ${files.length} files, ${refs.size} references checked, ${kb} KB\n${zip}`);

#!/usr/bin/env node
// Copies package.json's version into manifest.json. Runs from `npm version` (the "version"
// script), so `npm version patch` bumps package.json, package-lock.json and manifest.json together.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const path = join(root, "manifest.json");
const text = readFileSync(path, "utf8");
const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (next === text && !text.includes(`"version": "${version}"`)) throw new Error("No version field found in manifest.json");
writeFileSync(path, next);
console.log(`manifest.json → ${version}`);

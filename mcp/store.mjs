// Local persistence for the MCP server: saved items and video stat snapshots.
// Lives in $TUBELENS_HOME or ~/.tubelens. Writes are atomic (temp file + rename).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SNAPSHOTS_PER_VIDEO = 500;
const MAX_ITEMS = 1000;

export function storeDir() {
  return process.env.TUBELENS_HOME?.trim() || join(homedir(), ".tubelens");
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(storeDir(), name), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`Couldn't read ${join(storeDir(), name)}: ${err.message}`);
  }
}

async function writeJson(name, data) {
  await mkdir(storeDir(), { recursive: true });
  const path = join(storeDir(), name);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, path);
}

// ---- Saved items: competitors (channels) and bookmarks (videos, channels, ideas, titles) ----
const LIBRARY = "library.json";

export async function listItems(collection) {
  const lib = await readJson(LIBRARY, {});
  return lib[collection] ?? [];
}

export async function addItems(collection, items) {
  const lib = await readJson(LIBRARY, {});
  const list = lib[collection] ?? [];
  const keys = new Set(list.map((i) => i.key));
  let added = 0;
  for (const item of items) {
    if (keys.has(item.key)) continue;
    list.push({ ...item, savedAt: new Date().toISOString() });
    keys.add(item.key);
    added++;
  }
  if (list.length > MAX_ITEMS) throw new Error(`The ${collection} list is limited to ${MAX_ITEMS} items.`);
  lib[collection] = list;
  await writeJson(LIBRARY, lib);
  return { added, total: list.length };
}

export async function removeItems(collection, keys) {
  const lib = await readJson(LIBRARY, {});
  const list = lib[collection] ?? [];
  const drop = new Set(keys);
  lib[collection] = list.filter((i) => !drop.has(i.key));
  await writeJson(LIBRARY, lib);
  return { removed: list.length - lib[collection].length, total: lib[collection].length };
}

// ---- Video snapshots: one per fetch, used for growth history and title/thumbnail changes ----
const HISTORY = "history.json";

export async function recordSnapshots(videos, at = new Date().toISOString()) {
  if (videos.length === 0) return;
  const history = await readJson(HISTORY, {});
  for (const v of videos) {
    if (!v?.videoId) continue;
    const list = history[v.videoId] ?? [];
    list.push({ at, views: v.views ?? null, likes: v.likes ?? null, comments: v.comments ?? null, title: v.title ?? null, thumbnail: v.thumbnail ?? null });
    history[v.videoId] = list.slice(-MAX_SNAPSHOTS_PER_VIDEO);
  }
  await writeJson(HISTORY, history);
}

export async function snapshots(videoId) {
  const history = await readJson(HISTORY, {});
  return history[videoId] ?? [];
}

// Growth between snapshots and every observed title/thumbnail change.
export function summarizeHistory(list) {
  if (list.length === 0) return { snapshots: 0, changes: [], growth: [] };
  const changes = [];
  for (let i = 1; i < list.length; i++) {
    const [a, b] = [list[i - 1], list[i]];
    if (a.title && b.title && a.title !== b.title) changes.push({ at: b.at, field: "title", from: a.title, to: b.title });
    if (a.thumbnail && b.thumbnail && a.thumbnail !== b.thumbnail) changes.push({ at: b.at, field: "thumbnail", from: a.thumbnail, to: b.thumbnail });
  }
  const growth = list.slice(1).map((b, i) => {
    const a = list[i];
    const hours = (Date.parse(b.at) - Date.parse(a.at)) / 3.6e6;
    const delta = a.views != null && b.views != null ? b.views - a.views : null;
    return { from: a.at, to: b.at, views: b.views, viewsGained: delta, viewsPerHour: delta != null && hours > 0 ? Math.round(delta / hours) : null };
  });
  return { snapshots: list.length, first: list[0].at, last: list.at(-1).at, changes, growth: growth.slice(-30) };
}

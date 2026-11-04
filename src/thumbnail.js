// TubeLens thumbnail maker: a local 1280×720 layer editor with YouTube-size previews and checks.
"use strict";
(() => {
  const T = globalThis.TubeLensThumb;
  const W = 1280;
  const H = 720;
  const SAVE_KEY = "thumbnailProject";
  const BACKUP_KEY = "thumbnailProjectBackup";
  const SEED_KEY = "thumbnailSeed";
  const FORMAT = "tubelens-thumbnail";
  const MAX_HISTORY = 80;
  const MAX_IMAGE_SIDE = 2560;
  const $ = (id) => document.getElementById(id);

  // ---------- Model ----------

  const FONTS = {
    impact: ["Impact", 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif'],
    arialBlack: ["Arial Black", '"Arial Black", "Arial Bold", Arial, sans-serif'],
    arial: ["Arial", "Arial, Helvetica, sans-serif"],
    trebuchet: ["Trebuchet MS", '"Trebuchet MS", sans-serif'],
    verdana: ["Verdana", "Verdana, Geneva, sans-serif"],
    georgia: ["Georgia", "Georgia, serif"],
    system: ["System UI", "system-ui, -apple-system, sans-serif"],
    mono: ["Courier New", '"Courier New", monospace'],
  };

  const BG_DEFAULTS = { assetId: null, color: "#1b2030", zoom: 1, panX: 0, panY: 0, brightness: 100, contrast: 100, saturation: 100, blur: 0 };
  const DEFAULTS = {
    text: { type: "text", name: "", visible: true, x: 640, y: 360, rotation: 0, text: "YOUR TEXT", font: "impact", weight: "900",
      size: 150, fill: "#ffffff", stroke: "#000000", strokeWidth: 10, shadow: true, uppercase: true, align: "center",
      lineHeight: 1, pill: false, pillColor: "#e53935" },
    image: { type: "image", name: "", visible: true, x: 640, y: 360, rotation: 0, assetId: "", scale: 1, opacity: 1 },
    shape: { type: "shape", name: "", visible: true, x: 640, y: 360, rotation: 0, kind: "rect", w: 300, h: 200, filled: true,
      fill: "#ffd60a", fillOpacity: 1, stroke: "#000000", strokeWidth: 0, radius: 16 },
    overlay: { type: "overlay", name: "", visible: true, kind: "vignette", color: "#000000", opacity: 0.6 },
  };
  const SHAPE_LABELS = { rect: "Rectangle", circle: "Circle", arrow: "Arrow" };
  const OVERLAY_LABELS = { vignette: "Vignette", gradient: "Gradient", tint: "Tint" };

  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
  const str = (v) => (typeof v === "string" ? v : "");
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rad = (deg) => (deg * Math.PI) / 180;

  const newProject = () => ({ version: 1, title: "", channel: "", background: { ...BG_DEFAULTS }, layers: [] });

  // Keep only known fields with the default's type, so imported/old projects can't break rendering.
  function sanitize(defaults, value) {
    const out = {};
    for (const [k, def] of Object.entries(defaults)) {
      const v = value?.[k];
      out[k] = def === null ? (typeof v === "string" ? v : null) : typeof v === typeof def && (typeof v !== "number" || Number.isFinite(v)) ? v : def;
    }
    return out;
  }

  function makeLayer(type, props = {}) {
    return { ...sanitize(DEFAULTS[type], { ...DEFAULTS[type], ...props }), type, id: uid("l") };
  }

  function normalizeProject(p) {
    return {
      version: 1,
      title: str(p?.title),
      channel: str(p?.channel),
      background: sanitize(BG_DEFAULTS, p?.background),
      layers: (Array.isArray(p?.layers) ? p.layers : [])
        .filter((l) => DEFAULTS[l?.type])
        .map((l) => ({ ...sanitize(DEFAULTS[l.type], l), type: l.type, id: typeof l.id === "string" && l.id ? l.id : uid("l") })),
    };
  }

  function displayName(l) {
    if (l.name) return l.name;
    if (l.type === "text") {
      const s = l.text.replace(/\s+/g, " ").trim();
      return s ? `“${s.length > 22 ? `${s.slice(0, 21)}…` : s}”` : "Text";
    }
    if (l.type === "image") return "Image";
    if (l.type === "shape") return SHAPE_LABELS[l.kind] ?? "Shape";
    return `${OVERLAY_LABELS[l.kind] ?? "Effect"} effect`;
  }

  // ---------- State ----------

  let project = newProject();
  const assets = new Map(); // id -> { src, img, ready, failed, loaded: Promise }
  let selectedId = null;
  let history = { stack: [], index: -1 };
  let lastBytes = null;
  let lastChecks = [];

  const selectedLayer = () => project.layers.find((l) => l.id === selectedId) ?? null;

  function addAsset(src, id = uid("a")) {
    const existing = assets.get(id);
    if (existing) return { id, loaded: existing.loaded };
    const img = new Image();
    const entry = { src, img, ready: false, failed: false };
    entry.loaded = new Promise((resolve) => {
      img.onload = () => { entry.ready = true; requestRender(); resolve(img); };
      img.onerror = () => { entry.failed = true; setStatus("An image couldn't be decoded.", true); resolve(null); };
    });
    img.src = src;
    assets.set(id, entry);
    return { id, loaded: entry.loaded };
  }

  const getImage = (id) => {
    const a = id ? assets.get(id) : null;
    return a?.ready ? a.img : null;
  };

  function usedAssetIds() {
    const ids = new Set();
    if (project.background.assetId) ids.add(project.background.assetId);
    for (const l of project.layers) if (l.type === "image" && l.assetId) ids.add(l.assetId);
    return ids;
  }

  function serialize() {
    const out = {};
    for (const id of usedAssetIds()) if (assets.has(id)) out[id] = assets.get(id).src;
    return { format: FORMAT, version: 1, project: JSON.parse(JSON.stringify(project)), assets: out };
  }

  function loadSerialized(data) {
    if (!data || data.format !== FORMAT || typeof data.project !== "object") throw new Error("Not a TubeLens thumbnail project");
    assets.clear();
    for (const [id, src] of Object.entries(data.assets ?? {})) {
      if (typeof src === "string" && src.startsWith("data:image/")) addAsset(src, id);
    }
    project = normalizeProject(data.project);
    selectedId = null;
    resetHistory();
    syncUI();
  }

  // ---------- Storage (works as an extension page or a plain file) ----------

  const hasChrome = () => Boolean(globalThis.chrome?.storage?.local);
  const store = {
    async get(key) {
      try {
        if (hasChrome()) return (await chrome.storage.local.get(key))[key];
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : undefined;
      } catch { return undefined; }
    },
    async set(key, value) {
      try {
        if (hasChrome()) await chrome.storage.local.set({ [key]: value });
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (e) { setStatus(`Couldn't autosave: ${e.message}`, true); }
    },
    async remove(key) {
      try {
        if (hasChrome()) await chrome.storage.local.remove(key);
        else localStorage.removeItem(key);
      } catch { /* nothing to remove */ }
    },
  };
  const session = {
    async take(key) {
      const area = globalThis.chrome?.storage?.session;
      if (!area) return undefined;
      try {
        const value = (await area.get(key))[key];
        if (value !== undefined) await area.remove(key);
        return value;
      } catch { return undefined; }
    },
  };

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(SAVE_KEY, serialize()), 800);
  }

  // ---------- History ----------

  const snapshot = () => JSON.stringify(project);
  function resetHistory() {
    history = { stack: [snapshot()], index: 0 };
    updateUndoButtons();
  }
  function commit() {
    const s = snapshot();
    if (history.stack[history.index] === s) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(s);
    if (history.stack.length > MAX_HISTORY) history.stack.shift();
    history.index = history.stack.length - 1;
    updateUndoButtons();
    scheduleSave();
  }
  function restore(index) {
    history.index = index;
    project = JSON.parse(history.stack[index]);
    if (!selectedLayer()) selectedId = null;
    syncUI();
    scheduleSave();
  }
  const undo = () => history.index > 0 && restore(history.index - 1);
  const redo = () => history.index < history.stack.length - 1 && restore(history.index + 1);
  function updateUndoButtons() {
    $("btn-undo").disabled = history.index <= 0;
    $("btn-redo").disabled = history.index >= history.stack.length - 1;
  }

  // ---------- Rendering ----------

  const measureCtx = document.createElement("canvas").getContext("2d");
  const fontString = (l) => `${l.weight} ${l.size}px ${(FONTS[l.font] ?? FONTS.impact)[1]}`;

  function measureText(l) {
    measureCtx.font = fontString(l);
    const lines = String(l.uppercase ? l.text.toUpperCase() : l.text).split("\n");
    const widths = lines.map((s) => measureCtx.measureText(s).width);
    const lh = l.size * l.lineHeight;
    const pad = l.pill ? l.size * 0.22 : 0;
    return { lines, lh, pad, w: Math.max(1, ...widths) + pad * 2, h: lines.length * lh + pad * 2 };
  }

  // Unrotated box (centre + size) of a movable layer; null for overlays.
  function layerBox(l) {
    if (l.type === "text") {
      const m = measureText(l);
      return { cx: l.x, cy: l.y, w: m.w, h: m.h, rotation: l.rotation };
    }
    if (l.type === "image") {
      const img = getImage(l.assetId);
      const iw = img ? img.naturalWidth : 200;
      const ih = img ? img.naturalHeight : 200;
      return { cx: l.x, cy: l.y, w: iw * l.scale, h: ih * l.scale, rotation: l.rotation };
    }
    if (l.type === "shape") {
      return { cx: l.x, cy: l.y, w: l.w + l.strokeWidth, h: l.h + l.strokeWidth, rotation: l.rotation };
    }
    return null;
  }

  function rgba(hex, a) {
    const c = T.hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  }

  function drawBackground(ctx, bg, scale) {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    const img = getImage(bg.assetId);
    if (!img) return;
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * bg.zoom;
    const dw = img.naturalWidth * s;
    const dh = img.naturalHeight * s;
    const grow = bg.blur * 3; // hide the soft transparent edge a blur creates
    const filters = [`brightness(${bg.brightness}%)`, `contrast(${bg.contrast}%)`, `saturate(${bg.saturation}%)`];
    if (bg.blur > 0) filters.push(`blur(${bg.blur * scale}px)`); // filter lengths ignore the transform
    ctx.save();
    ctx.filter = filters.join(" ");
    ctx.drawImage(img, (W - dw) / 2 + bg.panX - grow, (H - dh) / 2 + bg.panY - grow, dw + grow * 2, dh + grow * 2);
    ctx.restore();
  }

  function drawText(ctx, l, scale) {
    const m = measureText(l);
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(rad(l.rotation));
    if (l.pill) {
      ctx.fillStyle = l.pillColor;
      ctx.beginPath();
      ctx.roundRect(-m.w / 2, -m.h / 2, m.w, m.h, Math.min(m.h / 2, l.size * 0.3));
      ctx.fill();
    }
    ctx.font = fontString(l);
    ctx.textBaseline = "middle";
    ctx.textAlign = l.align;
    ctx.lineJoin = "round";
    const x0 = l.align === "left" ? -m.w / 2 + m.pad : l.align === "right" ? m.w / 2 - m.pad : 0;
    const top = -m.h / 2 + m.pad;
    // Shadow sizes are in device pixels, so scale them with the output.
    const shadowOn = () => {
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = l.size * 0.12 * scale;
      ctx.shadowOffsetX = ctx.shadowOffsetY = l.size * 0.04 * scale;
    };
    const shadowOff = () => { ctx.shadowColor = "transparent"; };
    m.lines.forEach((line, i) => {
      const y = top + m.lh * (i + 0.5);
      if (l.shadow) shadowOn();
      if (l.strokeWidth > 0) {
        ctx.lineWidth = l.strokeWidth * 2; // half of the stroke sits under the fill
        ctx.strokeStyle = l.stroke;
        ctx.strokeText(line, x0, y);
        shadowOff();
      }
      ctx.fillStyle = l.fill;
      ctx.fillText(line, x0, y);
      shadowOff();
    });
    ctx.restore();
  }

  function drawImageLayer(ctx, l) {
    const img = getImage(l.assetId);
    if (!img) return;
    const w = img.naturalWidth * l.scale;
    const h = img.naturalHeight * l.scale;
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.translate(l.x, l.y);
    ctx.rotate(rad(l.rotation));
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function shapePath(ctx, l) {
    const { w, h } = l;
    ctx.beginPath();
    if (l.kind === "circle") ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (l.kind === "arrow") {
      const t = h * 0.18;
      const head = Math.min(w * 0.45, h * 0.9);
      ctx.moveTo(-w / 2, -t);
      ctx.lineTo(w / 2 - head, -t);
      ctx.lineTo(w / 2 - head, -h / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(w / 2 - head, h / 2);
      ctx.lineTo(w / 2 - head, t);
      ctx.lineTo(-w / 2, t);
      ctx.closePath();
    } else ctx.roundRect(-w / 2, -h / 2, w, h, clamp(l.radius, 0, Math.min(w, h) / 2));
  }

  function drawShape(ctx, l) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(rad(l.rotation));
    shapePath(ctx, l);
    if (l.filled) {
      ctx.globalAlpha = l.fillOpacity;
      ctx.fillStyle = l.fill;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (l.strokeWidth > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = l.strokeWidth;
      ctx.strokeStyle = l.stroke;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOverlay(ctx, l) {
    ctx.save();
    if (l.kind === "vignette") {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.62);
      g.addColorStop(0, rgba(l.color, 0));
      g.addColorStop(1, rgba(l.color, l.opacity));
      ctx.fillStyle = g;
    } else if (l.kind === "gradient") {
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, rgba(l.color, l.opacity));
      g.addColorStop(0.65, rgba(l.color, 0));
      ctx.fillStyle = g;
    } else {
      ctx.globalAlpha = l.opacity;
      ctx.fillStyle = l.color;
    }
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawSelection(ctx, l) {
    const b = layerBox(l);
    if (!b) return;
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate(rad(b.rotation));
    const r = [-b.w / 2 - 8, -b.h / 2 - 8, b.w + 16, b.h + 16];
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeRect(...r);
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#3d5afe";
    ctx.strokeRect(...r);
    ctx.restore();
  }

  const DRAW = { text: drawText, image: drawImageLayer, shape: drawShape, overlay: drawOverlay };

  // Draws `proj` into ctx at the given scale (ctx canvas is W*scale × H*scale).
  function render(ctx, proj, { scale = 1, skipText = false, selection = null } = {}) {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawBackground(ctx, proj.background, scale);
    for (const l of proj.layers) {
      if (!l.visible || (skipText && l.type === "text")) continue;
      DRAW[l.type](ctx, l, scale);
    }
    if (selection) drawSelection(ctx, selection);
    ctx.restore();
  }

  // ---------- Main canvas, previews, checks ----------

  const canvas = $("canvas");
  const mainCtx = canvas.getContext("2d");
  let renderQueued = false;

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render(mainCtx, project, { selection: selectedLayer() });
      renderPreviews();
      scheduleChecks();
    });
  }

  function drawBadge(ctx, cssW, dpr) {
    const h = clamp(cssW * 0.055, 14, 20) * dpr;
    const margin = (cssW < 200 ? 4 : 8) * dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `600 ${Math.round(h * 0.66)}px system-ui, sans-serif`;
    const label = "12:34";
    const w = ctx.measureText(label).width + h * 0.6;
    const x = ctx.canvas.width - margin - w;
    const y = ctx.canvas.height - margin - h;
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4 * dpr);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, y + h / 2 + dpr * 0.5);
    ctx.restore();
  }

  function renderPreviews() {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    for (const c of document.querySelectorAll("#previews canvas")) {
      const cssW = Number(c.dataset.w);
      const cssH = Number(c.dataset.h);
      if (c.width !== Math.round(cssW * dpr)) {
        c.width = Math.round(cssW * dpr);
        c.height = Math.round(cssH * dpr);
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
      }
      const ctx = c.getContext("2d");
      render(ctx, project, { scale: c.width / W });
      drawBadge(ctx, cssW, dpr);
    }
    const title = project.title.trim() || "Your video title goes here";
    const meta = `${project.channel.trim() || "Your channel"} · 12K views · 2 days ago`;
    for (const t of document.querySelectorAll("#previews .t")) t.textContent = title;
    for (const c of document.querySelectorAll("#previews .c")) c.textContent = meta;
  }

  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = W / 4;
  sampleCanvas.height = H / 4;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  let checksTimer = null;
  let sizeTimer = null;

  function scheduleChecks() {
    clearTimeout(checksTimer);
    checksTimer = setTimeout(runChecksNow, 250);
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(measureSize, 1200);
  }

  function runChecksNow() {
    render(sampleCtx, project, { scale: 0.25, skipText: true });
    const pixels = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
    const texts = [];
    const boxes = [];
    for (const l of project.layers) {
      if (!l.visible || l.type === "overlay") continue;
      if (l.type === "image" && !getImage(l.assetId)) continue;
      const b = layerBox(l);
      const aabb = T.rotatedAabb(b);
      // Translucent, unoutlined shapes are decoration (tints), not content the badge could hide.
      const decorative = l.type === "shape" && (!l.filled || l.fillOpacity < 0.5) && l.strokeWidth === 0;
      if (!decorative) boxes.push({ id: l.id, name: displayName(l), aabb });
      if (l.type === "text" && l.text.trim()) {
        const background = l.pill
          ? T.hexToRgb(l.pillColor)
          : T.averageColor(pixels, { x: aabb.x / 4, y: aabb.y / 4, w: aabb.w / 4, h: aabb.h / 4 });
        texts.push({ id: l.id, name: displayName(l), text: l.text, fontSize: l.size, fill: l.fill, strokeWidth: l.strokeWidth, background });
      }
    }
    lastChecks = T.runChecks({ texts, boxes, canvas: { width: W, height: H }, exportBytes: lastBytes });
    renderChecks(lastChecks);
  }

  async function measureSize() {
    try {
      lastBytes = (await toBlob(exportCanvas(), "image/png")).size;
      runChecksNow();
    } catch { /* leave the previous measurement */ }
  }

  function renderChecks(results) {
    const marks = { pass: "✓", warn: "!", info: "i" };
    $("checks").replaceChildren(...results.map((r) => {
      const li = document.createElement("li");
      li.className = r.status + (r.layerId ? " clickable" : "");
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = marks[r.status];
      mark.setAttribute("aria-label", r.status === "warn" ? "Warning" : r.status === "pass" ? "Passed" : "Info");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = r.label;
      if (r.layerId) label.addEventListener("click", () => select(r.layerId));
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = r.detail;
      li.append(mark, label, detail);
      return li;
    }));
  }

  // ---------- Export ----------

  function exportCanvas() {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    render(c.getContext("2d"), project);
    return c;
  }

  const toBlob = (c, type, quality) =>
    new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), type, quality));

  // PNG unless it exceeds YouTube's 2 MB limit; then JPEG with decreasing quality.
  async function buildExportBlob() {
    const c = exportCanvas();
    let blob = await toBlob(c, "image/png");
    let ext = "png";
    if (blob.size > T.LIMITS.maxBytes) {
      ext = "jpg";
      for (let q = 0.92; q >= 0.4; q -= 0.06) {
        blob = await toBlob(c, "image/jpeg", q);
        if (blob.size <= T.LIMITS.maxBytes) break;
      }
    }
    return { blob, ext };
  }

  const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function exportImage() {
    try {
      const { blob, ext } = await buildExportBlob();
      download(blob, `${slug(project.title) || "thumbnail"}.${ext}`);
      const over = blob.size > T.LIMITS.maxBytes;
      setStatus(`Exported ${ext.toUpperCase()} (${mb(blob.size)})${ext === "jpg" ? " — PNG was over 2 MB" : ""}${over ? " — still over 2 MB, simplify the image" : ""}.`, over);
    } catch (e) { setStatus(`Export failed: ${e.message}`, true); }
  }

  async function copyImage() {
    try {
      const blob = await toBlob(exportCanvas(), "image/png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("Copied the thumbnail to the clipboard.");
    } catch (e) { setStatus(`Couldn't copy to the clipboard: ${e.message}`, true); }
  }

  // ---------- Images in ----------

  const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the file"));
    r.readAsDataURL(blob);
  });

  const loadImg = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Not a readable image"));
    img.src = src;
  });

  // Data URL for a file/blob, downscaled so the longest side is ≤ MAX_IMAGE_SIDE.
  async function normalizeImage(blob) {
    if (!String(blob.type).startsWith("image/")) throw new Error("That file isn't an image");
    const url = await readAsDataUrl(blob);
    const img = await loadImg(url);
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (long <= MAX_IMAGE_SIDE) return url;
    const s = MAX_IMAGE_SIDE / long;
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const alpha = /png|webp|gif|svg/.test(blob.type);
    return c.toDataURL(alpha ? "image/png" : "image/jpeg", 0.92);
  }

  // Seed images: data URLs pass through; https URLs are fetched so the canvas stays untainted.
  async function seedToDataUrl(src) {
    if (src.startsWith("data:image/")) return src;
    const u = new URL(src);
    if (u.protocol !== "https:") throw new Error("only https images are supported");
    let res = await fetch(u.href);
    if (!res.ok && u.pathname.includes("maxresdefault")) res = await fetch(u.href.replace("maxresdefault", "hqdefault"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalizeImage(await res.blob());
  }

  function setBackground(src) {
    const { id } = addAsset(src);
    Object.assign(project.background, { assetId: id, zoom: 1, panX: 0, panY: 0 });
    commit();
    syncUI();
  }

  async function addImageLayer(src) {
    const { id, loaded } = addAsset(src);
    const img = await loaded;
    if (!img) return;
    const scale = Math.min(1, 620 / img.naturalHeight, 900 / img.naturalWidth);
    addLayer("image", { assetId: id, scale: Math.round(scale * 100) / 100, x: 900, y: 380 });
  }

  async function replaceImage(layerId, src) {
    const l = project.layers.find((x) => x.id === layerId);
    if (!l) return;
    const { id, loaded } = addAsset(src);
    if (!(await loaded)) return;
    l.assetId = id;
    commit();
    syncUI();
  }

  async function handleIncomingImage(file, target = "auto") {
    try {
      const src = await normalizeImage(file);
      if (target === "background" || (target === "auto" && !getImage(project.background.assetId))) setBackground(src);
      else if (target.startsWith("replace:")) await replaceImage(target.slice(8), src);
      else await addImageLayer(src);
    } catch (e) { setStatus(e.message, true); }
  }

  // ---------- Layer operations ----------

  function addLayer(type, props = {}) {
    const l = makeLayer(type, props);
    project.layers.push(l);
    selectedId = l.id;
    commit();
    syncUI();
    return l;
  }

  function select(id) {
    selectedId = id;
    renderLayerList();
    renderProps();
    requestRender();
  }

  function moveLayer(id, delta) {
    const i = project.layers.findIndex((l) => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= project.layers.length) return;
    [project.layers[i], project.layers[j]] = [project.layers[j], project.layers[i]];
    commit();
    syncUI();
  }

  function duplicateLayer(id) {
    const i = project.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const copy = { ...JSON.parse(JSON.stringify(project.layers[i])), id: uid("l") };
    if (copy.type !== "overlay") { copy.x += 24; copy.y += 24; }
    project.layers.splice(i + 1, 0, copy);
    selectedId = copy.id;
    commit();
    syncUI();
  }

  function deleteLayer(id) {
    const i = project.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    project.layers.splice(i, 1);
    if (selectedId === id) selectedId = null;
    commit();
    syncUI();
  }

  // ---------- Templates (original layouts with placeholder text) ----------

  const TEMPLATES = [
    { id: "headline-left", name: "Big headline left, photo right", color: "#14213d", layers: [
      ["overlay", { kind: "gradient", color: "#000000", opacity: 0.8 }],
      ["shape", { name: "Photo spot – replace with an image layer", kind: "circle", x: 980, y: 360, w: 440, h: 440, fill: "#ffffff", fillOpacity: 0.12, stroke: "#ffffff", strokeWidth: 6 }],
      ["text", { text: "I DID\nIT", x: 330, y: 290, size: 190, fill: "#ffd60a", strokeWidth: 14, align: "left" }],
      ["text", { text: "30 DAYS", x: 300, y: 560, size: 96, fill: "#ffffff", strokeWidth: 0, shadow: false, pill: true, pillColor: "#e53935" }],
    ] },
    { id: "before-after", name: "Before / after split", color: "#222222", layers: [
      ["shape", { name: "Left tint", x: 320, y: 360, w: 640, h: 720, radius: 0, fill: "#c62828", fillOpacity: 0.35 }],
      ["shape", { name: "Right tint", x: 960, y: 360, w: 640, h: 720, radius: 0, fill: "#2e7d32", fillOpacity: 0.35 }],
      ["shape", { name: "Divider", x: 640, y: 360, w: 12, h: 720, radius: 0, fill: "#ffffff" }],
      ["text", { text: "BEFORE", x: 320, y: 110, size: 90, strokeWidth: 0, shadow: false, pill: true, pillColor: "#c62828" }],
      ["text", { text: "AFTER", x: 960, y: 110, size: 90, strokeWidth: 0, shadow: false, pill: true, pillColor: "#2e7d32" }],
      ["shape", { kind: "arrow", x: 640, y: 400, w: 220, h: 140, fill: "#ffd60a", stroke: "#000000", strokeWidth: 6 }],
    ] },
    { id: "number-list", name: "Number list", color: "#102a43", layers: [
      ["overlay", { kind: "vignette", color: "#000000", opacity: 0.75 }],
      ["text", { text: "7", x: 270, y: 370, size: 440, fill: "#ffd60a", strokeWidth: 16 }],
      ["text", { text: "THINGS\nNOBODY\nTELLS YOU", x: 800, y: 340, size: 120, align: "left", strokeWidth: 10 }],
    ] },
    { id: "reaction-arrow", name: "Reaction arrow", color: "#3a3a3a", layers: [
      ["overlay", { kind: "tint", color: "#000000", opacity: 0.15 }],
      ["shape", { name: "Highlight ring", kind: "circle", x: 920, y: 290, w: 300, h: 300, filled: false, stroke: "#ff1744", strokeWidth: 16 }],
      ["shape", { kind: "arrow", x: 610, y: 400, w: 320, h: 140, rotation: -28, fill: "#ff1744", stroke: "#ffffff", strokeWidth: 6 }],
      ["text", { text: "WAIT FOR IT…", x: 360, y: 590, size: 120, strokeWidth: 12, rotation: -3 }],
    ] },
    { id: "question", name: "Question headline", color: "#2d1b4e", layers: [
      ["overlay", { kind: "tint", color: "#000000", opacity: 0.35 }],
      ["text", { text: "IS IT\nWORTH IT?", x: 640, y: 320, size: 170, strokeWidth: 12 }],
      ["text", { text: "REVIEW", x: 640, y: 575, size: 96, strokeWidth: 0, shadow: false, pill: true, pillColor: "#3d5afe" }],
    ] },
  ];

  // Fonts differ per OS (e.g. no Impact on Linux), so shrink/shift template text to stay on canvas.
  function fitText(l, margin = 40) {
    let m = measureText(l);
    const maxW = W - margin * 2;
    if (m.w > maxW) {
      l.size = Math.floor((l.size * maxW) / m.w);
      m = measureText(l);
    }
    const box = T.rotatedAabb({ cx: l.x, cy: l.y, w: m.w, h: m.h, rotation: l.rotation });
    if (box.x < margin) l.x += margin - box.x;
    else if (box.x + box.w > W - margin) l.x -= box.x + box.w - (W - margin);
    if (box.y < margin) l.y += margin - box.y;
    else if (box.y + box.h > H - margin) l.y -= box.y + box.h - (H - margin);
    l.x = Math.round(l.x);
    l.y = Math.round(l.y);
  }

  function applyTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return false;
    project.layers = t.layers.map(([type, props]) => makeLayer(type, props));
    for (const l of project.layers) if (l.type === "text") fitText(l);
    if (!project.background.assetId) project.background.color = t.color;
    selectedId = null;
    commit();
    syncUI();
    setStatus(`Applied “${t.name}”. Click any text to edit it.`);
    return true;
  }

  // ---------- Panels ----------

  function renderLayerList() {
    const list = $("layer-list");
    if (project.layers.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No layers yet — add text, a shape or a template.";
      list.replaceChildren(li);
      return;
    }
    const btn = (label, title, onClick, disabled = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.disabled = disabled;
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    const n = project.layers.length;
    list.replaceChildren(...[...project.layers].reverse().map((l, k) => {
      const index = n - 1 - k;
      const name = displayName(l);
      const li = document.createElement("li");
      li.className = (l.id === selectedId ? "selected " : "") + (l.visible ? "" : "hidden-layer");
      const vis = document.createElement("input");
      vis.type = "checkbox";
      vis.checked = l.visible;
      vis.setAttribute("aria-label", `Show ${name}`);
      vis.addEventListener("change", () => { l.visible = vis.checked; commit(); syncUI(); });
      const sel = document.createElement("button");
      sel.type = "button";
      sel.className = "name";
      sel.textContent = name;
      sel.setAttribute("aria-pressed", String(l.id === selectedId));
      sel.addEventListener("click", () => select(l.id));
      li.append(vis, sel,
        btn("↑", `Move ${name} up`, () => moveLayer(l.id, 1), index === n - 1),
        btn("↓", `Move ${name} down`, () => moveLayer(l.id, -1), index === 0),
        btn("⧉", `Duplicate ${name}`, () => duplicateLayer(l.id)),
        btn("✕", `Delete ${name}`, () => deleteLayer(l.id)));
      return li;
    }));
  }

  const fontOptions = Object.entries(FONTS).map(([k, [label]]) => [k, label]);
  const range = (min, max, step) => ({ min, max, step });
  const PROPS = {
    text: [
      ["text", "Text", "textarea"], ["font", "Font", "select", fontOptions],
      ["weight", "Weight", "select", [["400", "Regular"], ["700", "Bold"], ["900", "Black"]]],
      ["size", "Size", "range", range(20, 450, 1)], ["fill", "Fill", "color"], ["stroke", "Outline", "color"],
      ["strokeWidth", "Outline width", "range", range(0, 40, 1)], ["shadow", "Shadow", "checkbox"],
      ["uppercase", "Uppercase", "checkbox"], ["align", "Align", "select", [["left", "Left"], ["center", "Centre"], ["right", "Right"]]],
      ["lineHeight", "Line height", "range", range(0.7, 1.6, 0.05)], ["pill", "Background box", "checkbox"],
      ["pillColor", "Box colour", "color"], ["rotation", "Rotation", "range", range(-45, 45, 1)],
    ],
    image: [
      ["scale", "Scale", "range", range(0.05, 4, 0.01)], ["rotation", "Rotation", "range", range(-180, 180, 1)],
      ["opacity", "Opacity", "range", range(0.05, 1, 0.01)],
    ],
    shape: [
      ["kind", "Shape", "select", Object.entries(SHAPE_LABELS)], ["w", "Width", "range", range(10, 1600, 1)],
      ["h", "Height", "range", range(10, 1000, 1)], ["filled", "Filled", "checkbox"], ["fill", "Fill", "color"],
      ["fillOpacity", "Fill opacity", "range", range(0, 1, 0.01)], ["stroke", "Outline", "color"],
      ["strokeWidth", "Outline width", "range", range(0, 60, 1)], ["radius", "Corner radius", "range", range(0, 300, 1)],
      ["rotation", "Rotation", "range", range(-180, 180, 1)],
    ],
    overlay: [
      ["kind", "Effect", "select", Object.entries(OVERLAY_LABELS)], ["color", "Colour", "color"],
      ["opacity", "Strength", "range", range(0, 1, 0.01)],
    ],
  };

  function field(l, [key, labelText, kind, opts]) {
    const label = document.createElement("label");
    label.append(labelText);
    let input;
    if (kind === "textarea") {
      input = document.createElement("textarea");
      input.rows = 2;
      input.value = l[key];
    } else if (kind === "select") {
      input = document.createElement("select");
      for (const [value, text] of opts) input.add(new Option(text, value, false, String(l[key]) === value));
    } else {
      input = document.createElement("input");
      input.type = kind;
      if (kind === "checkbox") { input.checked = l[key]; label.className = "check"; }
      else {
        if (opts) Object.assign(input, opts);
        input.value = l[key];
      }
    }
    const read = () => (kind === "checkbox" ? input.checked : kind === "range" || kind === "number" ? Number(input.value) : input.value);
    input.addEventListener("input", () => {
      const v = read();
      if (typeof v === "number" && !Number.isFinite(v)) return;
      l[key] = v;
      if (key === "text" || key === "name") renderLayerList();
      requestRender();
    });
    input.addEventListener("change", () => { commit(); if (key === "kind") renderProps(); });
    label.append(input);
    return label;
  }

  function renderProps() {
    const host = $("props");
    const l = selectedLayer();
    if (!l) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Select a layer (click it on the canvas or in the list) to edit it.";
      host.replaceChildren(p);
      return;
    }
    const fields = [["name", "Name", "text"], ...PROPS[l.type]];
    if (l.type !== "overlay") fields.push(["x", "X", "number", { step: 1 }], ["y", "Y", "number", { step: 1 }]);
    const nodes = fields.map((f) => field(l, f));
    if (l.type === "image") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Replace image…";
      b.addEventListener("click", () => pickImage(`replace:${l.id}`));
      nodes.push(b);
    }
    host.replaceChildren(...nodes);
  }

  function syncBackgroundInputs() {
    for (const input of document.querySelectorAll("[data-bg]")) input.value = project.background[input.dataset.bg];
    $("bg-remove").disabled = !project.background.assetId;
  }

  function syncUI() {
    renderLayerList();
    renderProps();
    syncBackgroundInputs();
    $("pv-title").value = project.title;
    $("pv-channel").value = project.channel;
    updateUndoButtons();
    requestRender();
  }

  let statusTimer = null;
  function setStatus(text, isError = false) {
    const el = $("status");
    el.textContent = text;
    el.classList.toggle("error", isError);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ""; }, isError ? 9000 : 5000);
  }

  // ---------- Canvas interaction ----------

  function toCanvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  }

  function hitTest(p) {
    for (let i = project.layers.length - 1; i >= 0; i--) {
      const l = project.layers[i];
      if (!l.visible || l.type === "overlay") continue;
      const b = layerBox(l);
      const t = -rad(b.rotation);
      const dx = p.x - b.cx;
      const dy = p.y - b.cy;
      const lx = dx * Math.cos(t) - dy * Math.sin(t);
      const ly = dx * Math.sin(t) + dy * Math.cos(t);
      if (Math.abs(lx) <= b.w / 2 + 6 && Math.abs(ly) <= b.h / 2 + 6) return l;
    }
    return null;
  }

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.focus();
    const p = toCanvasPoint(e);
    const hit = hitTest(p);
    const bg = project.background;
    if (hit) {
      selectedId = hit.id;
      drag = { kind: "layer", layer: hit, dx: p.x - hit.x, dy: p.y - hit.y, moved: false };
    } else {
      selectedId = null;
      drag = getImage(bg.assetId) ? { kind: "pan", x: p.x, y: p.y, panX: bg.panX, panY: bg.panY, moved: false } : null;
    }
    if (drag) {
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("dragging");
    }
    renderLayerList();
    renderProps();
    requestRender();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toCanvasPoint(e);
    if (drag.kind === "layer") {
      drag.layer.x = Math.round(p.x - drag.dx);
      drag.layer.y = Math.round(p.y - drag.dy);
    } else {
      project.background.panX = Math.round(clamp(drag.panX + p.x - drag.x, -640, 640));
      project.background.panY = Math.round(clamp(drag.panY + p.y - drag.y, -360, 360));
    }
    drag.moved = true;
    requestRender();
  });
  const endDrag = () => {
    if (!drag) return;
    const { moved, kind } = drag;
    drag = null;
    canvas.classList.remove("dragging");
    if (!moved) return;
    commit();
    if (kind === "layer") renderProps();
    else syncBackgroundInputs();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  const isEditable = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  document.addEventListener("keydown", (e) => {
    if (isEditable(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === "y") { e.preventDefault(); redo(); return; }
    const l = selectedLayer();
    if (!l) return;
    if (mod && key === "d") { e.preventDefault(); duplicateLayer(l.id); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteLayer(l.id); return; }
    const step = e.shiftKey ? 10 : 2;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && l.type !== "overlay") {
      e.preventDefault();
      l.x += moves[e.key][0];
      l.y += moves[e.key][1];
      commit();
      renderProps();
      requestRender();
    }
  });

  document.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    handleIncomingImage(item.getAsFile());
  });

  const wrap = $("canvas-wrap");
  wrap.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    $("drop-hint").hidden = false;
  });
  wrap.addEventListener("dragleave", () => { $("drop-hint").hidden = true; });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    $("drop-hint").hidden = true;
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) handleIncomingImage(file);
    else setStatus("Drop an image file (PNG, JPG, WebP…).", true);
  });

  // ---------- Toolbar wiring ----------

  let imageTarget = "layer";
  function pickImage(target) {
    imageTarget = target;
    $("file-image").value = "";
    $("file-image").click();
  }
  $("file-image").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleIncomingImage(f, imageTarget);
  });
  $("file-bg").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleIncomingImage(f, "background");
  });
  $("bg-upload").addEventListener("click", () => { $("file-bg").value = ""; $("file-bg").click(); });
  $("bg-remove").addEventListener("click", () => { project.background.assetId = null; commit(); syncUI(); });

  for (const input of document.querySelectorAll("[data-bg]")) {
    input.addEventListener("input", () => {
      const k = input.dataset.bg;
      project.background[k] = k === "color" ? input.value : Number(input.value);
      requestRender();
    });
    input.addEventListener("change", commit);
  }

  $("add-text").addEventListener("click", () => addLayer("text", { y: 360 }));
  $("add-image").addEventListener("click", () => pickImage("layer"));
  $("add-shape").addEventListener("change", (e) => {
    const v = e.target.value;
    e.target.value = "";
    if (v === "ring") addLayer("shape", { kind: "circle", w: 280, h: 280, filled: false, stroke: "#ff1744", strokeWidth: 16 });
    else if (v === "arrow") addLayer("shape", { kind: "arrow", w: 300, h: 140, fill: "#ff1744", stroke: "#ffffff", strokeWidth: 6 });
    else if (v) addLayer("shape", { kind: v, ...(v === "circle" ? { w: 260, h: 260 } : {}) });
  });
  $("add-overlay").addEventListener("change", (e) => {
    const v = e.target.value;
    e.target.value = "";
    if (!v) return;
    const l = makeLayer("overlay", { kind: v, opacity: v === "tint" ? 0.3 : 0.7 });
    // Effects go just above the background so text stays on top.
    project.layers.unshift(l);
    selectedId = l.id;
    commit();
    syncUI();
  });

  const tplSelect = $("template-select");
  for (const t of TEMPLATES) tplSelect.add(new Option(t.name, t.id));
  tplSelect.addEventListener("change", () => {
    const id = tplSelect.value;
    tplSelect.value = "";
    if (!id) return;
    if (project.layers.length && !confirm("Replace the current layers with this template? (Undo can bring them back.)")) return;
    applyTemplate(id);
  });

  $("btn-new").addEventListener("click", async () => {
    if ((project.layers.length || project.background.assetId) && !confirm("Start a new thumbnail? The current one will be cleared.")) return;
    project = newProject();
    assets.clear();
    selectedId = null;
    lastBytes = null;
    resetHistory();
    syncUI();
    await store.remove(SAVE_KEY);
  });
  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  $("btn-export").addEventListener("click", exportImage);
  $("btn-copy").addEventListener("click", copyImage);
  $("btn-save-project").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(serialize())], { type: "application/json" });
    download(blob, `${slug(project.title) || "thumbnail"}.tubelens.json`);
  });
  $("btn-import").addEventListener("click", () => { $("file-project").value = ""; $("file-project").click(); });
  $("file-project").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      loadSerialized(JSON.parse(await f.text()));
      commit();
      setStatus(`Opened ${f.name}.`);
    } catch (err) { setStatus(`Couldn't open that project: ${err.message}`, true); }
  });

  $("pv-title").addEventListener("input", (e) => { project.title = e.target.value; renderPreviews(); });
  $("pv-title").addEventListener("change", commit);
  $("pv-channel").addEventListener("input", (e) => { project.channel = e.target.value; renderPreviews(); });
  $("pv-channel").addEventListener("change", commit);
  const darkToggle = $("pv-dark");
  try { darkToggle.checked = localStorage.getItem("tubelens-thumb-dark") === "1"; } catch { /* storage unavailable */ }
  const applyPreviewTheme = () => {
    $("previews").classList.toggle("dark", darkToggle.checked);
    $("previews").classList.toggle("light", !darkToggle.checked);
  };
  darkToggle.addEventListener("change", () => {
    applyPreviewTheme();
    try { localStorage.setItem("tubelens-thumb-dark", darkToggle.checked ? "1" : "0"); } catch { /* storage unavailable */ }
  });
  applyPreviewTheme();

  // ---------- Start ----------

  async function init() {
    const seed = await session.take(SEED_KEY);
    const saved = await store.get(SAVE_KEY);
    if (seed && typeof seed === "object") {
      if (saved) await store.set(BACKUP_KEY, saved); // keep the previous design recoverable
      project = newProject();
      project.title = str(seed.title);
      resetHistory();
      syncUI();
      if (typeof seed.image === "string" && seed.image) {
        try {
          setBackground(await seedToDataUrl(seed.image));
          setStatus("Started from the video's frame. Add a template or text.");
        } catch (e) { setStatus(`Couldn't load the video image: ${e.message}`, true); }
      }
      return;
    }
    if (saved) {
      try { loadSerialized(saved); return; } catch { /* fall through to a blank project */ }
    }
    resetHistory();
    syncUI();
  }

  // Small hook for automated checks and debugging.
  globalThis.TubeLensThumbEditor = {
    applyTemplate,
    buildExportBlob,
    runChecks: () => { runChecksNow(); return lastChecks; },
    get project() { return JSON.parse(JSON.stringify(project)); },
    get templates() { return TEMPLATES.map((t) => t.id); },
  };

  init();
})();

"use strict";
// TubeLens Academy: lesson list, "mark as done" progress (saved in this browser), the current
// lesson in the sidebar, and screenshots that open full size.
const $ = (id) => document.getElementById(id);
const store = globalThis.chrome?.storage?.local;
const lessons = [...document.querySelectorAll(".lesson")];
let done = new Set();

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
};

// Sidebar and a "done" row under each lesson.
$("toc").replaceChildren(...lessons.map((l) => el("li", { "data-id": l.id }, el("a", { href: `#${l.id}` }, l.dataset.title))));
lessons.forEach((lesson, i) => {
  const next = lessons[i + 1];
  lesson.append(el("div", { class: "done-row" },
    el("button", { type: "button", "aria-pressed": "false", onclick: () => toggle(lesson.id) }, "Mark as done"),
    next ? el("a", { class: "next", href: `#${next.id}` }, `Next: ${next.dataset.title} →`) : el("span", { class: "next note" }, "That's everything. Happy creating!")));
});

function paint() {
  for (const lesson of lessons) {
    const on = done.has(lesson.id);
    const button = lesson.querySelector(".done-row button");
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "Done ✓" : "Mark as done";
    $("toc").querySelector(`[data-id="${lesson.id}"]`).classList.toggle("done", on);
  }
  const n = lessons.filter((l) => done.has(l.id)).length;
  $("progress-bar").style.width = `${(n / lessons.length) * 100}%`;
  $("progress-text").textContent = n === lessons.length ? "All lessons done. Nice work!" : `${n} of ${lessons.length} lessons done`;
}

async function toggle(id) {
  if (done.has(id)) done.delete(id);
  else done.add(id);
  paint();
  try { await store?.set({ academyDone: [...done] }); } catch { /* progress is a convenience */ }
}

// Highlight the lesson being read.
const links = new Map([...$("toc").querySelectorAll("a")].map((a) => [a.getAttribute("href").slice(1), a]));
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const a of links.values()) a.removeAttribute("aria-current");
    links.get(e.target.id)?.setAttribute("aria-current", "true");
  }
}, { rootMargin: "-20% 0px -70% 0px" });
lessons.forEach((l) => observer.observe(l));

// Screenshots open full size; click or Esc closes.
const zoom = $("zoom");
for (const img of document.querySelectorAll("figure img")) {
  img.addEventListener("click", () => {
    zoom.querySelector("img").src = img.src;
    zoom.querySelector("img").alt = img.alt;
    zoom.showModal();
  });
}
zoom.addEventListener("click", () => zoom.close());

(async () => {
  try {
    const { academyDone } = (await store?.get("academyDone")) ?? {};
    if (Array.isArray(academyDone)) done = new Set(academyDone);
  } catch { /* start fresh */ }
  paint();
})();

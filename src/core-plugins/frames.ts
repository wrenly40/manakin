// Frames — the traditional animation layer (Manakin Plugin API v1).
//
// Owns the filmstrip: the horizontal strip of frame thumbnails along
// the bottom of the workspace, above the player bar. One tile per
// frame (a live thumbnail, the frame number, a hold badge when the
// frame is held), click a tile to edit that frame, drag a tile to
// reorder it, right-click / long-press a tile for duplicate, delete,
// add-after and hold, `+` at the end adds a copy of the current
// frame. The onion toggle ghosts the neighbouring frames on the
// canvas (the canvas plugin renders them; this plugin only owns the
// toggle). The timeline itself lives in the core document; everything
// here goes through api.doc, and the strip re-renders on the
// "timeline" event.

import type { PluginContext, PluginModule } from "../plugins";
import type { Frame } from "../model";

export const manifest = {
  id: "core-frames",
  name: "Frames",
  version: "1.0.0",
  apiVersion: "1",
  description: "The traditional animation layer: filmstrip, frame operations, onion skin.",
  permissions: ["doc", "events", "shell", "ui"],
};

// The onion icon: two overlapping frames, the one behind dashed —
// the next drawing traced from the last. Same 20px / 1.8-stroke ink
// language as the toolbar icons.
const ONION_ICON = "<svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\" stroke-dasharray=\"3 2.4\"/><rect x=\"9\" y=\"4\" width=\"12\" height=\"12\" rx=\"2\"/></svg>";
const PLUS_ICON = "<svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg>";

const THUMB_W = 96;
const THUMB_H = 54;

let api!: PluginContext;
let stripEl!: HTMLElement;
let tilesEl!: HTMLElement;
let onionBtn!: HTMLButtonElement;
let addBtn!: HTMLButtonElement;
let menuEl: HTMLDivElement | null = null;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let dragIndex = -1;
// Thumbnails are cached by frame id + a signature of the frame's
// items (plus the stage background, which changes how the frame
// renders): a playback frame change re-renders the strip, but only a
// frame whose drawing changed gets redrawn. The thumbnail renders at
// t01 0, where every behaviour reads ~0, so the motion state needs no
// part in the signature — the drawing is the thumbnail.
const thumbCache = new Map<string, { sig: string; url: string }>();
let lastFrameSig = "";

function thumbSig(frame: Frame): string {
  const bg = api.doc.getStageBg();
  return `${bg.id}|${bg.custom ?? ""}|${JSON.stringify(frame.items)}`;
}

function renderThumb(frame: Frame): string {
  const sig = thumbSig(frame);
  const cached = thumbCache.get(frame.id);
  if (cached && cached.sig === sig) return cached.url;
  const cv = document.createElement("canvas");
  cv.width = THUMB_W;
  cv.height = THUMB_H;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  const { w } = api.app.getStageSize();
  const tl = api.doc.getTimeline();
  const index = tl.frames.indexOf(frame);
  if (index >= 0) api.app.renderFrameAt(index, 0, g, THUMB_W / w);
  const url = cv.toDataURL("image/png");
  thumbCache.set(frame.id, { sig, url });
  return url;
}

function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

function openMenu(frameIndex: number, x: number, y: number): void {
  closeMenu();
  const tl = api.doc.getTimeline();
  const frame = tl.frames[frameIndex];
  if (!frame) return;
  const menu = document.createElement("div");
  menu.className = "frame-menu";
  menu.setAttribute("role", "menu");
  const mkItem = (label: string, disabled: boolean, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "frame-menu-item";
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      fn();
    });
    menu.appendChild(b);
    return b;
  };
  mkItem("Duplicate frame", false, () => api.doc.duplicateFrame(frameIndex));
  mkItem("Delete frame", tl.frames.length <= 1, () => api.doc.deleteFrame(frameIndex));
  mkItem("Add frame after", false, () => {
    api.doc.setCurrentFrame(frameIndex);
    api.doc.addFrame();
  });
  const holdRow = document.createElement("div");
  holdRow.className = "frame-menu-hold";
  const holdLab = document.createElement("span");
  holdLab.textContent = "Hold";
  holdRow.appendChild(holdLab);
  const holdSeg = document.createElement("div");
  holdSeg.className = "seg";
  holdSeg.setAttribute("role", "group");
  holdSeg.setAttribute("aria-label", "Hold duration");
  for (const d of [1, 2, 3, 4]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = frame.duration === d ? "active" : "";
    b.textContent = String(d);
    b.setAttribute("aria-label", `Hold ${d} frame${d === 1 ? "" : "s"}`);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      api.doc.setFrameHold(frameIndex, d);
    });
    holdSeg.appendChild(b);
  }
  holdRow.appendChild(holdSeg);
  menu.appendChild(holdRow);
  document.body.appendChild(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - mw - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - mh - 8))}px`;
  menuEl = menu;
}

function buildTile(frame: Frame, index: number, current: number): HTMLButtonElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "frame-tile" + (index === current ? " current" : "");
  tile.draggable = true;
  tile.setAttribute("aria-label", `Frame ${index + 1}${frame.duration > 1 ? `, held ${frame.duration} frames` : ""}${index === current ? ", current" : ""}`);
  const thumb = document.createElement("img");
  thumb.className = "frame-thumb";
  thumb.src = renderThumb(frame);
  thumb.alt = "";
  thumb.draggable = false;
  tile.appendChild(thumb);
  const num = document.createElement("span");
  num.className = "frame-num";
  num.textContent = String(index + 1);
  tile.appendChild(num);
  if (frame.duration > 1) {
    const hold = document.createElement("span");
    hold.className = "frame-hold";
    hold.textContent = `×${frame.duration}`;
    tile.appendChild(hold);
  }
  tile.addEventListener("click", () => {
    api.doc.setCurrentFrame(index);
  });
  tile.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMenu(index, e.clientX, e.clientY);
  });
  tile.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    const sx = e.clientX, sy = e.clientY;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      openMenu(index, sx, sy);
    }, 500);
    const cancel = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8 || ev.type === "pointerup") {
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
        tile.removeEventListener("pointermove", cancel);
        tile.removeEventListener("pointerup", cancel);
      }
    };
    tile.addEventListener("pointermove", cancel);
    tile.addEventListener("pointerup", cancel);
  });
  tile.addEventListener("dragstart", (e) => {
    dragIndex = index;
    e.dataTransfer?.setData("text/plain", String(index));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  tile.addEventListener("dragover", (e) => {
    if (dragIndex < 0 || dragIndex === index) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = tile.getBoundingClientRect();
    tile.classList.toggle("drop-before", e.clientX < r.left + r.width / 2);
    tile.classList.toggle("drop-after", e.clientX >= r.left + r.width / 2);
  });
  tile.addEventListener("dragleave", () => {
    tile.classList.remove("drop-before", "drop-after");
  });
  tile.addEventListener("drop", (e) => {
    e.preventDefault();
    tile.classList.remove("drop-before", "drop-after");
    if (dragIndex < 0 || dragIndex === index) return;
    const r = tile.getBoundingClientRect();
    const to = e.clientX < r.left + r.width / 2 ? index : index + 1;
    api.doc.moveFrame(dragIndex, to);
  });
  tile.addEventListener("dragend", () => {
    dragIndex = -1;
    for (const t of tilesEl.querySelectorAll(".frame-tile")) t.classList.remove("drop-before", "drop-after");
  });
  return tile;
}

// Rebuild the tiles only when the frame list itself changed (ids and
// holds in order); otherwise update the highlight, the hold badges
// and any thumbnail whose drawing changed. A rebuild during playback
// would drop the strip's scroll position, so the scroll is preserved
// either way.
function renderStrip(): void {
  const tl = api.doc.getTimeline();
  const current = api.doc.getCurrentFrame();
  const frameSig = tl.frames.map((f) => `${f.id}:${f.duration}`).join(",");
  const scroll = tilesEl.scrollLeft;
  if (frameSig !== lastFrameSig) {
    lastFrameSig = frameSig;
    tilesEl.innerHTML = "";
    tl.frames.forEach((frame, i) => tilesEl.appendChild(buildTile(frame, i, current)));
  } else {
    const tiles = [...tilesEl.querySelectorAll<HTMLElement>(".frame-tile")];
    tiles.forEach((tile, i) => {
      tile.classList.toggle("current", i === current);
      const img = tile.querySelector<HTMLImageElement>(".frame-thumb");
      if (img) img.src = renderThumb(tl.frames[i]);
      const hold = tile.querySelector(".frame-hold");
      if (tl.frames[i].duration > 1 && !hold) {
        const h = document.createElement("span");
        h.className = "frame-hold";
        h.textContent = `×${tl.frames[i].duration}`;
        tile.appendChild(h);
      } else if (tl.frames[i].duration <= 1 && hold) {
        hold.remove();
      } else if (hold) {
        hold.textContent = `×${tl.frames[i].duration}`;
      }
    });
  }
  tilesEl.scrollLeft = scroll;
  // The onion toggle only ghosts something when there is a neighbour
  // to ghost; with one frame it is disabled, not hidden.
  const onion = api.doc.getOnionSkin();
  onionBtn.classList.toggle("active", onion);
  onionBtn.setAttribute("aria-pressed", String(onion));
  onionBtn.disabled = tl.frames.length < 2;
}

function onDocumentClick(e: MouseEvent): void {
  if (!menuEl) return;
  const t = e.target as HTMLElement | null;
  if (t && menuEl.contains(t)) return;
  closeMenu();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && menuEl) closeMenu();
}

export function activate(a: PluginContext): void {
  api = a;
  stripEl = api.shell.filmstrip;
  stripEl.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "filmstrip-inner";
  onionBtn = document.createElement("button");
  onionBtn.type = "button";
  onionBtn.className = "filmstrip-btn";
  onionBtn.innerHTML = ONION_ICON;
  onionBtn.setAttribute("aria-label", "Onion skin");
  onionBtn.addEventListener("click", () => {
    api.doc.setOnionSkin(!api.doc.getOnionSkin());
  });
  inner.appendChild(onionBtn);
  tilesEl = document.createElement("div");
  tilesEl.className = "filmstrip-tiles";
  inner.appendChild(tilesEl);
  addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "filmstrip-btn";
  addBtn.innerHTML = PLUS_ICON;
  addBtn.setAttribute("aria-label", "Add frame");
  addBtn.addEventListener("click", () => {
    api.doc.addFrame();
  });
  inner.appendChild(addBtn);
  stripEl.appendChild(inner);
  api.ui.attachTooltip(onionBtn, "Onion skin");
  api.ui.attachTooltip(addBtn, "Add frame");
  api.events.on("timeline", renderStrip);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
  renderStrip();
}

export function deactivate(): void {
  api.events.off("timeline", renderStrip);
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeyDown);
  closeMenu();
  thumbCache.clear();
  lastFrameSig = "";
  stripEl.innerHTML = "";
}

export const plugin: PluginModule = { manifest, activate, deactivate };

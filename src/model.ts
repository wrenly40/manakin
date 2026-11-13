// Pure model: the document, its items, the view math, and the save format.
// No DOM, no module state except the id counter. The shell owns all state
// and all side effects; it calls into here and passes what is needed.

export type Pt = { x: number; y: number };

export type StrokeItem = {
  id: string;
  type: "stroke";
  points: Pt[];
  color: string;
  width: number;
};

export type ShapeItem = {
  id: string;
  type: "shape";
  kind: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  width: number;
  fill: boolean;
};

export type TextItem = {
  id: string;
  type: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
};

export type Item = StrokeItem | ShapeItem | TextItem;

export type Frame = {
  id: string;
  items: Item[];
  hold: number;
};

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  frames: Frame[];
};

export type StageId = "wide" | "square" | "portrait";

export type Document = {
  layers: Layer[];
  stageId: StageId;
  stageBg: string;
  fps: number;
};

// ---------------------------------------------------------------------------
// Ids and constants
// ---------------------------------------------------------------------------

let idCounter = 0;

export function nid(): string {
  idCounter += 1;
  return `id-${Date.now().toString(36)}-${idCounter}`;
}

export const SAVE_KEY = "manakin-v2";
export const UNDO_LIMIT = 50;

export const STAGES: { id: StageId; label: string; w: number; h: number }[] = [
  { id: "wide", label: "16:9", w: 960, h: 540 },
  { id: "square", label: "Square", w: 720, h: 720 },
  { id: "portrait", label: "Portrait", w: 540, h: 960 },
];

export function stageSizeFor(stageId: StageId): { w: number; h: number } {
  const s = STAGES.find((st) => st.id === stageId) ?? STAGES[0];
  return { w: s.w, h: s.h };
}

export const PALETTE = ["#1d1d1f", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#007aff"];

export const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const PAN_MARGIN = 80; // px of the stage kept visible in the workspace

// ---------------------------------------------------------------------------
// View math — the stage lives in a pasteboard workspace; the view (zoom,
// pan, rotation) is view state only, never saved.
// ---------------------------------------------------------------------------

export type ViewState = { zoom: number; panX: number; panY: number; rotateDeg: number };

export type WorkspaceLayout = {
  s: number;
  ox: number;
  oy: number;
  cw: number;
  ch: number;
  r: number;
};

export function workspaceLayoutFor(
  view: ViewState,
  stage: { w: number; h: number },
  wrap: { w: number; h: number },
): WorkspaceLayout {
  const fit = Math.min(wrap.w / stage.w, wrap.h / stage.h);
  const s = fit * view.zoom;
  const ox = (wrap.w - stage.w * s) / 2 + view.panX;
  const oy = (wrap.h - stage.h * s) / 2 + view.panY;
  return { s, ox, oy, cw: wrap.w, ch: wrap.h, r: (view.rotateDeg * Math.PI) / 180 };
}

export function normDeg(d: number): number {
  let n = d % 360;
  if (n > 180) n -= 360;
  if (n <= -180) n += 360;
  return n;
}

// Client point -> stage point. Rotation is around the workspace centre,
// so the inverse rotation runs first, then the scale/offset un-apply.
export function stagePointFor(
  layout: WorkspaceLayout,
  clientX: number,
  clientY: number,
  rectLeft: number,
  rectTop: number,
): Pt {
  const x = clientX - rectLeft;
  const y = clientY - rectTop;
  const cx = layout.cw / 2;
  const cy = layout.ch / 2;
  const cos = Math.cos(-layout.r);
  const sin = Math.sin(-layout.r);
  const dx = x - cx;
  const dy = y - cy;
  const rx = dx * cos - dy * sin + cx;
  const ry = dx * sin + dy * cos + cy;
  return { x: (rx - layout.ox) / layout.s, y: (ry - layout.oy) / layout.s };
}

export function stageToScreenFor(layout: WorkspaceLayout, p: Pt): Pt {
  const x = layout.ox + p.x * layout.s;
  const y = layout.oy + p.y * layout.s;
  const cx = layout.cw / 2;
  const cy = layout.ch / 2;
  const cos = Math.cos(layout.r);
  const sin = Math.sin(layout.r);
  const dx = x - cx;
  const dy = y - cy;
  return { x: dx * cos - dy * sin + cx, y: dx * sin + dy * cos + cy };
}

// Keep at least PAN_MARGIN px of the stage visible on each side.
export function clampAxis(pan: number, base: number, size: number, view: number): number {
  const min = PAN_MARGIN - size - base;
  const max = view - PAN_MARGIN - base;
  return Math.min(max, Math.max(min, pan));
}

// ---------------------------------------------------------------------------
// Timeline — positions are in frames at the document's fps; a frame covers `hold` frames.
// ---------------------------------------------------------------------------

export function frameTotalHold(layer: Layer): number {
  return layer.frames.reduce((n, f) => n + Math.max(1, f.hold), 0);
}

export function timelineLength(doc: Document): number {
  return Math.max(1, ...doc.layers.map((l) => frameTotalHold(l)));
}

export function frameAt(layer: Layer, pos: number): { frame: Frame; index: number } {
  let at = 0;
  for (let i = 0; i < layer.frames.length; i++) {
    const hold = Math.max(1, layer.frames[i].hold);
    if (pos < at + hold) return { frame: layer.frames[i], index: i };
    at += hold;
  }
  const last = layer.frames.length - 1;
  return { frame: layer.frames[last], index: last };
}

export function frameStartPos(layer: Layer, index: number): number {
  let at = 0;
  for (let i = 0; i < index && i < layer.frames.length; i++) {
    at += Math.max(1, layer.frames[i].hold);
  }
  return at;
}

// ---------------------------------------------------------------------------
// Geometry — bounding boxes and hit testing, all in stage coordinates.
// ---------------------------------------------------------------------------

export function itemBBox(it: Item): { x: number; y: number; w: number; h: number } {
  if (it.type === "stroke") {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of it.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = it.width / 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (it.type === "shape") {
    return { x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h), w: Math.abs(it.w), h: Math.abs(it.h) };
  }
  // Text: measured by the canvas at draw time; the caller keeps a measured
  // box on the item through `measureText`, here a rough box from the size.
  const w = Math.max(8, it.text.length * it.size * 0.55);
  return { x: it.x, y: it.y - it.size, w, h: it.size * 1.2 };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function distToStroke(it: StrokeItem, p: Pt): number {
  let best = Infinity;
  for (let i = 0; i + 1 < it.points.length; i++) {
    best = Math.min(best, distToSegment(p, it.points[i], it.points[i + 1]));
  }
  if (it.points.length === 1) best = Math.hypot(p.x - it.points[0].x, p.y - it.points[0].y);
  return best;
}

// Topmost item under the point, or null. Strokes hit on their ink first,
// then filled shapes, then shape outlines — so a thin wing over a body
// still wins when the point is on its ink.
export function hitTestItems(items: Item[], p: Pt): Item | null {
  const tol = 10;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === "stroke" && distToStroke(it, p) <= Math.max(tol, it.width / 2 + 4)) return it;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== "shape") continue;
    const b = itemBBox(it);
    const insideX = p.x >= b.x - tol && p.x <= b.x + b.w + tol;
    const insideY = p.y >= b.y - tol && p.y <= b.y + b.h + tol;
    // A click inside the shape selects it, filled or not; a click just
    // outside still catches the outline.
    if (insideX && insideY) return it;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type !== "text") continue;
    const b = itemBBox(it);
    if (p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4) return it;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Eraser — pen-like: strokes split where the eraser passes, shapes and
// text delete whole. Pure: returns the new item list and whether it changed.
// ---------------------------------------------------------------------------

export function eraseFromItems(items: Item[], p: Pt, radius: number): { items: Item[]; changed: boolean } {
  let changed = false;
  const out: Item[] = [];
  for (const it of items) {
    if (it.type === "stroke") {
      const runs: Pt[][] = [[]];
      let hit = false;
      for (const pt of it.points) {
        if (Math.hypot(pt.x - p.x, pt.y - p.y) <= radius) {
          if (runs[runs.length - 1].length > 0) runs.push([]);
          hit = true;
        } else {
          runs[runs.length - 1].push(pt);
        }
      }
      if (!hit) {
        out.push(it);
        continue;
      }
      changed = true;
      // A run of one point is invisible, so it drops out.
      for (const run of runs) {
        if (run.length >= 2) out.push({ ...it, id: nid(), points: run });
      }
      continue;
    }
    if (it.type === "shape") {
      const b = itemBBox(it);
      const inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
      const nearOutline =
        inside &&
        (Math.min(Math.abs(p.x - b.x), Math.abs(p.x - (b.x + b.w))) <= radius + it.width ||
          Math.min(Math.abs(p.y - b.y), Math.abs(p.y - (b.y + b.h))) <= radius + it.width);
      if ((it.fill && inside) || nearOutline) {
        changed = true;
        continue;
      }
      out.push(it);
      continue;
    }
    const b = itemBBox(it);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      changed = true;
      continue;
    }
    out.push(it);
  }
  return { items: out, changed };
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v2: number): string => Math.round((v2 + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function normHex(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) {
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  }
  return null;
}

export function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Save format — unknown input, narrowed with guards; a bad save is null.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanPoint(v: unknown): Pt | null {
  if (!isRecord(v)) return null;
  if (typeof v.x !== "number" || typeof v.y !== "number") return null;
  return { x: v.x, y: v.y };
}

function cleanItem(v: unknown): Item | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.color !== "string") return null;
  if (v.type === "stroke" && Array.isArray(v.points)) {
    const points = v.points.map(cleanPoint).filter((p): p is Pt => p !== null);
    if (points.length === 0) return null;
    return { id: v.id, type: "stroke", points, color: v.color, width: clampNum(v.width, 1, 64, 4) };
  }
  if (v.type === "shape" && typeof v.kind === "string" && (v.kind === "rect" || v.kind === "ellipse")) {
    if (typeof v.x !== "number" || typeof v.y !== "number") return null;
    return {
      id: v.id, type: "shape", kind: v.kind, x: v.x, y: v.y,
      w: typeof v.w === "number" ? v.w : 0, h: typeof v.h === "number" ? v.h : 0,
      color: v.color, width: clampNum(v.width, 1, 64, 4), fill: v.fill === true,
    };
  }
  if (v.type === "text" && typeof v.x === "number" && typeof v.y === "number" && typeof v.text === "string") {
    return { id: v.id, type: "text", x: v.x, y: v.y, text: v.text, size: clampNum(v.size, 8, 200, 32), color: v.color };
  }
  return null;
}

function cleanFrame(v: unknown): Frame | null {
  if (!isRecord(v) || typeof v.id !== "string" || !Array.isArray(v.items)) return null;
  const items = v.items.map(cleanItem).filter((it): it is Item => it !== null);
  return { id: v.id, items, hold: clampNum(v.hold, 1, 24, 1) };
}

function cleanLayer(v: unknown): Layer | null {
  if (!isRecord(v) || typeof v.id !== "string" || !Array.isArray(v.frames)) return null;
  const frames = v.frames.map(cleanFrame).filter((f): f is Frame => f !== null);
  if (frames.length === 0) return null;
  return {
    id: v.id,
    name: typeof v.name === "string" && v.name.length > 0 ? v.name : "Layer",
    visible: v.visible !== false,
    locked: v.locked === true,
    opacity: clampNum(v.opacity, 0, 100, 100),
    frames,
  };
}

export function parseSave(raw: unknown): Document | null {
  if (!isRecord(raw) || !Array.isArray(raw.layers)) return null;
  const layers = raw.layers.map(cleanLayer).filter((l): l is Layer => l !== null);
  if (layers.length === 0) return null;
  const stageId = raw.stageId === "square" || raw.stageId === "portrait" ? raw.stageId : "wide";
  const stageBg = typeof raw.stageBg === "string" && normHex(raw.stageBg) ? (raw.stageBg as string) : "#ffffff";
  return { layers, stageId, stageBg, fps: clampNum(raw.fps, 1, 60, 12) };
}

// ---------------------------------------------------------------------------
// Sample — a small scene that proves layers and frames work: a static
// background (sun, hill) and a character layer with a 3-frame bouncing ball.
// ---------------------------------------------------------------------------

export function sampleDocument(): Document {
  const sun: ShapeItem = {
    id: nid(), type: "shape", kind: "ellipse", x: 690, y: 60, w: 90, h: 90,
    color: "#ffcc00", width: 2, fill: true,
  };
  const hill: ShapeItem = {
    id: nid(), type: "shape", kind: "ellipse", x: -70, y: 430, w: 1100, h: 220,
    color: "#34c759", width: 2, fill: true,
  };
  const ball = (y: number): ShapeItem => ({
    id: nid(), type: "shape", kind: "ellipse", x: 450, y: y - 30, w: 60, h: 60,
    color: "#ff3b30", width: 2, fill: true,
  });
  return {
    stageId: "wide",
    stageBg: "#ffffff",
    fps: 12,
    // Layers[0] is the top layer: the ball draws above the background.
    layers: [
      {
        id: nid(), name: "Ball", visible: true, locked: false, opacity: 100,
        frames: [
          { id: nid(), items: [ball(150)], hold: 2 },
          { id: nid(), items: [ball(300)], hold: 2 },
          { id: nid(), items: [ball(460)], hold: 2 },
        ],
      },
      { id: nid(), name: "Background", visible: true, locked: false, opacity: 100, frames: [{ id: nid(), items: [sun, hill], hold: 1 }] },
    ],
  };
}

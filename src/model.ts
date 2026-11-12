// Model — the pure core of Manakin.
//
// Everything in this file is data and pure functions: types, constants,
// geometry, animation math, colour helpers, save migration, the sample
// bird. No DOM, no module state except the id counter and the
// smoothed-amplitude map (the same shape as Bowerbird's model.ts
// WeakMap index). The shell (src/main.ts) and the core plugins
// (src/core-plugins/) own all state and all side effects; they call
// into here and pass what the model needs as arguments.

// ---------------------------------------------------------------------------
// Types and constants — behaviours
// ---------------------------------------------------------------------------

export type Pt = { x: number; y: number };
export type BehaviourName = "Bob" | "Sway" | "Breathe" | "Blink" | "Spin" | "Wander" | "Bounce" | "Stretch" | "Orbit" | "Fade" | "Tremble";
export const BEHAVIOURS: BehaviourName[] = ["Bob", "Sway", "Breathe", "Blink", "Spin", "Wander", "Bounce", "Stretch", "Orbit", "Fade", "Tremble"];
// Cycle N = the behaviour completes N cycles per loop. The loop
// length is the Loop setting (4/6/8/10s, default 4s): Cycle 1 is one
// cycle per loop, Cycle 10 is ten. A layer's effective cycle count is
// its own Cycle times its behaviour group's Cycle multiplier (both
// whole numbers), so every behaviour completes a whole number of
// cycles in the loop and the pose at the wrap equals the pose at the
// start (see loopMs / loopCycles below).
export type LoopLength = 4 | 6 | 8 | 10;
export const LOOP_LENGTHS: LoopLength[] = [4, 6, 8, 10];
export const DEFAULT_LOOP_LENGTH: LoopLength = 4;
export function isLoopLength(v: unknown): v is LoopLength {
  return v === 4 || v === 6 || v === 8 || v === 10;
}
export const CYCLE_MIN = 1;
export const CYCLE_MAX = 10;
export function clampCycle(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  return Math.max(CYCLE_MIN, Math.min(CYCLE_MAX, Math.round(v)));
}
// Old saves stored a stepped rate (0.25/0.5/1/2) under `tempo` (or
// `speed` before that). Map it to a Cycle: 2 -> Cycle 2, anything
// slower -> Cycle 1 — there is no slower-than-one-cycle in the new
// model, so a 0.25/0.5 layer gets faster on load (one cycle per loop).
export const LEGACY_RATE_STOPS = [0.25, 0.5, 1, 2];
export function cycleFromLegacyRate(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 1;
  let best = LEGACY_RATE_STOPS[0], bestD = Math.abs(v - LEGACY_RATE_STOPS[0]);
  for (const s of LEGACY_RATE_STOPS) {
    const d = Math.abs(v - s);
    if (d <= bestD) { best = s; bestD = d; } // exact ties go to the higher stop
  }
  return best >= 2 ? 2 : 1;
}
// Easing reshapes the normalized cycle phase u in [0,1] with a function
// mapping 0->0 and 1->1, so every easing still closes the loop seamlessly.
// Smooth is the identity: the current sine, so old saves and the sample
// bird move exactly as before.
export type EasingName = "smooth" | "linear" | "ease-in-out" | "snap";
export const EASING_IDS: EasingName[] = ["smooth", "linear", "ease-in-out", "snap"];
// The picker-visible labels: "Ease In-Out" does not fit the 232px card
// at full size, so it reads "In-Out" (the full name is the button's
// aria-label).
export const EASING_LABELS: Record<EasingName, string> = { smooth: "Smooth", linear: "Linear", "ease-in-out": "In-Out", snap: "Snap" };
export const EASING_ARIA: Record<EasingName, string> = { smooth: "Easing Smooth", linear: "Easing Linear", "ease-in-out": "Easing Ease In-Out", snap: "Easing Snap" };
export function easePhase(easing: EasingName, u: number): number {
  if (easing === "linear") {
    // Constant-speed rise and fall (a triangle wave out of the sine):
    // the phase warp whose sine is linear in u. asin() is exact at the
    // joints (u = 0.25 / 0.75), so the warp is continuous.
    if (u < 0.25) return Math.asin(4 * u) / (Math.PI * 2);
    if (u < 0.75) return 0.5 - Math.asin(2 - 4 * u) / (Math.PI * 2);
    return 1 + Math.asin(4 * u - 4) / (Math.PI * 2);
  }
  if (easing === "ease-in-out") return u * u * (3 - 2 * u); // smoothstep: dwell at the extremes, sweep through the middle
  if (easing === "snap") return Math.floor(u * 4) / 4; // 4 holds per cycle: hold, then jump
  return u; // smooth
}
// One small icon per behaviour, same 1.8-stroke, 20px, ink language as the
// toolbar icons — each distinct at a glance in the layer stack.
export const LAYER_ICONS: string[] = [
  "<svg viewBox=\"0 0 24 24\"><path d=\"M12 3v18\"/><path d=\"M8 7l4-4 4 4\"/><path d=\"M8 17l4 4 4-4\"/></svg>", // Bob: vertical double arrow
  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 12h18\"/><path d=\"M7 8l-4 4 4 4\"/><path d=\"M17 8l4 4-4 4\"/></svg>", // Sway: horizontal double arrow
  "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3.5\"/><circle cx=\"12\" cy=\"12\" r=\"8\"/></svg>", // Breathe: concentric circles
  "<svg viewBox=\"0 0 24 24\"><path d=\"M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z\"/><circle cx=\"12\" cy=\"12\" r=\"2.2\" fill=\"currentColor\" stroke=\"none\"/></svg>", // Blink: eye outline with a dot
  "<svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.6\"/><path d=\"M20 3v4h-4\"/></svg>", // Spin: circular arrow
  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 16c2.5-5 5 2 7.5-3s5 2 7.5-3\" stroke-dasharray=\"0.5 3.5\"/></svg>", // Wander: dotted squiggle
  "<svg viewBox=\"0 0 24 24\"><path d=\"M5 17c2-6 4-8 7-8s5 2 7 8\"/><circle cx=\"12\" cy=\"18.5\" r=\"2.4\" fill=\"currentColor\" stroke=\"none\"/></svg>", // Bounce: hop arc over the ball at rest
  "<svg viewBox=\"0 0 24 24\"><rect x=\"6\" y=\"10\" width=\"12\" height=\"4\" rx=\"1\"/><path d=\"M12 3v4M12 17v4\"/></svg>", // Stretch: wide flat rect, squash arrows
  "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8\"/><circle cx=\"20\" cy=\"12\" r=\"2.2\" fill=\"currentColor\" stroke=\"none\"/></svg>", // Orbit: ring with a dot on it
  "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"8\"/><circle cx=\"12\" cy=\"12\" r=\"3\" fill=\"currentColor\" stroke=\"none\" opacity=\"0.35\"/></svg>", // Fade: ring with a faint centre
  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 12l2.5-4 2.5 8 2.5-10 2.5 12 2.5-10 2.5 8 2.5-4\"/></svg>", // Tremble: dense fast zigzag
];
// Z-order icons: stacked squares, same 1.8-stroke ink language —
// the filled square is the one on top (front) or at the back (back);
// forward/backward add a small arrow for the one-step move.
export const ARRANGE_ICONS: string[] = [
  "<svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"3.5\" width=\"11\" height=\"11\" rx=\"1.5\"/><rect x=\"9.5\" y=\"9.5\" width=\"11\" height=\"11\" rx=\"1.5\" fill=\"currentColor\" stroke=\"none\"/></svg>", // Bring to Front
  "<svg viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"7\" width=\"10\" height=\"10\" rx=\"1.5\"/><rect x=\"10\" y=\"11\" width=\"10\" height=\"10\" rx=\"1.5\"/><path d=\"M12 2v3\"/><path d=\"M10 3.5 12 1.5l2 2\"/></svg>", // Bring Forward
  "<svg viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"3\" width=\"10\" height=\"10\" rx=\"1.5\"/><rect x=\"10\" y=\"7\" width=\"10\" height=\"10\" rx=\"1.5\"/><path d=\"M12 22v-3\"/><path d=\"M10 20.5l2 2 2-2\"/></svg>", // Send Backward
  "<svg viewBox=\"0 0 24 24\"><rect x=\"3.5\" y=\"3.5\" width=\"11\" height=\"11\" rx=\"1.5\" fill=\"currentColor\" stroke=\"none\"/><rect x=\"9.5\" y=\"9.5\" width=\"11\" height=\"11\" rx=\"1.5\"/></svg>", // Send to Back
];
// Align icons: a guide line plus a rectangle — the line is the edge
// the items align to, the rectangle is the item. The rectangles are
// drawn large (10x9 in the 24 box) so they read at the row's 20px size.
export const ALIGN_ICONS: string[] = [
  "<svg viewBox=\"0 0 24 24\"><path d=\"M4 3v18\"/><rect x=\"8\" y=\"7.5\" width=\"10\" height=\"9\" rx=\"1\"/></svg>", // Left
  "<svg viewBox=\"0 0 24 24\"><path d=\"M12 3v18\"/><rect x=\"7\" y=\"7.5\" width=\"10\" height=\"9\" rx=\"1\"/></svg>", // Centre
  "<svg viewBox=\"0 0 24 24\"><path d=\"M20 3v18\"/><rect x=\"6\" y=\"7.5\" width=\"10\" height=\"9\" rx=\"1\"/></svg>", // Right
  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 4h18\"/><rect x=\"7\" y=\"8\" width=\"10\" height=\"9\" rx=\"1\"/></svg>", // Top
  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 12h18\"/><rect x=\"7\" y=\"7.5\" width=\"10\" height=\"9\" rx=\"1\"/></svg>", // Middle
  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 20h18\"/><rect x=\"7\" y=\"7\" width=\"10\" height=\"9\" rx=\"1\"/></svg>", // Bottom
];

// ---------------------------------------------------------------------------
// Types — items
// ---------------------------------------------------------------------------

export type BehaviourGroup = {
  id: string;
  name: string;
  members: string[]; // layer ids; a layer belongs to at most one group
  active: boolean; // group off suspends its members without losing their own on/off states
  cycle: number; // 1-10, whole-number multiplier on each member's Cycle
  amplitude: number; // 0-1, scales each member's amplitude
};
// One layer = one instance of a behaviour on one item. The same behaviour
// can appear several times in a stack, each instance with its own id and
// its own parameters; only the parameters relevant to its behaviour are
// used (Blink also uses blinkDuration, Spin also spinReverse, Wander also
// wanderSmooth, Orbit also orbitReverse). Easing reshapes every
// behaviour's cycle phase; Smooth is the identity, so it is the current
// motion for the existing six.
export type LayerParams = {
  on: boolean;
  cycle: number; // 1-10, cycles per loop
  amplitude: number; // 0-1
  offset: number; // 0-1 shift of the motion within its own cycle
  easing: EasingName; // reshapes the cycle phase; 'smooth' is the current sine
  blinkDuration: number; // % of the cycle the blink bump spans (Blink only)
  spinReverse: boolean; // Spin only: run the spin backwards
  wanderSmooth: number; // 0-100% (Wander only); 50+ is the smooth drift
  orbitReverse: boolean; // Orbit only: run the orbit counter-clockwise
};
export type BehaviourLayer = LayerParams & {
  id: string; // unique within the item; never reused
  behaviour: number; // 0-10, index into BEHAVIOURS
};
export type ItemBase = {
  id: string;
  color: string;
  width: number;
  layers: BehaviourLayer[]; // ordered behaviour stack, top-to-bottom as shown in the panel; only these are listed and contribute to the motion
  groups: BehaviourGroup[]; // per-item behaviour groups; flat only, no groups in groups
  stash: Partial<Record<number, LayerParams>>; // most recently removed instance's params, keyed by behaviour index, so re-adding restores them
};
export type StrokeItem = ItemBase & { type: "stroke"; points: Pt[] };
export type ShapeItem = ItemBase & {
  type: "shape";
  kind: "rect" | "ellipse";
  x: number; y: number; w: number; h: number;
  fillSolid: boolean;
};
export type TextItem = ItemBase & { type: "text"; x: number; y: number; text: string; size: number };
export type Item = StrokeItem | ShapeItem | TextItem;

// Item groups: containers of canvas items with their own behaviour
// layers — distinct from BehaviourGroup (v9, per-item collections of
// behaviour layers). Flat only, no nesting, no groups in groups.
export type ItemGroup = {
  id: string;
  memberIds: string[]; // item ids; a group has at least 2 members
  layers: BehaviourLayer[]; // the group's own behaviour stack, applied to every member
  groups: BehaviourGroup[]; // behaviour groups on the group's stack, like an item's
};

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export const STAGE_BGS = [
  { id: "white", label: "White", value: "#ffffff" },
  { id: "paper", label: "Paper", value: "#f5f0e6" },
  { id: "sage", label: "Sage", value: "#dfe8dd" },
  { id: "sky", label: "Sky", value: "#dbe9f5" },
  { id: "ink", label: "Ink", value: "#1d1d1f" },
] as const;
export type StageBgId = (typeof STAGE_BGS)[number]["id"] | "custom";
// Composition grids for drawing: one overlay style per option, drawn on
// the stage canvas only — never in PNG/WebM exports (renderFrame gates
// the grid on the on-screen canvas). 'grid' is the dots pattern (24px
// step, 2px dots) — the default grid was Off, so Dots, Bowerbird's
// default, is the one drawing grid.
export type GridMode = "empty" | "grid" | "thirds" | "horizon" | "centre" | "golden";
export function migrateGridMode(v: unknown): GridMode | null {
  if (v === "empty" || v === "grid" || v === "thirds" || v === "horizon" || v === "centre" || v === "golden") return v;
  if (v === "dots" || v === "lines") return "grid"; // old three-way options
  if (v === "off") return "empty";
  return null;
}
// Mini previews for the grid tiles: the pattern itself, drawn small.
export const GRID_OPTIONS: { id: GridMode; label: string; svg: string }[] = [
  { id: "empty", label: "Empty", svg: "<svg viewBox=\"0 0 40 30\" aria-hidden=\"true\"></svg>" },
  { id: "grid", label: "Grid", svg: "<svg viewBox=\"0 0 40 30\" aria-hidden=\"true\"><g fill=\"rgba(29,29,31,0.55)\"><circle cx=\"8\" cy=\"7.5\" r=\"1\"/><circle cx=\"16\" cy=\"7.5\" r=\"1\"/><circle cx=\"24\" cy=\"7.5\" r=\"1\"/><circle cx=\"32\" cy=\"7.5\" r=\"1\"/><circle cx=\"8\" cy=\"15\" r=\"1\"/><circle cx=\"16\" cy=\"15\" r=\"1\"/><circle cx=\"24\" cy=\"15\" r=\"1\"/><circle cx=\"32\" cy=\"15\" r=\"1\"/><circle cx=\"8\" cy=\"22.5\" r=\"1\"/><circle cx=\"16\" cy=\"22.5\" r=\"1\"/><circle cx=\"24\" cy=\"22.5\" r=\"1\"/><circle cx=\"32\" cy=\"22.5\" r=\"1\"/></g></svg>" },
  { id: "thirds", label: "Thirds", svg: "<svg viewBox=\"0 0 40 30\" aria-hidden=\"true\"><g stroke=\"rgba(29,29,31,0.55)\" stroke-width=\"1\"><path d=\"M13.3 2v26M26.7 2v26M2 10h36M2 20h36\"/></g></svg>" },
  { id: "horizon", label: "Horizon", svg: "<svg viewBox=\"0 0 40 30\" aria-hidden=\"true\"><g stroke=\"rgba(29,29,31,0.55)\" stroke-width=\"1\"><path d=\"M2 10h36M2 20h36\"/></g></svg>" },
  { id: "centre", label: "Centre", svg: "<svg viewBox=\"0 0 40 30\" aria-hidden=\"true\"><g stroke=\"rgba(29,29,31,0.55)\" stroke-width=\"1\"><path d=\"M20 2v26M2 15h36\"/></g></svg>" },
  { id: "golden", label: "Golden", svg: "<svg viewBox=\"0 0 40 30\" aria-hidden=\"true\"><g stroke=\"rgba(29,29,31,0.55)\" stroke-width=\"1\"><path d=\"M15.3 2v26M24.7 2v26M2 11.5h36M2 18.5h36\"/></g></svg>" },
];
export const STAGES = [
  { id: "wide", label: "16:9", w: 960, h: 540 },
  { id: "square", label: "Square", w: 720, h: 720 },
  { id: "portrait", label: "Portrait", w: 540, h: 960 },
] as const;

// ---------------------------------------------------------------------------
// Identity — ids and fresh layers
// ---------------------------------------------------------------------------

export const SAVE_KEY = "manakin-v1";
let uid = 0;
export function nid(): string {
  uid += 1;
  return `i${Date.now().toString(36)}${uid}`;
}
export function defaultLayerParams(): LayerParams {
  return { on: true, cycle: 1, amplitude: 0.66, offset: 0, easing: "smooth", blinkDuration: 26, spinReverse: false, wanderSmooth: 50, orbitReverse: false };
}
// The default blink duration of 26% is a raised-cosine bump whose
// half-depth width (13%) matches the old sin^8 blink.
export function newLayer(b: number, params?: Partial<LayerParams>): BehaviourLayer {
  return { id: nid(), behaviour: b, ...defaultLayerParams(), ...params };
}
export function baseItem(color: string, width: number): ItemBase {
  return { id: nid(), color, width, layers: [], groups: [], stash: {} };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}
export const PAN_MARGIN = 80; // px of the stage kept visible in the workspace
// Clamp the pan so the stage can never be dragged entirely out of
// view. When the stage fits the workspace it stays fully inside;
// when it is bigger, at least PAN_MARGIN px of it stays visible on
// each side. Called after every zoom, wheel and drag change, and on
// resize (a smaller window re-clamps the same pan).
export function clampAxis(pan: number, base: number, size: number, view: number): number {
  if (size <= view) return Math.max(-base, Math.min(view - size - base, pan));
  return Math.max(PAN_MARGIN - size - base, Math.min(view - PAN_MARGIN - base, pan));
}

export type ToolId = "select" | "brush" | "eraser" | "shape" | "text" | "paint";

export type WorkspaceLayout = { s: number; ox: number; oy: number; cw: number; ch: number; r: number };

// The view state the layout math reads: zoom, pan, rotation. The shell
// owns the values; the model only computes from them.
export type ViewState = { zoom: number; panX: number; panY: number; rotateDeg: number };

// Workspace layout: the canvas covers the whole centre area; the stage
// is a card inside it, scaled to fit (s <= 1) and centred. Items live
// in stage coordinates (origin at the stage's top-left), so a point in
// the workspace maps to stage coords by subtracting the stage origin
// and dividing by the scale; outside the stage that gives negative or
// over-size coordinates, which is exactly where pasteboard items sit.
export function workspaceLayoutFor(view: ViewState, stage: { w: number; h: number }, wrap: { w: number; h: number }): WorkspaceLayout {
  const fit = Math.min(1, wrap.w / stage.w, wrap.h / stage.h) || 1; // 0-size wrap (pre-layout) falls back to 1
  // Zoom scales the fit around the workspace centre, so the stage
  // grows/shrinks in place; at zoom > 1 the origin goes negative and
  // the stage extends past the visible workspace (clipped by the
  // canvas). Pan shifts that centred origin in workspace pixels.
  // Rotation turns the whole view around the workspace centre.
  // Every stage-space conversion reads this, so hit-testing, drawing,
  // dragging and the marquee all follow zoom, pan and rotation.
  const s = fit * view.zoom;
  return { s, ox: (wrap.w - stage.w * s) / 2 + view.panX, oy: (wrap.h - stage.h * s) / 2 + view.panY, cw: wrap.w, ch: wrap.h, r: view.rotateDeg * Math.PI / 180 };
}

// Stage point from a pointer event: undo the view rotation first
// (rotate the screen point back around the workspace centre), then
// the usual origin/scale mapping. The clamp is in unrotated workspace
// space, which bounds the visible region either way.
export function stagePointFor(layout: WorkspaceLayout, clientX: number, clientY: number, rectLeft: number, rectTop: number): Pt {
  const { s, ox, oy, cw, ch, r } = layout;
  let x = clientX - rectLeft, y = clientY - rectTop;
  if (r !== 0) {
    const cx = cw / 2, cy = ch / 2;
    const cos = Math.cos(-r), sin = Math.sin(-r);
    const dx = x - cx, dy = y - cy;
    x = cx + dx * cos - dy * sin;
    y = cy + dx * sin + dy * cos;
  }
  const sx = (x - ox) / s;
  const sy = (y - oy) / s;
  const minX = -ox / s, maxX = (cw - ox) / s;
  const minY = -oy / s, maxY = (ch - oy) / s;
  return { x: Math.max(minX, Math.min(maxX, sx)), y: Math.max(minY, Math.min(maxY, sy)) };
}

// Stage to screen coordinates, for DOM overlays (the text editor):
// the inverse of stagePointFor — origin and scale, then the view
// rotation around the workspace centre.
export function stageToScreenFor(layout: WorkspaceLayout, p: Pt): Pt {
  const { s, ox, oy, cw, ch, r } = layout;
  let x = ox + p.x * s, y = oy + p.y * s;
  if (r !== 0) {
    const cx = cw / 2, cy = ch / 2;
    const cos = Math.cos(r), sin = Math.sin(r);
    const dx = x - cx, dy = y - cy;
    x = cx + dx * cos - dy * sin;
    y = cy + dx * sin + dy * cos;
  }
  return { x, y };
}

export function stageSizeFor(stageId: "wide" | "square" | "portrait"): { w: number; h: number } {
  const s = STAGES.find((s) => s.id === stageId) ?? STAGES[0];
  return { w: s.w, h: s.h };
}

export function stageBgValueFor(bgId: StageBgId, custom: string | null): string {
  if (bgId === "custom" && custom) return custom;
  return STAGE_BGS.find((b) => b.id === bgId)?.value ?? "#ffffff";
}

// Drop the eased amplitudes of layers that no longer exist. A layer id
// is never reused, so a dropped entry is never read again.
export function pruneSmoothed(liveLayerIds: Set<string>): void {
  for (const id of [...smoothed.keys()]) if (!liveLayerIds.has(id)) smoothed.delete(id);
}

// Clear every eased amplitude (clearing the stage): the next motion
// starts from rest.
export function clearSmoothed(): void {
  smoothed.clear();
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

// Colour helpers
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
export function normHex(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^[0-9a-f]{6}$/.test(t)) return `#${t}`;
  if (/^#[0-9a-f]{3}$/.test(t)) {
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sample and migration
// ---------------------------------------------------------------------------

// Sample and migration
export function sampleBird(): Item[] {
  // Bob, Sway, Breathe, Blink on; Spin, Wander off.
  const act = [true, true, true, true, false, false];
  const withAct = (it: Item): Item => {
    // The bird's Blink runs at amplitude 0.85, the depth the motion used
    // to hard-code, so the sample bird blinks exactly as before.
    it.layers = act.map((on, b) => (on ? newLayer(b, b === 3 ? { amplitude: 0.85 } : undefined) : null)).filter((l): l is BehaviourLayer => l !== null);
    return it;
  };
  const body: ShapeItem = { ...baseItem("#1d1d1f", 4), type: "shape", kind: "ellipse", x: 370, y: 230, w: 220, h: 150, fillSolid: false };
  const head: ShapeItem = { ...baseItem("#1d1d1f", 4), type: "shape", kind: "ellipse", x: 545, y: 175, w: 95, h: 95, fillSolid: false };
  const eye: ShapeItem = { ...baseItem("#1d1d1f", 2), type: "shape", kind: "ellipse", x: 578, y: 208, w: 14, h: 14, fillSolid: true };
  const beak: StrokeItem = { ...baseItem("#d2592d", 4), type: "stroke", points: [{ x: 632, y: 208 }, { x: 668, y: 224 }, { x: 632, y: 240 }, { x: 632, y: 208 }] };
  const wing: StrokeItem = { ...baseItem("#007aff", 4), type: "stroke", points: [{ x: 430, y: 285 }, { x: 480, y: 325 }, { x: 535, y: 288 }] };
  const leg1: StrokeItem = { ...baseItem("#1d1d1f", 4), type: "stroke", points: [{ x: 450, y: 380 }, { x: 450, y: 415 }] };
  const leg2: StrokeItem = { ...baseItem("#1d1d1f", 4), type: "stroke", points: [{ x: 510, y: 380 }, { x: 510, y: 415 }] };
  return [body, head, eye, beak, wing, leg1, leg2].map(withAct);
}

// The per-behaviour parameter arrays are retired: after migration an item
// carries only layer instances (plus the stash). Drop the legacy fields so
// saved JSON stays clean.
export function dropLegacy(anyIt: Record<string, unknown>): void {
  delete anyIt.pattern;
  delete anyIt.active;
  delete anyIt.speeds;
  delete anyIt.amounts;
  delete anyIt.phases;
  delete anyIt.blinkDuration;
  delete anyIt.spinReverse;
  delete anyIt.wanderSmooth;
}

export function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  return (typeof v === "number" && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : dflt;
}
// Merge saved params with the current defaults, clamping them. Migration
// is keyed on FIELD PRESENCE: an old save stores percents under `amount`
// (66 = 66%) and `phase` (50 = half a loop) and a stepped rate under
// `tempo`/`speed`, while a new save stores fractions under
// `amplitude`/`offset` and an integer `cycle` — so an old amount of 1 (1%)
// and a new amplitude of 1 (full) are told apart by the field name, never
// by the value.
export function cleanParams(p: Partial<LayerParams>): LayerParams {
  const legacy = p as Partial<LayerParams> & { amount?: unknown; phase?: unknown; speed?: unknown; tempo?: unknown };
  return {
    on: typeof p.on === "boolean" ? p.on : true,
    cycle: typeof p.cycle === "number" ? clampCycle(p.cycle)
      : typeof legacy.tempo === "number" ? cycleFromLegacyRate(legacy.tempo)
      : typeof legacy.speed === "number" ? cycleFromLegacyRate(legacy.speed) : 1,
    amplitude: typeof p.amplitude === "number"
      ? clampNum(p.amplitude, 0, 1, 0.66)
      : clampNum(legacy.amount, 0, 100, 66) / 100,
    offset: typeof p.offset === "number"
      ? clampNum(p.offset, 0, 1, 0)
      : clampNum(legacy.phase, 0, 100, 0) / 100,
    easing: typeof p.easing === "string" && (EASING_IDS as string[]).includes(p.easing) ? p.easing as EasingName : "smooth",
    blinkDuration: clampNum(p.blinkDuration, 10, 60, 26),
    spinReverse: p.spinReverse === true,
    wanderSmooth: clampNum(p.wanderSmooth, 0, 100, 50),
    orbitReverse: p.orbitReverse === true,
  };
}
// Validate a saved layer stack in place: drop layers with a bad
// behaviour index, give missing/duplicate ids fresh ones, clean params.
export function cleanLayerArray(raw: unknown): BehaviourLayer[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const clean: BehaviourLayer[] = [];
  for (const r of raw as unknown[]) {
    const l = (r ?? {}) as Partial<BehaviourLayer>;
    if (typeof l.behaviour !== "number" || !Number.isInteger(l.behaviour) || l.behaviour < 0 || l.behaviour >= BEHAVIOURS.length) continue;
    let id = typeof l.id === "string" && l.id ? l.id : nid();
    if (seenIds.has(id)) id = nid();
    seenIds.add(id);
    clean.push({ id, behaviour: l.behaviour, ...cleanParams(l) });
  }
  return clean;
}
// An item group survives a load only when at least 2 of its members
// still exist; its layers are cleaned like an item's stack.
export function migrateItemGroup(raw: unknown, items: Item[]): ItemGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Partial<ItemGroup>;
  const memberIds = (Array.isArray(g.memberIds) ? g.memberIds : [])
    .filter((m): m is string => typeof m === "string" && items.some((i) => i.id === m));
  const unique = [...new Set(memberIds)];
  if (unique.length < 2) return null;
  const layers = cleanLayerArray(g.layers);
  const ids = new Set(layers.map((l) => l.id));
  const seenMember = new Set<string>();
  const groups = (Array.isArray(g.groups) ? g.groups : []).map((r) => {
    const bg = (r ?? {}) as Partial<BehaviourGroup>;
    const legacyBg = bg as Partial<BehaviourGroup> & { tempo?: unknown; speed?: unknown };
    const members = (Array.isArray(bg.members) ? bg.members : [])
      .filter((m): m is string => typeof m === "string" && ids.has(m) && !seenMember.has(m));
    members.forEach((m) => seenMember.add(m));
    if (members.length === 0) return null;
    return {
      id: typeof bg.id === "string" && bg.id ? bg.id : nid(),
      name: behaviourGroupName(bg.name),
      members: [...new Set(members)],
      active: typeof bg.active === "boolean" ? bg.active : true,
      cycle: typeof bg.cycle === "number" ? clampCycle(bg.cycle)
        : typeof legacyBg.tempo === "number" ? cycleFromLegacyRate(legacyBg.tempo)
        : typeof legacyBg.speed === "number" ? cycleFromLegacyRate(legacyBg.speed) : 1,
      amplitude: typeof bg.amplitude === "number" ? clampNum(bg.amplitude, 0, 1, 1) : 1,
    };
  }).filter((x): x is BehaviourGroup => x !== null);
  return {
    id: typeof g.id === "string" && g.id ? g.id : nid(),
    memberIds: unique,
    layers,
    groups,
  };
}
export function migrateItemGroups(raw: unknown, items: Item[]): ItemGroup[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const out: ItemGroup[] = [];
  for (const r of raw as unknown[]) {
    const g = migrateItemGroup(r, items);
    if (!g) continue;
    if (seenIds.has(g.id)) g.id = nid();
    seenIds.add(g.id);
    out.push(g);
  }
  return out;
}

// Behaviour-group display names: "Layer Group 1", … — the "Layer"
// prefix keeps them distinct from item groups ("Group objects").
// Old saves named them "Group N"; those are renamed on load so the
// numbering stays consistent with newly created groups.
export function behaviourGroupName(raw: unknown): string {
  const name = typeof raw === "string" && raw.trim() ? raw.trim() : "";
  const m = /^Group (\d+)$/.exec(name);
  if (m) return `Layer Group ${m[1]}`;
  return name || "Layer Group";
}

export function migrateItem(it: Item): void {
  const anyIt = it as unknown as Record<string, unknown>;
  // New format: layers are instances with ids (an empty array is a valid
  // empty stack). Just validate, in place.
  const layersAreInstances = Array.isArray(it.layers) &&
    (it.layers.length === 0 || (typeof it.layers[0] === "object" && it.layers[0] !== null));
  if (layersAreInstances) {
    it.layers = cleanLayerArray(it.layers);
    const ids = new Set(it.layers.map((l) => l.id));
    const seenMember = new Set<string>();
    it.groups = (Array.isArray(it.groups) ? it.groups : []).map((raw) => {
      const g = (raw ?? {}) as Partial<BehaviourGroup>;
      const legacy = g as Partial<BehaviourGroup> & { speed?: unknown; amount?: unknown; tempo?: unknown };
      const members = (Array.isArray(g.members) ? g.members : [])
        .filter((m): m is string => typeof m === "string" && ids.has(m) && !seenMember.has(m));
      members.forEach((m) => seenMember.add(m));
      if (members.length === 0) return null;
      return {
        id: typeof g.id === "string" && g.id ? g.id : nid(),
        name: behaviourGroupName(g.name),
        members: [...new Set(members)],
        active: typeof g.active === "boolean" ? g.active : true,
        cycle: typeof g.cycle === "number" ? clampCycle(g.cycle)
          : typeof legacy.tempo === "number" ? cycleFromLegacyRate(legacy.tempo)
          : typeof legacy.speed === "number" ? cycleFromLegacyRate(legacy.speed) : 1,
        amplitude: typeof g.amplitude === "number"
          ? clampNum(g.amplitude, 0, 1, 1)
          : clampNum(legacy.amount, 0, 100, 100) / 100,
      };
    }).filter((g): g is BehaviourGroup => g !== null);
    if (!it.stash || typeof it.stash !== "object" || Array.isArray(it.stash)) {
      it.stash = {};
    } else {
      const cleanStash: Partial<Record<number, LayerParams>> = {};
      for (const [k, v] of Object.entries(it.stash)) {
        const b = Number(k);
        if (!Number.isInteger(b) || b < 0 || b >= BEHAVIOURS.length || !v || typeof v !== "object") continue;
        cleanStash[b] = cleanParams(v as Partial<LayerParams>);
      }
      it.stash = cleanStash;
    }
    dropLegacy(anyIt);
    return;
  }
  // Old format: per-behaviour parameter arrays, with an optional
  // layers: number[] stack (v10) or no stack at all (pre-v10).
  // v2 saves stored a 6x8 beat grid; a row with any cell on becomes layer on.
  // The legacy arrays hold the six behaviours that existed before v34
  // added Bounce/Stretch/Orbit/Fade/Tremble — they are 6 long, not
  // BEHAVIOURS.length, and the new behaviours never appear in them.
  const LEGACY_BEHAVIOUR_COUNT = 6;
  let active = [false, false, false, false, false, false];
  if (Array.isArray(anyIt.pattern)) {
    const grid = anyIt.pattern as boolean[][];
    active = Array.from({ length: LEGACY_BEHAVIOUR_COUNT }, (_, b) => Array.isArray(grid[b]) && grid[b].some(Boolean));
  } else if (Array.isArray(anyIt.active) && anyIt.active.length === LEGACY_BEHAVIOUR_COUNT) {
    active = (anyIt.active as unknown[]).map((v) => v === true);
  }
  const cycles = (Array.isArray(anyIt.speeds) && anyIt.speeds.length === LEGACY_BEHAVIOUR_COUNT
    ? (anyIt.speeds as unknown[]).map((v) => cycleFromLegacyRate(v)) : [1, 1, 1, 1, 1, 1]);
  const amounts = (Array.isArray(anyIt.amounts) && anyIt.amounts.length === LEGACY_BEHAVIOUR_COUNT
    ? (anyIt.amounts as unknown[]).map((a) => {
        const n = typeof a === "number" ? a : NaN;
        return n === 0.5 ? 33 : n === 1 ? 66 : n === 2 ? 100 : n > 2 ? n : 66;
      }) : [66, 66, 66, 66, 66, 66]);
  const phases = (Array.isArray(anyIt.phases) && anyIt.phases.length === LEGACY_BEHAVIOUR_COUNT
    ? (anyIt.phases as unknown[]).map((p) => (typeof p === "number" && p >= 0 && p <= 100 ? p : 0)) : [0, 0, 0, 0, 0, 0]);
  const blinkDuration = clampNum(anyIt.blinkDuration, 10, 60, 26);
  const spinReverse = anyIt.spinReverse === true;
  const wanderSmooth = clampNum(anyIt.wanderSmooth, 0, 100, 50);
  const paramsOf = (b: number): LayerParams => ({
    on: active[b], cycle: cycles[b], amplitude: amounts[b] / 100, offset: phases[b] / 100,
    easing: "smooth", blinkDuration, spinReverse, wanderSmooth, orbitReverse: false,
  });
  const hasCustom = (b: number): boolean =>
    cycles[b] !== 1 || amounts[b] !== 66 || phases[b] !== 0 ||
    (b === 3 && blinkDuration !== 26) ||
    (b === 4 && spinReverse === true) ||
    (b === 5 && wanderSmooth !== 50);
  // Groups: flat only, a behaviour in at most one group, members valid and
  // ascending. Members are behaviour indices here; they become layer ids below.
  const seen = new Set<number>();
  const oldGroups = (Array.isArray(anyIt.groups) ? anyIt.groups : []).map((raw) => {
    const g = (raw ?? {}) as Partial<BehaviourGroup>;
    const legacy = g as Partial<BehaviourGroup> & { speed?: unknown; amount?: unknown; tempo?: unknown };
    const rawMembers = (Array.isArray(g.members) ? g.members : []) as unknown[];
    const members = rawMembers
      .filter((m): m is number => typeof m === "number" && Number.isInteger(m) && m >= 0 && m < LEGACY_BEHAVIOUR_COUNT && !seen.has(m));
    members.forEach((m) => seen.add(m));
    return {
      id: typeof g.id === "string" && g.id ? g.id : nid(),
      name: behaviourGroupName(g.name),
      members: [...members].sort((a, b) => a - b),
      active: typeof g.active === "boolean" ? g.active : true,
      cycle: typeof g.cycle === "number" ? clampCycle(g.cycle)
        : typeof legacy.tempo === "number" ? cycleFromLegacyRate(legacy.tempo)
        : typeof legacy.speed === "number" ? cycleFromLegacyRate(legacy.speed) : 1,
      amplitude: typeof g.amplitude === "number"
        ? clampNum(g.amplitude, 0, 1, 1)
        : clampNum(legacy.amount, 0, 100, 100) / 100,
    };
  }).filter((g) => g.members.length > 0);
  // The old stack: v10's layers: number[] when present, else the v10 rule
  // (a behaviour is in the stack when it is on or has any non-default
  // parameter). Group members are always in the stack.
  let oldStack: number[];
  if (Array.isArray(anyIt.layers) && (anyIt.layers as unknown[]).every((m) => Number.isInteger(m))) {
    oldStack = [...new Set((anyIt.layers as number[]).filter((m) => m >= 0 && m < LEGACY_BEHAVIOUR_COUNT))];
  } else {
    oldStack = Array.from({ length: LEGACY_BEHAVIOUR_COUNT }, (_, b) => b).filter((b) => active[b] || hasCustom(b));
  }
  const indexToId = new Map<number, string>();
  const layers: BehaviourLayer[] = [];
  const addInstance = (b: number): string => {
    const layer = newLayer(b, paramsOf(b));
    layers.push(layer);
    indexToId.set(b, layer.id);
    return layer.id;
  };
  for (const b of oldStack) addInstance(b);
  for (const g of oldGroups) for (const m of g.members) if (!indexToId.has(m)) addInstance(m);
  it.layers = layers;
  // Behaviours left out of the stack keep their settings in the stash when
  // they are non-default, so re-adding restores them (the v10 promise).
  // Off + fully-default ones need no stash: the defaults restore exactly
  // what re-adding gave in v10.
  const stash: Partial<Record<number, LayerParams>> = {};
  for (let b = 0; b < LEGACY_BEHAVIOUR_COUNT; b++) if (!indexToId.has(b) && hasCustom(b)) stash[b] = paramsOf(b);
  it.stash = stash;
  it.groups = oldGroups.map((g) => ({
    ...g,
    members: g.members.map((m) => indexToId.get(m)).filter((id): id is string => typeof id === "string"),
  })).filter((g) => g.members.length > 0);
  dropLegacy(anyIt);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Geometry
// Text measurement needs a real canvas font, which only the shell has:
// the canvas plugin registers its measurer at boot (the same canvas
// context itemBBox always read, so text widths measure exactly as
// before). Until then, a rough estimate stands in.
let measureTextWidth: (text: string) => number = (text) => text.length * 6;
export function setTextMeasurer(fn: (text: string) => number): void {
  measureTextWidth = fn;
}

// Move an item by a delta: strokes move every point, shapes and
// text move their origin. Pure — no clamping (the drag code clamps
// the union before calling this; Align moves are already in-bounds).
export function moveItem(it: Item, dx: number, dy: number): void {
  if (it.type === "stroke") it.points.forEach((pt) => { pt.x += dx; pt.y += dy; });
  else { it.x += dx; it.y += dy; }
}

export function itemBBox(it: Item): { x: number; y: number; w: number; h: number } {
  if (it.type === "stroke") {
    const xs = it.points.map((p) => p.x);
    const ys = it.points.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { x: x0 - 4, y: y0 - 4, w: Math.max(8, x1 - x0 + 8), h: Math.max(8, y1 - y0 + 8) };
  }
  if (it.type === "shape") return { x: it.x, y: it.y, w: it.w, h: it.h };
  const w = Math.max(20, measureTextWidth(it.text || " ") + 12);
  return { x: it.x, y: it.y - it.size, w, h: it.size + 8 };
}
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}
export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
export function isClosedStroke(it: StrokeItem): boolean {
  if (it.points.length < 3) return false;
  const a = it.points[0], b = it.points[it.points.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1.5;
}
// A shape's outline as a polyline, for erasing: the rectangle's four
// corners (closed), the ellipse approximated with 48 segments (closed).
export function shapeOutline(it: ShapeItem): Pt[] {
  if (it.kind === "rect") {
    const { x, y, w, h } = it;
    return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];
  }
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const rx = Math.abs(it.w) / 2, ry = Math.abs(it.h) / 2;
  const pts: Pt[] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}
// Subdivide every segment longer than `step` so a sparse polyline (a
// two-point leg, a rectangle edge) can be erased in the middle, not
// only at its stored points. Geometry is unchanged: new points lie on
// the original segments.
export function densify(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let s = 1; s <= n; s++) out.push({ x: a.x + (b.x - a.x) * (s / n), y: a.y + (b.y - a.y) * (s / n) });
  }
  return out;
}
// A click selects what the user SEES: items render at their animated
// pose (motion offset, scale and rotation about their own centre), so
// the click is tested against the motion-adjusted geometry, not the
// stored one — at rest the bird sits ~19px from its stored position,
// which is why thin parts (legs, eye) were unclickable where drawn.
// Tolerance is generous (10px around strokes, a padded area around
// small shapes) and when several items are within tolerance the
// nearest wins; ties fall to the topmost item.
export function motionAdjustedPoint(it: Item, p: Pt, t01: number, groups: ItemGroup[]): Pt {
  const m = motionForItem(it, t01, groups);
  const b = itemBBox(it);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  // Inverse of drawItem's translate/rotate/scale about the centre:
  // translate(-(cx+dx, cy+dy)), rotate(-rot), then scale by the
  // per-axis reciprocal. (A uniform scale commutes with rotation, so
  // the old order was free; Stretch's sx/sy does not commute.)
  const x = p.x - m.dx - cx, y = p.y - m.dy - cy;
  const cos = Math.cos(-m.rot), sin = Math.sin(-m.rot);
  const rx = x * cos - y * sin, ry = x * sin + y * cos;
  return { x: rx / (m.scale * m.sx) + cx, y: ry / (m.scale * m.sy) + cy };
}
// The bbox of an item as drawn: the stored bbox carried through the
// item's motion (offset, scale and rotation about its centre). The
// marquee selects what the user sees, so it tests this box.
export function renderedBBox(it: Item, t01: number, groups: ItemGroup[]): { x: number; y: number; w: number; h: number } {
  const b = itemBBox(it);
  const m = motionForItem(it, t01, groups);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const cos = Math.cos(m.rot), sin = Math.sin(m.rot);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]] as const) {
    const dx = (px - cx) * m.scale * m.sx, dy = (py - cy) * m.scale * m.sy;
    const rx = cx + m.dx + dx * cos - dy * sin;
    const ry = cy + m.dy + dx * sin + dy * cos;
    x0 = Math.min(x0, rx); y0 = Math.min(y0, ry); x1 = Math.max(x1, rx); y1 = Math.max(y1, ry);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Distance from q to an item's DRAWN ink (its path or outline), plus
// the tolerance inside which it counts as a hit, plus whether q is
// inside a filled area. Strokes report their PATH distance (pathD);
// shapes and text report their OUTLINE distance (edgeD) — the two are
// different kinds of hit and the caller ranks them in separate tiers.
// A click on the wing's path has a path distance of a few px while the
// body underneath scores 0 for containing the point, so a single
// smallest-distance rule always picked the body; and a click inside
// the beak sits ~4px from the head's outline while ~10px from the
// beak's own, so ranking on outline distance picked the head. Neither
// distance alone is the rule — the tiers in hitTest are.
export function hitDistance(it: Item, q: Pt): { pathD: number; edgeD: number; tol: number; inside: boolean } {
  if (it.type === "stroke") {
    const tol = Math.max(10, it.width + 6);
    let d = Infinity;
    for (let s = 0; s < it.points.length - 1; s++) d = Math.min(d, distToSegment(q, it.points[s], it.points[s + 1]));
    if (it.points.length === 1) d = Math.hypot(q.x - it.points[0].x, q.y - it.points[0].y);
    // A closed stroke (the beak triangle) is a filled area too.
    const inside = isClosedStroke(it) && pointInPolygon(q, it.points);
    return { pathD: d, edgeD: Infinity, tol, inside };
  }
  if (it.type === "shape") {
    const pad = it.width / 2 + 8;
    if (it.kind === "rect") {
      const inside = q.x >= it.x && q.x <= it.x + it.w && q.y >= it.y && q.y <= it.y + it.h;
      const d = inside
        ? Math.min(q.x - it.x, it.x + it.w - q.x, q.y - it.y, it.y + it.h - q.y)
        : Math.hypot(Math.max(it.x - q.x, 0, q.x - (it.x + it.w)), Math.max(it.y - q.y, 0, q.y - (it.y + it.h)));
      return { pathD: Infinity, edgeD: d, tol: pad, inside };
    }
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const rx = Math.abs(it.w) / 2, ry = Math.abs(it.h) / 2;
    const v = rx > 0 && ry > 0 ? ((q.x - cx) ** 2) / (rx * rx) + ((q.y - cy) ** 2) / (ry * ry) : Infinity;
    const inside = v <= 1;
    // Distance to the ellipse's outline, from inside or outside.
    const d = Math.abs(Math.sqrt(v) - 1) * Math.min(rx, ry);
    return { pathD: Infinity, edgeD: d, tol: pad, inside };
  }
  const b = itemBBox(it);
  const inside = q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h;
  const d = inside
    ? Math.min(q.x - b.x, b.x + b.w - q.x, q.y - b.y, b.y + b.h - q.y)
    : Math.hypot(Math.max(b.x - q.x, 0, q.x - (b.x + b.w)), Math.max(b.y - q.y, 0, q.y - (b.y + b.h)));
  return { pathD: Infinity, edgeD: d, tol: 10, inside };
}
// Three tiers, in order. (1) On or near a stroke's ink: a click on the
// wing's path beats the body containing that point, and a click 5px
// from the wing still beats it. A stroke hidden under a filled area
// above it does not count — you cannot click ink you cannot see.
// (2) Inside a filled area: the topmost one wins, so a click in the
// middle of the body (far from any edge) still selects the body, and
// a click deep inside a small filled part (beak, eye) selects it
// rather than the big part whose outline happens to pass nearby.
// (3) Near a shape's outline (just outside it, within tolerance):
// the forgiving padded hit from before.
export function hitTest(items: Item[], p: Pt, t01: number, groups: ItemGroup[]): Item | null {
  const infos = items.map((it, idx) => ({ it, idx, ...hitDistance(it, motionAdjustedPoint(it, p, t01, groups)) }));
  // Topmost first; only a strictly smaller distance replaces the best,
  // so ties (a click on two crossing strokes) fall to the topmost.
  let best: Item | null = null;
  let bestD = Infinity;
  for (let k = infos.length - 1; k >= 0; k--) {
    const inf = infos[k];
    if (inf.it.type !== "stroke" || inf.pathD > inf.tol) continue;
    if (infos.some((o) => o.idx > inf.idx && o.inside)) continue; // hidden under a filled area above it
    if (inf.pathD < bestD - 1e-9) { best = inf.it; bestD = inf.pathD; }
  }
  if (best) return best;
  for (let k = infos.length - 1; k >= 0; k--) if (infos[k].inside) return infos[k].it;
  best = null;
  bestD = Infinity;
  for (let k = infos.length - 1; k >= 0; k--) {
    const inf = infos[k];
    if (inf.edgeD <= inf.tol && inf.edgeD < bestD - 1e-9) { best = inf.it; bestD = inf.edgeD; }
  }
  return best;
}
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const smoothed = new Map<string, number>(); // layer id -> smoothed amplitude 0..1

// Animation
// A behaviour layer is on for the whole loop when toggled on.
// All on layers superpose; amplitude eases in/out so toggling is smooth.
// ---- Behaviour groups ----
// A layer's effective parameters fold in its group's multipliers.
// A member contributes only when both its own toggle and its group's toggle are on.
export function groupOfIn(groups: BehaviourGroup[], layer: BehaviourLayer): BehaviourGroup | undefined {
  return groups.find((g) => g.members.includes(layer.id));
}
export function groupOf(it: Item, layer: BehaviourLayer): BehaviourGroup | undefined {
  return groupOfIn(it.groups, layer);
}
export function effActiveIn(groups: BehaviourGroup[], layer: BehaviourLayer): boolean {
  const g = groupOfIn(groups, layer);
  return layer.on && (!g || g.active);
}
export function effActive(it: Item, layer: BehaviourLayer): boolean {
  return effActiveIn(it.groups, layer);
}
export function effCycleIn(groups: BehaviourGroup[], layer: BehaviourLayer): number {
  const g = groupOfIn(groups, layer);
  return layer.cycle * (g ? g.cycle : 1);
}
export function effCycle(it: Item, layer: BehaviourLayer): number {
  return effCycleIn(it.groups, layer);
}
export function effAmplitudeIn(groups: BehaviourGroup[], layer: BehaviourLayer): number {
  const g = groupOfIn(groups, layer);
  return layer.amplitude * (g ? g.amplitude : 1);
}
export function effAmplitude(it: Item, layer: BehaviourLayer): number {
  return effAmplitudeIn(it.groups, layer);
}
export function amplitudeScale(a: number): number {
  // Amplitudes are fractions (0-1); the 1.8 is the peak scale so a
  // full-amplitude layer reaches 1.8 in graph units and (via 0.08/0.35
  // factors) ~11% max scale and ~0.63 rad max rotation in the motion.
  return a * 1.8;
}
// The loop length is the Loop setting: Cycle N completes N cycles
// in it, so every contributing instance completes a whole number of
// cycles and the pose at the wrap equals the pose at the start. A
// layer's effective cycle count is its own Cycle times its behaviour
// group's Cycle multiplier — both whole numbers, so the product is
// whole too.
export function loopMs(loopLength: LoopLength): number {
  return loopLength * 1000;
}
// Whole number of cycles an instance at this effective cycle count
// completes in one loop. The cycle math uses this, so the pose at the
// wrap equals the pose at the start.
export function loopCycles(cycle: number): number {
  return Math.max(1, Math.round(cycle));
}
export function smoothedAmp(layer: BehaviourLayer, target: number): number {
  const cur = smoothed.get(layer.id) ?? 0;
  let next = cur + (target - cur) * 0.06;
  if (Math.abs(next - target) < 0.002) next = target;
  smoothed.set(layer.id, next);
  return next;
}
export type Motion = { dx: number; dy: number; scale: number; rot: number; opacity: number; sx: number; sy: number };
// Blink pulse: a smooth raised-cosine bump centred where sin(ph) peaks
// (ph = PI/2), spanning `durationPct` % of the cycle at its base. At the
// default 26% the eye is more than half closed for ~13% of the cycle,
// matching the old sin^8 blink.
export function blinkPulse(ph: number, durationPct: number): number {
  const twoPi = Math.PI * 2;
  let d = (ph - Math.PI / 2) / twoPi; // distance from the blink centre, in cycles
  d -= Math.round(d); // wrap to [-0.5, 0.5]
  const w = durationPct / 100;
  if (Math.abs(d) >= w / 2) return 0;
  return 0.5 * (1 + Math.cos((twoPi * d) / w));
}
// Wander jitter amplitude: 50+ is the current smooth summed-sines drift;
// below 50, higher-frequency components creep in, up to 0.9 at 0%.
export function wanderJitterAmp(smooth: number): number {
  return smooth >= 50 ? 0 : ((50 - smooth) / 50) * 0.9;
}
// Wander drift terms, shared by the motion and the graph so the two agree.
// `cycles` is the whole number of cycles the instance completes in one
// loop; every component frequency is an integer multiple of it (1x base,
// 2x/3x jitter), so the pose at the cycle end equals the pose at the
// start. The old 0.5x/0.7x base and 2.3x/3.1x jitter never closed.
export function wanderTerms(layer: BehaviourLayer, cycles: number, t01: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const j = wanderJitterAmp(layer.wanderSmooth);
  if (layer.easing === "smooth") {
    // The old expression exactly, so Wander moves bit-identically on
    // old saves.
    const ph = twoPi * layer.offset;
    return {
      x: Math.sin(twoPi * cycles * t01 + ph) + j * Math.sin(twoPi * 2 * cycles * t01 + 0.4 + ph),
      y: Math.sin(twoPi * cycles * t01 + 1.3 + ph) + j * Math.sin(twoPi * 3 * cycles * t01 + 2.1 + ph),
    };
  }
  // Eased: every term reads the eased cycle position. The jitter is
  // 2x/3x the eased position (minus the offset, as the old expression
  // had it), so it still advances by whole cycles over the loop.
  const pos = easedCyclePos(layer, cycles, t01);
  const off = layer.offset;
  return {
    x: Math.sin(twoPi * pos) + j * Math.sin(twoPi * (2 * pos - off) + 0.4),
    y: Math.sin(twoPi * pos + 1.3) + j * Math.sin(twoPi * (3 * pos - 2 * off) + 2.1),
  };
}
// The instance's position within its own cycle, in cycles, after easing:
// whole cycles advance unwarped (so the pose at the wrap equals the pose
// at the start); only the fractional phase is reshaped.
export function easedCyclePos(layer: BehaviourLayer, cycles: number, t01: number): number {
  const cyc = cycles * t01 + layer.offset;
  const whole = Math.floor(cyc);
  return whole + easePhase(layer.easing, cyc - whole);
}
// The fractional eased phase, for curves read in [0,1) like Bounce's.
export function easedFrac(layer: BehaviourLayer, cycles: number, t01: number): number {
  const pos = easedCyclePos(layer, cycles, t01);
  return pos - Math.floor(pos);
}
// The phase angle for the sine-based behaviours. For Smooth the easing
// is the identity, so this is exactly the old expression — old saves
// and the sample bird move bit-identically.
export function phaseOf(layer: BehaviourLayer, cycles: number, t01: number): number {
  if (layer.easing === "smooth") return Math.PI * 2 * cycles * t01 + Math.PI * 2 * layer.offset;
  return Math.PI * 2 * easedCyclePos(layer, cycles, t01);
}
// Bounce height over one cycle: a parabola peaked mid-cycle — the
// constant-acceleration shape of a ball under gravity. It is 0 at the
// cycle ends (rest on the ground) and the velocity flips there: fast
// fall, sharp rebound. Always >= 0, unlike Bob's sine.
export function bounceCurve(u: number): number {
  return 4 * u * (1 - u);
}
// Fade depth over one cycle: a slow raised-cosine ramp, 0 at the ends
// and 1 mid-cycle — the whole loop is one fade out and back in, where
// Blink's pulse spans only blinkDuration % of the cycle.
export function fadeRamp(ph: number): number {
  return (1 - Math.cos(ph)) / 2;
}
// Tremble jitter, shared by the motion and the graph. Like Wander's
// drift but at higher integer-multiple frequencies (7x/9x base, 11x/13x
// second harmonic) and a much smaller radius, so it reads as a fast
// shiver rather than a slow drift. Every component is an integer
// multiple of the loop, so the pose at the cycle end equals the pose
// at the start.
export function trembleTerms(layer: BehaviourLayer, cycles: number, t01: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const pos = easedCyclePos(layer, cycles, t01);
  return {
    x: Math.sin(twoPi * 7 * pos) + 0.6 * Math.sin(twoPi * 11 * pos + 0.4),
    y: Math.sin(twoPi * 9 * pos + 1.3) + 0.6 * Math.sin(twoPi * 13 * pos + 2.1),
  };
}
// A layer's effective parameters, resolved through a context: an
// item's layers fold in their behaviour group (v9); an item group's
// layers fold in theirs the same way. Motion and graphs read through
// the same context, so the two agree.
export type LayerCtx = {
  cycle: (l: BehaviourLayer) => number;
  amplitude: (l: BehaviourLayer) => number;
  active: (l: BehaviourLayer) => boolean;
};
export function itemCtx(it: Item): LayerCtx {
  return { cycle: (l) => effCycle(it, l), amplitude: (l) => effAmplitude(it, l), active: (l) => effActive(it, l) };
}
export function groupCtx(g: ItemGroup): LayerCtx {
  return { cycle: (l) => effCycleIn(g.groups, l), amplitude: (l) => effAmplitudeIn(g.groups, l), active: (l) => effActiveIn(g.groups, l) };
}
// A behaviour stack lives on an item or on an item group. The panel's
// layer cards work on either, and behaviour groups (v9) exist on either too.
export type LayerHost = { kind: "item"; item: Item } | { kind: "group"; group: ItemGroup };
export function hostLayers(h: LayerHost): BehaviourLayer[] {
  return h.kind === "item" ? h.item.layers : h.group.layers;
}
export function hostGroups(h: LayerHost): BehaviourGroup[] {
  return h.kind === "item" ? h.item.groups : h.group.groups;
}
export function hostCtx(h: LayerHost): LayerCtx {
  return h.kind === "item" ? itemCtx(h.item) : groupCtx(h.group);
}
export function hostFindLayer(h: LayerHost, id: string): BehaviourLayer | undefined {
  return hostLayers(h).find((l) => l.id === id);
}
export function motionForLayers(layers: BehaviourLayer[], ctx: LayerCtx, t01: number): Motion {
  let dx = 0, dy = 0, scale = 1, rot = 0, opacity = 1, sx = 1, sy = 1;
  for (const layer of layers) {
    const a = smoothedAmp(layer, ctx.active(layer) ? 1 : 0);
    if (a < 0.01) continue;
    const cycles = loopCycles(ctx.cycle(layer));
    const am = amplitudeScale(ctx.amplitude(layer));
    const ph = phaseOf(layer, cycles, t01); // Offset shifts the motion within its own cycle; easing reshapes the phase
    if (layer.behaviour === 0) dy += a * am * 16 * Math.sin(ph); // Bob
    if (layer.behaviour === 1) dx += a * am * 16 * Math.sin(ph + Math.PI / 2); // Sway
    if (layer.behaviour === 2) scale += a * am * 0.08 * Math.sin(ph); // Breathe
    if (layer.behaviour === 3) opacity -= a * ctx.amplitude(layer) * blinkPulse(ph, layer.blinkDuration); // Blink: depth is the amplitude (0 = never closes, 1 = fully shut)
    if (layer.behaviour === 4) rot += (layer.spinReverse ? -1 : 1) * a * am * 0.35 * Math.sin(ph); // Spin
    if (layer.behaviour === 5) { const w = wanderTerms(layer, cycles, t01); dx += a * am * 18 * w.x; dy += a * am * 14 * w.y; } // Wander
    if (layer.behaviour === 6) dy -= a * am * 16 * bounceCurve(easedFrac(layer, cycles, t01)); // Bounce: a hop up from rest — fast fall, sharp rebound at the ground
    if (layer.behaviour === 7) { const s = a * am * 0.08 * Math.sin(ph); sx += s; sy -= s; } // Stretch: scaleX and scaleY in opposition (wide+short <-> narrow+tall)
    if (layer.behaviour === 8) { const dir = layer.orbitReverse ? -1 : 1; dx += a * am * 16 * Math.cos(ph); dy += dir * a * am * 16 * Math.sin(ph); } // Orbit: a small circle around the rest position
    if (layer.behaviour === 9) opacity -= a * ctx.amplitude(layer) * fadeRamp(ph); // Fade: slow ramp in and out over the whole loop (depth is the amplitude, like Blink)
    if (layer.behaviour === 10) { const tr = trembleTerms(layer, cycles, t01); dx += a * am * 3 * tr.x; dy += a * am * 2.5 * tr.y; } // Tremble: tiny fast jitter, where Wander is a slow drift
  }
  return { dx, dy, scale, rot, opacity: Math.max(0.05, Math.min(1, opacity)), sx, sy };
}
export function motionFor(it: Item, t01: number): Motion {
  return motionForLayers(it.layers, itemCtx(it), t01);
}
// An item group's own stack, applied to every member.
export function groupMotion(g: ItemGroup, t01: number): Motion {
  return motionForLayers(g.layers, groupCtx(g), t01);
}
// An item's full motion: its own stack superposed with its item
// group's stack (if any). Offsets and rotation add, scale multiplies,
// opacity multiplies (both blink).
export function motionForItem(it: Item, t01: number, groups: ItemGroup[]): Motion {
  const m = motionFor(it, t01);
  const g = groups.find((gr) => gr.memberIds.includes(it.id));
  if (!g) return m;
  const mg = groupMotion(g, t01);
  return {
    dx: m.dx + mg.dx,
    dy: m.dy + mg.dy,
    scale: m.scale * mg.scale,
    sx: m.sx * mg.sx,
    sy: m.sy * mg.sy,
    rot: m.rot + mg.rot,
    opacity: Math.max(0.05, Math.min(1, m.opacity * mg.opacity)),
  };
}
// Motion value of one layer over the loop, for the layer graph.
// Reads the same parameters as motionFor, so the graph and the motion agree.
export function behaviourValue(layer: BehaviourLayer, ctx: LayerCtx, t01: number): number {
  const am = amplitudeScale(ctx.amplitude(layer));
  const cycles = loopCycles(ctx.cycle(layer));
  const ph = phaseOf(layer, cycles, t01);
  if (layer.behaviour === 3) return am * blinkPulse(ph, layer.blinkDuration); // Blink: the widened pulse itself, not a square wave
  if (layer.behaviour === 4) return (layer.spinReverse ? -1 : 1) * am * Math.sin(ph); // Spin: mirrors when reversed
  if (layer.behaviour === 5) { const w = wanderTerms(layer, cycles, t01); return am * (w.x + 0.7 * w.y) / 1.7; } // Wander
  if (layer.behaviour === 6) return am * bounceCurve(easedFrac(layer, cycles, t01)); // Bounce: the hop height (0 at rest, 1 at the apex)
  if (layer.behaviour === 7) return am * Math.sin(ph); // Stretch: the scaleX deviation; scaleY is its mirror
  if (layer.behaviour === 8) { const dir = layer.orbitReverse ? -1 : 1; return am * (Math.cos(ph) + 0.7 * dir * Math.sin(ph)) / 1.7; } // Orbit: mirrors when reversed, like Spin
  if (layer.behaviour === 9) return am * fadeRamp(ph); // Fade: the slow ramp itself
  if (layer.behaviour === 10) { const tr = trembleTerms(layer, cycles, t01); return am * (tr.x + 0.7 * tr.y) / 1.7; } // Tremble
  return am * Math.sin(ph);
}

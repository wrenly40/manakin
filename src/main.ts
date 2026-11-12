import './styles.css';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// The frameless window's controls, exposed by electron/preload.ts.
// Absent when the page runs outside Electron (e.g. vite preview).
type ManakinBridge = {
  platform: string;
  quit: () => Promise<void>;
  minimise: () => Promise<void>;
  maximise: () => Promise<boolean>;
  fullscreen: () => Promise<boolean>;
  windowState: () => Promise<{ maximised: boolean; fullscreen: boolean }>;
  pickSequenceFolder: () => Promise<string | null>;
  writeSequenceFile: (dir: string, name: string, dataUrl: string) => Promise<boolean>;
};
declare global {
  interface Window { manakin?: ManakinBridge; }
}

type Pt = { x: number; y: number };
type BehaviourName = 'Bob' | 'Sway' | 'Breathe' | 'Blink' | 'Spin' | 'Wander' | 'Bounce' | 'Stretch' | 'Orbit' | 'Fade' | 'Tremble';
const BEHAVIOURS: BehaviourName[] = ['Bob', 'Sway', 'Breathe', 'Blink', 'Spin', 'Wander', 'Bounce', 'Stretch', 'Orbit', 'Fade', 'Tremble'];
// Cycle N = the behaviour completes N cycles per loop. The loop
// length is the Loop setting (4/6/8/10s, default 4s): Cycle 1 is one
// cycle per loop, Cycle 10 is ten. A layer's effective cycle count is
// its own Cycle times its behaviour group's Cycle multiplier (both
// whole numbers), so every behaviour completes a whole number of
// cycles in the loop and the pose at the wrap equals the pose at the
// start (see loopMs / loopCycles below).
type LoopLength = 4 | 6 | 8 | 10;
const LOOP_LENGTHS: LoopLength[] = [4, 6, 8, 10];
const DEFAULT_LOOP_LENGTH: LoopLength = 4;
function isLoopLength(v: unknown): v is LoopLength {
  return v === 4 || v === 6 || v === 8 || v === 10;
}
const CYCLE_MIN = 1;
const CYCLE_MAX = 10;
function clampCycle(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(CYCLE_MIN, Math.min(CYCLE_MAX, Math.round(v)));
}
// Old saves stored a stepped rate (0.25/0.5/1/2) under `tempo` (or
// `speed` before that). Map it to a Cycle: 2 -> Cycle 2, anything
// slower -> Cycle 1 — there is no slower-than-one-cycle in the new
// model, so a 0.25/0.5 layer gets faster on load (one cycle per loop).
const LEGACY_RATE_STOPS = [0.25, 0.5, 1, 2];
function cycleFromLegacyRate(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
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
type EasingName = 'smooth' | 'linear' | 'ease-in-out' | 'snap';
const EASING_IDS: EasingName[] = ['smooth', 'linear', 'ease-in-out', 'snap'];
// The picker-visible labels: "Ease In-Out" does not fit the 232px card
// at full size, so it reads "In-Out" (the full name is the button's
// aria-label).
const EASING_LABELS: Record<EasingName, string> = { smooth: 'Smooth', linear: 'Linear', 'ease-in-out': 'In-Out', snap: 'Snap' };
const EASING_ARIA: Record<EasingName, string> = { smooth: 'Easing Smooth', linear: 'Easing Linear', 'ease-in-out': 'Easing Ease In-Out', snap: 'Easing Snap' };
function easePhase(easing: EasingName, u: number): number {
  if (easing === 'linear') {
    // Constant-speed rise and fall (a triangle wave out of the sine):
    // the phase warp whose sine is linear in u. asin() is exact at the
    // joints (u = 0.25 / 0.75), so the warp is continuous.
    if (u < 0.25) return Math.asin(4 * u) / (Math.PI * 2);
    if (u < 0.75) return 0.5 - Math.asin(2 - 4 * u) / (Math.PI * 2);
    return 1 + Math.asin(4 * u - 4) / (Math.PI * 2);
  }
  if (easing === 'ease-in-out') return u * u * (3 - 2 * u); // smoothstep: dwell at the extremes, sweep through the middle
  if (easing === 'snap') return Math.floor(u * 4) / 4; // 4 holds per cycle: hold, then jump
  return u; // smooth
}
// One small icon per behaviour, same 1.8-stroke, 20px, ink language as the
// toolbar icons — each distinct at a glance in the layer stack.
const LAYER_ICONS: string[] = [
  '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M8 7l4-4 4 4"/><path d="M8 17l4 4 4-4"/></svg>', // Bob: vertical double arrow
  '<svg viewBox="0 0 24 24"><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/></svg>', // Sway: horizontal double arrow
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="8"/></svg>', // Breathe: concentric circles
  '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>', // Blink: eye outline with a dot
  '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3v4h-4"/></svg>', // Spin: circular arrow
  '<svg viewBox="0 0 24 24"><path d="M3 16c2.5-5 5 2 7.5-3s5 2 7.5-3" stroke-dasharray="0.5 3.5"/></svg>', // Wander: dotted squiggle
  '<svg viewBox="0 0 24 24"><path d="M5 17c2-6 4-8 7-8s5 2 7 8"/><circle cx="12" cy="18.5" r="2.4" fill="currentColor" stroke="none"/></svg>', // Bounce: hop arc over the ball at rest
  '<svg viewBox="0 0 24 24"><rect x="6" y="10" width="12" height="4" rx="1"/><path d="M12 3v4M12 17v4"/></svg>', // Stretch: wide flat rect, squash arrows
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="20" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>', // Orbit: ring with a dot on it
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" opacity="0.35"/></svg>', // Fade: ring with a faint centre
  '<svg viewBox="0 0 24 24"><path d="M3 12l2.5-4 2.5 8 2.5-10 2.5 12 2.5-10 2.5 8 2.5-4"/></svg>', // Tremble: dense fast zigzag
];
// Z-order icons: stacked squares, same 1.8-stroke ink language —
// the filled square is the one on top (front) or at the back (back);
// forward/backward add a small arrow for the one-step move.
const ARRANGE_ICONS: string[] = [
  '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/></svg>', // Bring to Front
  '<svg viewBox="0 0 24 24"><rect x="4" y="7" width="10" height="10" rx="1.5"/><rect x="10" y="11" width="10" height="10" rx="1.5"/><path d="M12 2v3"/><path d="M10 3.5 12 1.5l2 2"/></svg>', // Bring Forward
  '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="10" height="10" rx="1.5"/><rect x="10" y="7" width="10" height="10" rx="1.5"/><path d="M12 22v-3"/><path d="M10 20.5l2 2 2-2"/></svg>', // Send Backward
  '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/><rect x="9.5" y="9.5" width="11" height="11" rx="1.5"/></svg>', // Send to Back
];
// Align icons: a guide line plus a rectangle — the line is the edge
// the items align to, the rectangle is the item. The rectangles are
// drawn large (10x9 in the 24 box) so they read at the row's 20px size.
const ALIGN_ICONS: string[] = [
  '<svg viewBox="0 0 24 24"><path d="M4 3v18"/><rect x="8" y="7.5" width="10" height="9" rx="1"/></svg>', // Left
  '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><rect x="7" y="7.5" width="10" height="9" rx="1"/></svg>', // Centre
  '<svg viewBox="0 0 24 24"><path d="M20 3v18"/><rect x="6" y="7.5" width="10" height="9" rx="1"/></svg>', // Right
  '<svg viewBox="0 0 24 24"><path d="M3 4h18"/><rect x="7" y="8" width="10" height="9" rx="1"/></svg>', // Top
  '<svg viewBox="0 0 24 24"><path d="M3 12h18"/><rect x="7" y="7.5" width="10" height="9" rx="1"/></svg>', // Middle
  '<svg viewBox="0 0 24 24"><path d="M3 20h18"/><rect x="7" y="7" width="10" height="9" rx="1"/></svg>', // Bottom
];


type BehaviourGroup = {
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
type LayerParams = {
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
type BehaviourLayer = LayerParams & {
  id: string; // unique within the item; never reused
  behaviour: number; // 0-10, index into BEHAVIOURS
};
type ItemBase = {
  id: string;
  color: string;
  width: number;
  layers: BehaviourLayer[]; // ordered behaviour stack, top-to-bottom as shown in the panel; only these are listed and contribute to the motion
  groups: BehaviourGroup[]; // per-item behaviour groups; flat only, no groups in groups
  stash: Partial<Record<number, LayerParams>>; // most recently removed instance's params, keyed by behaviour index, so re-adding restores them
};
type StrokeItem = ItemBase & { type: 'stroke'; points: Pt[] };
type ShapeItem = ItemBase & {
  type: 'shape';
  kind: 'rect' | 'ellipse';
  x: number; y: number; w: number; h: number;
  fillSolid: boolean;
};
type TextItem = ItemBase & { type: 'text'; x: number; y: number; text: string; size: number };
type Item = StrokeItem | ShapeItem | TextItem;

const STAGE_BGS = [
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'paper', label: 'Paper', value: '#f5f0e6' },
  { id: 'sage', label: 'Sage', value: '#dfe8dd' },
  { id: 'sky', label: 'Sky', value: '#dbe9f5' },
  { id: 'ink', label: 'Ink', value: '#1d1d1f' },
] as const;
type StageBgId = (typeof STAGE_BGS)[number]['id'] | 'custom';
// Composition grids for drawing: one overlay style per option, drawn on
// the stage canvas only — never in PNG/WebM exports (renderFrame gates
// the grid on the on-screen canvas). 'grid' is the dots pattern (24px
// step, 2px dots) — the default grid was Off, so Dots, Bowerbird's
// default, is the one drawing grid.
type GridMode = 'empty' | 'grid' | 'thirds' | 'horizon' | 'centre' | 'golden';
function migrateGridMode(v: unknown): GridMode | null {
  if (v === 'empty' || v === 'grid' || v === 'thirds' || v === 'horizon' || v === 'centre' || v === 'golden') return v;
  if (v === 'dots' || v === 'lines') return 'grid'; // old three-way options
  if (v === 'off') return 'empty';
  return null;
}
// Mini previews for the grid tiles: the pattern itself, drawn small.
const GRID_OPTIONS: { id: GridMode; label: string; svg: string }[] = [
  { id: 'empty', label: 'Empty', svg: '<svg viewBox="0 0 40 30" aria-hidden="true"></svg>' },
  { id: 'grid', label: 'Grid', svg: '<svg viewBox="0 0 40 30" aria-hidden="true"><g fill="rgba(29,29,31,0.55)"><circle cx="8" cy="7.5" r="1"/><circle cx="16" cy="7.5" r="1"/><circle cx="24" cy="7.5" r="1"/><circle cx="32" cy="7.5" r="1"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/><circle cx="24" cy="15" r="1"/><circle cx="32" cy="15" r="1"/><circle cx="8" cy="22.5" r="1"/><circle cx="16" cy="22.5" r="1"/><circle cx="24" cy="22.5" r="1"/><circle cx="32" cy="22.5" r="1"/></g></svg>' },
  { id: 'thirds', label: 'Thirds', svg: '<svg viewBox="0 0 40 30" aria-hidden="true"><g stroke="rgba(29,29,31,0.55)" stroke-width="1"><path d="M13.3 2v26M26.7 2v26M2 10h36M2 20h36"/></g></svg>' },
  { id: 'horizon', label: 'Horizon', svg: '<svg viewBox="0 0 40 30" aria-hidden="true"><g stroke="rgba(29,29,31,0.55)" stroke-width="1"><path d="M2 10h36M2 20h36"/></g></svg>' },
  { id: 'centre', label: 'Centre', svg: '<svg viewBox="0 0 40 30" aria-hidden="true"><g stroke="rgba(29,29,31,0.55)" stroke-width="1"><path d="M20 2v26M2 15h36"/></g></svg>' },
  { id: 'golden', label: 'Golden', svg: '<svg viewBox="0 0 40 30" aria-hidden="true"><g stroke="rgba(29,29,31,0.55)" stroke-width="1"><path d="M15.3 2v26M24.7 2v26M2 11.5h36M2 18.5h36"/></g></svg>' },
];
const STAGES = [
  { id: 'wide', label: '16:9', w: 960, h: 540 },
  { id: 'square', label: 'Square', w: 720, h: 720 },
  { id: 'portrait', label: 'Portrait', w: 540, h: 960 },
] as const;

const SAVE_KEY = 'manakin-v1';
let uid = 0;
function nid(): string {
  uid += 1;
  return `i${Date.now().toString(36)}${uid}`;
}
function defaultLayerParams(): LayerParams {
  return { on: true, cycle: 1, amplitude: 0.66, offset: 0, easing: 'smooth', blinkDuration: 26, spinReverse: false, wanderSmooth: 50, orbitReverse: false };
}
// The default blink duration of 26% is a raised-cosine bump whose
// half-depth width (13%) matches the old sin^8 blink.
function newLayer(b: number, params?: Partial<LayerParams>): BehaviourLayer {
  return { id: nid(), behaviour: b, ...defaultLayerParams(), ...params };
}
function baseItem(color: string, width: number): ItemBase {
  return { id: nid(), color, width, layers: [], groups: [], stash: {} };
}

// ---------- state ----------
let items: Item[] = [];
// Item groups: containers of canvas items with their own behaviour
// layers — distinct from BehaviourGroup (v9, per-item collections of
// behaviour layers). Flat only, no nesting, no groups in groups.
type ItemGroup = {
  id: string;
  memberIds: string[]; // item ids; a group has at least 2 members
  layers: BehaviourLayer[]; // the group's own behaviour stack, applied to every member
  groups: BehaviourGroup[]; // behaviour groups on the group's stack, like an item's
};
let itemGroups: ItemGroup[] = [];
// Ordered selection; empty = nothing selected. A click on a group
// member selects the whole group; shift-click toggles one item.
let selectedIds: string[] = [];
function selectedItems(): Item[] {
  return selectedIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);
}
// The single selected item, or null for a multi-selection / none.
// Single-item call sites (delete, text edit, behaviour panel) use this.
function selected(): Item | null {
  const s = selectedItems();
  return s.length === 1 ? s[0] : null;
}
// The item group whose members are exactly the selection, if any.
function selectedItemGroup(): ItemGroup | null {
  if (selectedIds.length < 2) return null;
  const set = new Set(selectedIds);
  return itemGroups.find((g) => g.memberIds.length === set.size && g.memberIds.every((m) => set.has(m))) ?? null;
}
function itemGroupOf(itemId: string): ItemGroup | undefined {
  return itemGroups.find((g) => g.memberIds.includes(itemId));
}
// An item leaving the document leaves its item groups too; a group
// left with fewer than 2 members dissolves and its layers are deleted.
function pruneItemGroups(): void {
  for (const g of itemGroups) g.memberIds = [...new Set(g.memberIds.filter((m) => items.some((i) => i.id === m)))];
  itemGroups = itemGroups.filter((g) => g.memberIds.length >= 2);
}
// Double-click focus (view state only — never saved, never an undo entry):
// the focused part renders full, every other part at 0.1.
let focusedId: string | null = null;
// Double-click pair tracking: the second press of a pair must not fire
// paint or open the text editor a second time.
let lastDown: { t: number; x: number; y: number } | null = null;
let lastPressRepeat = false;
type ToolId = 'select' | 'brush' | 'eraser' | 'shape' | 'text' | 'paint';
let tool: ToolId = 'brush';
let color = '#1d1d1f'; // foreground
let bgColour = '#007aff'; // background (secondary swatch)
let activeSlot: 'fg' | 'bg' = 'fg';
let penWidth = 4;
let shapeKind: 'rect' | 'ellipse' = 'rect';
let stageId: 'wide' | 'square' | 'portrait' = 'wide';
let loopLength: LoopLength = DEFAULT_LOOP_LENGTH; // seconds per loop; 4s default
let stageBgId: StageBgId = 'white';
let stageBgCustom: string | null = null;
let gridMode: GridMode = 'empty';
let projectName = 'Untitled';
let panelOpen = true;
let exporting = false; // an export (PNG sequence or video) is running right now
let exportTab: 'png' | 'video' = 'png'; // the active tab in the Export card, persisted like videoFormat
let exportProgress: { text: string; target: 'png' | 'video' } | null = null;
// "Exporting 45/120" while an offline export runs, on the button doing it.
function setExportProgress(text: string, target: 'png' | 'video'): void {
  exportProgress = { text, target };
  const b = document.getElementById(target === 'png' ? 'export-png-btn' : 'export-video-btn');
  if (b) b.textContent = text;
}
type VideoFormat = 'gif' | 'webm' | 'mp4';
let videoFormat: VideoFormat = 'webm'; // video export format, persisted like panelOpen
let panelView: 'auto' | 'colour' = 'auto';
let colourSlot: 'fg' | 'bg' = 'fg';
let expandedLayerId: string | null = null;
let expandedGroup: string | null = null; // id of the open group in the Behaviours panel
let addPickerOpen = false; // the inline Add behavior list is showing
let exportDropdownOpen = false; // the Export dropdown (card in a popover) is showing
let checkedLayers: Set<string> = new Set(); // top-level layer ids picked for grouping
let checkedHostId: string | null = null; // the host (item or item group) the checked rows belong to
let recentColours: string[] = [];
let savedColours: string[] = [];
// Hue 0 and 360 are the same red, but the hue bar's two ends are not:
// dragging to the right end must leave the thumb there, not jump it to
// the left when the panel rebuilds from the hex (which reads hue 0).
let colourHue360 = false;
let playing = false;
let playTime = 0; // ms within the loop, frozen when paused
let lastTs = 0;
// Zoom is view state only: not in the undo snapshot, not saved, resets
// to 100% on reload. It scales the workspace view (stage + pasteboard
// around the workspace centre) — never the stage size, never exports:
// offscreen export targets render at s=1 regardless.
const ZOOM_STOPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
let zoom = 1;
// Pan is view state only, like zoom: not in the undo snapshot, not
// saved, resets to 0 on reload. It shifts the stage origin in
// workspace pixels, on top of the centred fit × zoom.
let panX = 0;
let panY = 0;
let panDrag: { x: number; y: number; panX: number; panY: number } | null = null;
let spaceHeld = false;
// Rotation is view state only, like zoom and pan: not in the undo
// snapshot, not saved, resets to 0 on reload. It rotates the whole
// workspace view around the centre of the visible workspace —
// never the artwork, never exports.
let rotateDeg = 0; // degrees, kept normalised to [0, 360)
let rotateDrag: { startAngle: number; startDeg: number } | null = null;
let rotateHeld = false;
function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}
const PAN_MARGIN = 80; // px of the stage kept visible in the workspace
// Clamp the pan so the stage can never be dragged entirely out of
// view. When the stage fits the workspace it stays fully inside;
// when it is bigger, at least PAN_MARGIN px of it stays visible on
// each side. Called after every zoom, wheel and drag change, and on
// resize (a smaller window re-clamps the same pan).
function clampAxis(pan: number, base: number, size: number, view: number): number {
  if (size <= view) return Math.max(-base, Math.min(view - size - base, pan));
  return Math.max(PAN_MARGIN - size - base, Math.min(view - PAN_MARGIN - base, pan));
}
function clampPan(): void {
  const cw = stageWrap.clientWidth, ch = stageWrap.clientHeight;
  const { w, h } = stageSize();
  const fit = Math.min(1, cw / w, ch / h) || 1;
  const s = fit * zoom;
  panX = clampAxis(panX, (cw - w * s) / 2, w * s, cw);
  panY = clampAxis(panY, (ch - h * s) / 2, h * s, ch);
}
function updateZoomLabel(): void {
  const el = document.getElementById('zoom-label');
  if (!el) return;
  // While rotated, the angle shows next to the zoom; at 0° nothing
  // extra. The rounded angle wraps (359.6° reads as 0°, not 360°).
  const d = Math.round(rotateDeg) % 360;
  el.textContent = d === 0 ? `${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}% · ${d}°`;
}
function setZoom(z: number): void {
  zoom = z;
  clampPan(); // zoom keeps the current pan, clamped to the new zoom
  updateZoomLabel();
}
// Zoom reset also re-centres the view: 100%, no pan, no rotation.
function resetView(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
  rotateDeg = 0;
  updateZoomLabel();
}
function zoomStep(dir: 1 | -1): void {
  const i = ZOOM_STOPS.indexOf(zoom);
  if (i === -1) { setZoom(dir === 1 ? (ZOOM_STOPS.find((s) => s > zoom) ?? 4) : ([...ZOOM_STOPS].reverse().find((s) => s < zoom) ?? 0.25)); return; }
  setZoom(ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, i + dir))]);
}
let history: string[] = [];
let redoStack: string[] = [];
const smoothed = new Map<string, number>(); // layer id -> smoothed amplitude 0..1

function stageSize(): { w: number; h: number } {
  const s = STAGES.find((s) => s.id === stageId) ?? STAGES[0];
  return { w: s.w, h: s.h };
}
function stageBgValue(): string {
  if (stageBgId === 'custom' && stageBgCustom) return stageBgCustom;
  return STAGE_BGS.find((b) => b.id === stageBgId)?.value ?? '#ffffff';
}
function slotColour(): string { return activeSlot === 'fg' ? color : bgColour; }
function setSlotColour(hex: string): void {
  if (activeSlot === 'fg') color = hex; else bgColour = hex;
}
function pushRecent(hex: string): void {
  const h = hex.toLowerCase();
  recentColours = [h, ...recentColours.filter((c) => c !== h)].slice(0, 8);
}
function save(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      items, itemGroups, stageId, loopLength, projectName, stageBgId, stageBgCustom, gridMode, panelOpen,
      fg: color, bg: bgColour, penWidth, recent: recentColours, saved: savedColours,
      videoFormat, exportTab,
    }));
  } catch { /* storage full or unavailable */ }
}
function snapshot(): string {
  // The whole document state: items, item groups, stage size,
  // loop length, background and grid. Tool settings (pen width,
  // colours, project name) are not document state and stay out of undo.
  return JSON.stringify({ items, itemGroups, stageId, loopLength, stageBgId, stageBgCustom, gridMode });
}
function pushHistory(): void {
  history.push(snapshot());
  if (history.length > 50) history.shift();
  redoStack = [];
  syncUndoButtons();
}
// The top-bar Undo/Redo buttons are only re-rendered by renderPanel(),
// so a history change that does not re-render the panel (e.g. a slider
// drag) would leave them stuck in their old disabled state. Keep them in
// sync at the only two places entries are added.
function syncUndoButtons(): void {
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = history.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}
// A history entry must capture the state BEFORE the mutation, exactly
// once per gesture. For gestures that may change nothing — a click
// without moving, a sweep over empty space — capture the pre-state when
// the gesture starts and commit it only if something actually changed,
// so those gestures add no entry at all.
function gestureStart(): string {
  return snapshot();
}
function gestureCommit(before: string, changed: boolean): void {
  if (!changed) return;
  history.push(before);
  if (history.length > 50) history.shift();
  redoStack = [];
  syncUndoButtons();
}
function restore(json: string): void {
  try {
    const data = JSON.parse(json) as unknown;
    if (Array.isArray(data)) {
      items = data as Item[];
      itemGroups = [];
    } else if (data && typeof data === 'object') {
      const d = data as {
        items?: Item[]; itemGroups?: unknown; stageId?: typeof stageId; stageBgId?: StageBgId;
        stageBgCustom?: string | null; gridMode?: unknown; loopLength?: unknown;
      };
      if (Array.isArray(d.items)) items = d.items;
      itemGroups = migrateItemGroups(d.itemGroups);
      if (d.stageId === 'wide' || d.stageId === 'square' || d.stageId === 'portrait') stageId = d.stageId;
      if (isLoopLength(d.loopLength)) loopLength = d.loopLength;
      if (d.stageBgId) stageBgId = d.stageBgId;
      stageBgCustom = typeof d.stageBgCustom === 'string' ? d.stageBgCustom : null;
      const gm = migrateGridMode(d.gridMode);
      if (gm !== null) gridMode = gm;
    }
  } catch { /* corrupted history entry: keep current items */ }
  items.forEach(migrateItem); // undo snapshots from older saves may lack the newer parameter fields
  pruneItemGroups();
  selectedIds = selectedIds.filter((id) => items.some((i) => i.id === id));
  // Keep the eased amplitudes of layers that still exist: clearing them
  // restarts every behaviour from 0, so after an undo the pose visibly
  // snaps and re-eases over ~1s even while paused. Only entries whose
  // layer is gone are dropped — a layer id is never reused, so a
  // dropped entry is never read again.
  const liveLayerIds = new Set<string>();
  for (const it of items) for (const l of it.layers) liveLayerIds.add(l.id);
  for (const g of itemGroups) for (const l of g.layers) liveLayerIds.add(l.id);
  for (const id of [...smoothed.keys()]) if (!liveLayerIds.has(id)) smoothed.delete(id);
  // A restored snapshot may carry a shorter loop than the current
  // playhead (e.g. undoing a 10s → 4s change while paused at 9s);
  // keep the playhead inside the loop.
  playTime = playTime % loopMs();
  save();
  resizeCanvas();
  renderPanel();
}
function undo(): void {
  const prev = history.pop();
  if (!prev) return;
  redoStack.push(snapshot());
  restore(prev);
}
function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  history.push(snapshot());
  restore(next);
}

// ---------- colour helpers ----------
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
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
function normHex(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^[0-9a-f]{6}$/.test(t)) return `#${t}`;
  if (/^#[0-9a-f]{3}$/.test(t)) {
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  }
  return null;
}

// ---------- sample ----------
function sampleBird(): Item[] {
  // Bob, Sway, Breathe, Blink on; Spin, Wander off.
  const act = [true, true, true, true, false, false];
  const withAct = (it: Item): Item => {
    // The bird's Blink runs at amplitude 0.85, the depth the motion used
    // to hard-code, so the sample bird blinks exactly as before.
    it.layers = act.map((on, b) => (on ? newLayer(b, b === 3 ? { amplitude: 0.85 } : undefined) : null)).filter((l): l is BehaviourLayer => l !== null);
    return it;
  };
  const body: ShapeItem = { ...baseItem('#1d1d1f', 4), type: 'shape', kind: 'ellipse', x: 370, y: 230, w: 220, h: 150, fillSolid: false };
  const head: ShapeItem = { ...baseItem('#1d1d1f', 4), type: 'shape', kind: 'ellipse', x: 545, y: 175, w: 95, h: 95, fillSolid: false };
  const eye: ShapeItem = { ...baseItem('#1d1d1f', 2), type: 'shape', kind: 'ellipse', x: 578, y: 208, w: 14, h: 14, fillSolid: true };
  const beak: StrokeItem = { ...baseItem('#d2592d', 4), type: 'stroke', points: [{ x: 632, y: 208 }, { x: 668, y: 224 }, { x: 632, y: 240 }, { x: 632, y: 208 }] };
  const wing: StrokeItem = { ...baseItem('#007aff', 4), type: 'stroke', points: [{ x: 430, y: 285 }, { x: 480, y: 325 }, { x: 535, y: 288 }] };
  const leg1: StrokeItem = { ...baseItem('#1d1d1f', 4), type: 'stroke', points: [{ x: 450, y: 380 }, { x: 450, y: 415 }] };
  const leg2: StrokeItem = { ...baseItem('#1d1d1f', 4), type: 'stroke', points: [{ x: 510, y: 380 }, { x: 510, y: 415 }] };
  return [body, head, eye, beak, wing, leg1, leg2].map(withAct);
}

// The per-behaviour parameter arrays are retired: after migration an item
// carries only layer instances (plus the stash). Drop the legacy fields so
// saved JSON stays clean.
function dropLegacy(anyIt: Record<string, unknown>): void {
  delete anyIt.pattern;
  delete anyIt.active;
  delete anyIt.speeds;
  delete anyIt.amounts;
  delete anyIt.phases;
  delete anyIt.blinkDuration;
  delete anyIt.spinReverse;
  delete anyIt.wanderSmooth;
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : dflt;
}
// Merge saved params with the current defaults, clamping them. Migration
// is keyed on FIELD PRESENCE: an old save stores percents under `amount`
// (66 = 66%) and `phase` (50 = half a loop) and a stepped rate under
// `tempo`/`speed`, while a new save stores fractions under
// `amplitude`/`offset` and an integer `cycle` — so an old amount of 1 (1%)
// and a new amplitude of 1 (full) are told apart by the field name, never
// by the value.
function cleanParams(p: Partial<LayerParams>): LayerParams {
  const legacy = p as Partial<LayerParams> & { amount?: unknown; phase?: unknown; speed?: unknown; tempo?: unknown };
  return {
    on: typeof p.on === 'boolean' ? p.on : true,
    cycle: typeof p.cycle === 'number' ? clampCycle(p.cycle)
      : typeof legacy.tempo === 'number' ? cycleFromLegacyRate(legacy.tempo)
      : typeof legacy.speed === 'number' ? cycleFromLegacyRate(legacy.speed) : 1,
    amplitude: typeof p.amplitude === 'number'
      ? clampNum(p.amplitude, 0, 1, 0.66)
      : clampNum(legacy.amount, 0, 100, 66) / 100,
    offset: typeof p.offset === 'number'
      ? clampNum(p.offset, 0, 1, 0)
      : clampNum(legacy.phase, 0, 100, 0) / 100,
    easing: typeof p.easing === 'string' && (EASING_IDS as string[]).includes(p.easing) ? p.easing as EasingName : 'smooth',
    blinkDuration: clampNum(p.blinkDuration, 10, 60, 26),
    spinReverse: p.spinReverse === true,
    wanderSmooth: clampNum(p.wanderSmooth, 0, 100, 50),
    orbitReverse: p.orbitReverse === true,
  };
}
// Validate a saved layer stack in place: drop layers with a bad
// behaviour index, give missing/duplicate ids fresh ones, clean params.
function cleanLayerArray(raw: unknown): BehaviourLayer[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const clean: BehaviourLayer[] = [];
  for (const r of raw as unknown[]) {
    const l = (r ?? {}) as Partial<BehaviourLayer>;
    if (typeof l.behaviour !== 'number' || !Number.isInteger(l.behaviour) || l.behaviour < 0 || l.behaviour >= BEHAVIOURS.length) continue;
    let id = typeof l.id === 'string' && l.id ? l.id : nid();
    if (seenIds.has(id)) id = nid();
    seenIds.add(id);
    clean.push({ id, behaviour: l.behaviour, ...cleanParams(l) });
  }
  return clean;
}
// An item group survives a load only when at least 2 of its members
// still exist; its layers are cleaned like an item's stack.
function migrateItemGroup(raw: unknown): ItemGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Partial<ItemGroup>;
  const memberIds = (Array.isArray(g.memberIds) ? g.memberIds : [])
    .filter((m): m is string => typeof m === 'string' && items.some((i) => i.id === m));
  const unique = [...new Set(memberIds)];
  if (unique.length < 2) return null;
  const layers = cleanLayerArray(g.layers);
  const ids = new Set(layers.map((l) => l.id));
  const seenMember = new Set<string>();
  const groups = (Array.isArray(g.groups) ? g.groups : []).map((r) => {
    const bg = (r ?? {}) as Partial<BehaviourGroup>;
    const legacyBg = bg as Partial<BehaviourGroup> & { tempo?: unknown; speed?: unknown };
    const members = (Array.isArray(bg.members) ? bg.members : [])
      .filter((m): m is string => typeof m === 'string' && ids.has(m) && !seenMember.has(m));
    members.forEach((m) => seenMember.add(m));
    if (members.length === 0) return null;
    return {
      id: typeof bg.id === 'string' && bg.id ? bg.id : nid(),
      name: behaviourGroupName(bg.name),
      members: [...new Set(members)],
      active: typeof bg.active === 'boolean' ? bg.active : true,
      cycle: typeof bg.cycle === 'number' ? clampCycle(bg.cycle)
        : typeof legacyBg.tempo === 'number' ? cycleFromLegacyRate(legacyBg.tempo)
        : typeof legacyBg.speed === 'number' ? cycleFromLegacyRate(legacyBg.speed) : 1,
      amplitude: typeof bg.amplitude === 'number' ? clampNum(bg.amplitude, 0, 1, 1) : 1,
    };
  }).filter((x): x is BehaviourGroup => x !== null);
  return {
    id: typeof g.id === 'string' && g.id ? g.id : nid(),
    memberIds: unique,
    layers,
    groups,
  };
}
function migrateItemGroups(raw: unknown): ItemGroup[] {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const out: ItemGroup[] = [];
  for (const r of raw as unknown[]) {
    const g = migrateItemGroup(r);
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
function behaviourGroupName(raw: unknown): string {
  const name = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  const m = /^Group (\d+)$/.exec(name);
  if (m) return `Layer Group ${m[1]}`;
  return name || 'Layer Group';
}

function migrateItem(it: Item): void {
  const anyIt = it as unknown as Record<string, unknown>;
  // New format: layers are instances with ids (an empty array is a valid
  // empty stack). Just validate, in place.
  const layersAreInstances = Array.isArray(it.layers) &&
    (it.layers.length === 0 || (typeof it.layers[0] === 'object' && it.layers[0] !== null));
  if (layersAreInstances) {
    it.layers = cleanLayerArray(it.layers);
    const ids = new Set(it.layers.map((l) => l.id));
    const seenMember = new Set<string>();
    it.groups = (Array.isArray(it.groups) ? it.groups : []).map((raw) => {
      const g = (raw ?? {}) as Partial<BehaviourGroup>;
      const legacy = g as Partial<BehaviourGroup> & { speed?: unknown; amount?: unknown; tempo?: unknown };
      const members = (Array.isArray(g.members) ? g.members : [])
        .filter((m): m is string => typeof m === 'string' && ids.has(m) && !seenMember.has(m));
      members.forEach((m) => seenMember.add(m));
      if (members.length === 0) return null;
      return {
        id: typeof g.id === 'string' && g.id ? g.id : nid(),
        name: behaviourGroupName(g.name),
        members: [...new Set(members)],
        active: typeof g.active === 'boolean' ? g.active : true,
        cycle: typeof g.cycle === 'number' ? clampCycle(g.cycle)
          : typeof legacy.tempo === 'number' ? cycleFromLegacyRate(legacy.tempo)
          : typeof legacy.speed === 'number' ? cycleFromLegacyRate(legacy.speed) : 1,
        amplitude: typeof g.amplitude === 'number'
          ? clampNum(g.amplitude, 0, 1, 1)
          : clampNum(legacy.amount, 0, 100, 100) / 100,
      };
    }).filter((g): g is BehaviourGroup => g !== null);
    if (!it.stash || typeof it.stash !== 'object' || Array.isArray(it.stash)) {
      it.stash = {};
    } else {
      const cleanStash: Partial<Record<number, LayerParams>> = {};
      for (const [k, v] of Object.entries(it.stash)) {
        const b = Number(k);
        if (!Number.isInteger(b) || b < 0 || b >= BEHAVIOURS.length || !v || typeof v !== 'object') continue;
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
        const n = typeof a === 'number' ? a : NaN;
        return n === 0.5 ? 33 : n === 1 ? 66 : n === 2 ? 100 : n > 2 ? n : 66;
      }) : [66, 66, 66, 66, 66, 66]);
  const phases = (Array.isArray(anyIt.phases) && anyIt.phases.length === LEGACY_BEHAVIOUR_COUNT
    ? (anyIt.phases as unknown[]).map((p) => (typeof p === 'number' && p >= 0 && p <= 100 ? p : 0)) : [0, 0, 0, 0, 0, 0]);
  const blinkDuration = clampNum(anyIt.blinkDuration, 10, 60, 26);
  const spinReverse = anyIt.spinReverse === true;
  const wanderSmooth = clampNum(anyIt.wanderSmooth, 0, 100, 50);
  const paramsOf = (b: number): LayerParams => ({
    on: active[b], cycle: cycles[b], amplitude: amounts[b] / 100, offset: phases[b] / 100,
    easing: 'smooth', blinkDuration, spinReverse, wanderSmooth, orbitReverse: false,
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
      .filter((m): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 0 && m < LEGACY_BEHAVIOUR_COUNT && !seen.has(m));
    members.forEach((m) => seen.add(m));
    return {
      id: typeof g.id === 'string' && g.id ? g.id : nid(),
      name: behaviourGroupName(g.name),
      members: [...members].sort((a, b) => a - b),
      active: typeof g.active === 'boolean' ? g.active : true,
      cycle: typeof g.cycle === 'number' ? clampCycle(g.cycle)
        : typeof legacy.tempo === 'number' ? cycleFromLegacyRate(legacy.tempo)
        : typeof legacy.speed === 'number' ? cycleFromLegacyRate(legacy.speed) : 1,
      amplitude: typeof g.amplitude === 'number'
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
    members: g.members.map((m) => indexToId.get(m)).filter((id): id is string => typeof id === 'string'),
  })).filter((g) => g.members.length > 0);
  dropLegacy(anyIt);
}

function load(): void {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as {
        items: Item[]; itemGroups?: unknown; stageId: typeof stageId; projectName?: string;
        stageBgId?: StageBgId; stageBgCustom?: string | null; gridMode?: unknown; panelOpen?: boolean;
        fg?: string; bg?: string; penWidth?: number; recent?: string[]; saved?: string[];
        videoFormat?: unknown; exportTab?: unknown; loopLength?: unknown;
      };
      if (Array.isArray(data.items) && data.items.length > 0) {
        items = data.items;
        items.forEach(migrateItem);
        itemGroups = migrateItemGroups(data.itemGroups);
        if (data.stageId) stageId = data.stageId;
        // Old saves carry no loopLength: they load at the 4s default.
        if (isLoopLength(data.loopLength)) loopLength = data.loopLength;
        if (typeof data.projectName === 'string' && data.projectName.trim()) projectName = data.projectName;
        if (data.stageBgId && (STAGE_BGS.some((b) => b.id === data.stageBgId) || data.stageBgId === 'custom')) stageBgId = data.stageBgId;
        if (typeof data.stageBgCustom === 'string') stageBgCustom = data.stageBgCustom;
        const gm = migrateGridMode(data.gridMode);
        if (gm !== null) gridMode = gm;
        if (data.videoFormat === 'gif' || data.videoFormat === 'webm' || data.videoFormat === 'mp4') videoFormat = data.videoFormat;
        if (data.exportTab === 'png' || data.exportTab === 'video') exportTab = data.exportTab;
        if (typeof data.panelOpen === 'boolean') panelOpen = data.panelOpen;
        if (typeof data.fg === 'string') color = data.fg;
        if (typeof data.bg === 'string') bgColour = data.bg;
        if (typeof data.penWidth === 'number' && data.penWidth >= 2 && data.penWidth <= 32) penWidth = data.penWidth;
        if (Array.isArray(data.recent)) recentColours = data.recent.filter((c) => typeof c === 'string').slice(0, 8);
        if (Array.isArray(data.saved)) savedColours = data.saved.filter((c) => typeof c === 'string');
        return;
      }
    }
  } catch { /* corrupted save: fall through to sample */ }
  items = sampleBird();
  // The sample bird already carries new-format layer instances; migrate
  // only validates them (and drops any legacy fields).
  items.forEach(migrateItem);
  save();
}

// ---------- DOM ----------
// Layout (Bowerbird-style): the panel is full window height —
// body is a flex row of the main column (top bar + centre + player)
// and the panel. The top bar ends at the panel's left edge.
const app = document.getElementById('app')!;
app.innerHTML = `
<div id="app-row">
  <div id="main-column">
    <header>
      <div id="window-controls" aria-label="Window controls">
        <button id="win-close" class="win-close" title="Close" aria-label="Close"><svg class="icon-mac" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" /></svg><svg class="icon-os" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg></button>
        <button id="win-minimise" class="win-minimise" title="Minimise" aria-label="Minimise"><svg class="icon-mac" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" /></svg><svg class="icon-os" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h10" /></svg></button>
        <button id="win-fullscreen" class="win-fullscreen" title="Full screen" aria-label="Full screen"><svg class="icon-enter" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 7.5L7.5 2.5M5.5 2.5H7.5V4.5M4.5 7.5H2.5V5.5" /></svg><svg class="icon-exit" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5L7.5 7.5M5.5 7.5H7.5V5.5M4.5 2.5H2.5V4.5" /></svg></button>
        <button id="win-maximise" class="win-maximise" title="Maximise" aria-label="Maximise"><svg class="icon-maximise" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" /></svg><svg class="icon-restore" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7H6z" /><path d="M3 6h7v7H3z" fill="#fff" /></svg></button>
      </div>
      <div class="header-left">
        <h1>Manakin</h1>
        <input id="project-name" value="Untitled" aria-label="Project name" spellcheck="false" />
      </div>
      <div class="header-actions">
        <button class="hbtn" id="undo-btn" title="Undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
        <button class="hbtn" id="redo-btn" title="Redo" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
        <span class="vdiv"></span>
        <button class="hbtn" id="panel-btn" title="Panel" aria-label="Toggle panel"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>
      </div>
    </header>
    <div id="main-row">
      <div id="toolbar" role="toolbar" aria-label="Tools"></div>
      <div id="stage-area">
        <div id="stage-wrap">
          <canvas id="stage"></canvas>
          <textarea id="text-editor" rows="1" aria-label="Text"></textarea>
        </div>
      </div>
    </div>
    <footer id="player">
      <div id="player-row">
        <button id="back-btn" class="pctl solid" title="Back" aria-label="Back to start"><svg viewBox="0 0 24 24"><path d="M6 5h2.5v14H6z"/><path d="M20 5v14l-9.5-7z"/></svg></button>
        <button id="play-btn" class="pctl" title="Play" aria-label="Play"><svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg></button>
        <button id="stop-btn" class="pctl solid" title="Stop" aria-label="Stop"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
        <button id="forward-btn" class="pctl solid" title="Forward" aria-label="Forward to end"><svg viewBox="0 0 24 24"><path d="M15.5 5h2.5v14h-2.5z"/><path d="M4 5v14l9.5-7z"/></svg></button>
      </div>
      <div id="timeline-row">
        <div id="progress-track" aria-hidden="true"><div id="progress-fill"></div></div>
        <span id="time-state">0.0 / 4.0s</span>
      </div>
      <div id="zoom-control" aria-label="Zoom">
        <button id="zoom-out" class="zbtn" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
        <button id="zoom-label" class="zoom-label" title="Reset zoom, pan and rotation to 100%" aria-label="Zoom level, activate to reset the view to 100%">100%</button>
        <button id="zoom-in" class="zbtn" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
    </footer>
  </div>
  <aside id="panel" aria-label="Panel">
    <div id="panel-head">
      <h2 id="panel-title">Canvas</h2>
    </div>
    <div id="panel-body"></div>
  </aside>
</div>`;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const stageWrap = document.getElementById('stage-wrap')!;
const textEditor = document.getElementById('text-editor') as HTMLTextAreaElement;
const panelEl = document.getElementById('panel')!;
const panelTitle = document.getElementById('panel-title')!;
const panelBody = document.getElementById('panel-body')!;
const timeState = document.getElementById('time-state')!;
const progressFill = document.getElementById('progress-fill')!;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const forwardBtn = document.getElementById('forward-btn') as HTMLButtonElement;
const projectInput = document.getElementById('project-name') as HTMLInputElement;
const panelBtn = document.getElementById('panel-btn') as HTMLButtonElement;

function applyPanelOpen(): void {
  panelEl.style.display = panelOpen ? 'flex' : 'none';
  panelBtn.classList.toggle('active', panelOpen);
  requestAnimationFrame(() => resizeCanvas());
}
panelBtn.addEventListener('click', () => {
  panelOpen = !panelOpen;
  save();
  applyPanelOpen();
});
projectInput.addEventListener('change', () => {
  const v = projectInput.value.trim();
  projectName = v || 'Untitled';
  projectInput.value = projectName;
  save();
});
projectInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') projectInput.blur();
});

// ---------- window controls ----------
// The window is frameless, like Bowerbird: the app draws what the OS
// would draw — macOS traffic lights at the far left, Windows caption
// buttons / GNOME round buttons at the far right on other platforms
// (same four buttons; the platform CSS moves and restyles them).
// Close quits the app; minimise minimises; the green light toggles
// full screen on macOS, maximise toggles maximise on Windows/Linux.
// Double-clicking the drag region (not on a button or input) toggles
// maximise, as a native title bar would.
const headerEl = document.querySelector('header')!;
const winControls = document.getElementById('window-controls')!;
const winFullscreenBtn = document.getElementById('win-fullscreen') as HTMLButtonElement;
const winMaximiseBtn = document.getElementById('win-maximise') as HTMLButtonElement;
const osPlatform = ((): 'darwin' | 'win32' | 'linux' => {
  const p = window.manakin?.platform;
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? '';
  if (ua === 'macOS') return 'darwin';
  if (ua === 'Windows') return 'win32';
  return 'linux';
})();
document.body.classList.add(`platform-${osPlatform}`);
if (osPlatform !== 'darwin') headerEl.appendChild(winControls); // far right, like the OS puts them
async function syncWindowState(): Promise<void> {
  try {
    const state = await window.manakin?.windowState();
    if (!state) return;
    winMaximiseBtn.classList.toggle('is-maximised', state.maximised);
    winFullscreenBtn.classList.toggle('is-fullscreen', state.fullscreen);
  } catch { /* icons keep their last state */ }
}
document.getElementById('win-close')?.addEventListener('click', () => {
  save();
  void window.manakin?.quit();
});
document.getElementById('win-minimise')?.addEventListener('click', () => {
  void window.manakin?.minimise();
});
winFullscreenBtn.addEventListener('click', async () => {
  try {
    const fullscreen = await window.manakin?.fullscreen();
    winFullscreenBtn.classList.toggle('is-fullscreen', fullscreen ?? false);
  } catch { /* state sync on resize will correct the icon */ }
});
winMaximiseBtn.addEventListener('click', async () => {
  try {
    const maximised = await window.manakin?.maximise();
    winMaximiseBtn.classList.toggle('is-maximised', maximised ?? false);
  } catch { /* state sync on resize will correct the icon */ }
});
headerEl.addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('button, input')) return;
  void window.manakin?.maximise().then((m) => winMaximiseBtn.classList.toggle('is-maximised', m ?? false)).catch(() => undefined);
});
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => { void syncWindowState(); }, 200);
});
void syncWindowState();

// ---------- toolbar ----------
const TOOLS: { id: ToolId; label: string; key: string; svg: string }[] = [
  { id: 'select', label: 'Select', key: 'V', svg: '<path d="M5 3l14 7-6 2-3 6z"/>' },
  { id: 'brush', label: 'Brush', key: 'P', svg: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M13 8l3 3"/>' },
  { id: 'eraser', label: 'Eraser', key: '', svg: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>' },
  { id: 'shape', label: 'Geometry', key: 'E', svg: '<rect x="4" y="4" width="16" height="16" rx="2"/>' },
  { id: 'text', label: 'Text', key: 'T', svg: '<path d="M5 6h14M12 6v13"/>' },
  // Paint bucket: the Lucide paint-bucket icon (user's pick from
  // three candidates), rendered at 1.8 stroke like the other tools.
  { id: 'paint', label: 'Paint', key: 'B', svg: '<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>' },
];
const toolbar = document.getElementById('toolbar')!;
function swapColors(): void {
  const t = color;
  color = bgColour;
  bgColour = t;
  save();
  renderToolbar();
}
function openColour(slot: 'fg' | 'bg'): void {
  // A fresh panel open reads the hue from the colour (0 = left end);
  // the 360 state only lives within one open panel session.
  colourHue360 = false;
  // Clicking the open swatch again closes the Colour view.
  if (panelView === 'colour' && colourSlot === slot) {
    panelView = 'auto';
    renderToolbar();
    renderPanel();
    return;
  }
  activeSlot = slot;
  colourSlot = slot;
  panelView = 'colour';
  if (!panelOpen) {
    panelOpen = true;
    save();
    applyPanelOpen();
  }
  renderToolbar();
  renderPanel();
}
function clampSize(n: number): number {
  return Math.max(2, Math.min(32, Math.round(n)));
}
function renderToolbar(): void {
  toolbar.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool' + (tool === t.id ? ' active' : '');
    b.title = t.key ? `${t.label} (${t.key})` : t.label;
    b.setAttribute('aria-label', t.label);
    b.innerHTML = `<svg viewBox="0 0 24 24">${t.svg}</svg>`;
    b.addEventListener('click', () => { tool = t.id; renderToolbar(); updateCursor(); });
    toolbar.appendChild(b);
  }
  toolbar.appendChild(document.createElement('hr'));
  // Brush size: no slider. A size preview circle (drag it to resize)
  // with a text input below to type the size, kept in sync both ways.
  const sizeWrap = document.createElement('div');
  sizeWrap.className = 'size-wrap';
  const preview = document.createElement('div');
  preview.className = 'brush-preview';
  preview.title = 'Brush size — drag to resize';
  preview.setAttribute('aria-label', 'Brush size preview, drag to resize');
  const dot = document.createElement('span');
  dot.className = 'brush-dot';
  const paintPreview = (): void => {
    dot.style.width = `${penWidth}px`;
    dot.style.height = `${penWidth}px`;
  };
  paintPreview();
  let dragStartX = 0;
  let dragStartSize = penWidth;
  preview.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartSize = penWidth;
    try { preview.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const onMove = (ev: PointerEvent): void => {
      penWidth = clampSize(dragStartSize + (ev.clientX - dragStartX) / 3);
      paintPreview();
      sizeInput.value = String(penWidth);
    };
    const onUp = (): void => {
      preview.removeEventListener('pointermove', onMove);
      preview.removeEventListener('pointerup', onUp);
      preview.removeEventListener('pointercancel', onUp);
      save();
    };
    preview.addEventListener('pointermove', onMove);
    preview.addEventListener('pointerup', onUp);
    preview.addEventListener('pointercancel', onUp);
  });
  preview.appendChild(dot);
  const sizeInput = document.createElement('input');
  sizeInput.className = 'brush-size-input';
  sizeInput.type = 'text';
  sizeInput.inputMode = 'numeric';
  sizeInput.value = String(penWidth);
  sizeInput.setAttribute('aria-label', 'Brush size in pixels');
  const commitSize = (): void => {
    const n = parseInt(sizeInput.value, 10);
    penWidth = Number.isFinite(n) ? clampSize(n) : penWidth;
    sizeInput.value = String(penWidth);
    paintPreview();
    save();
  };
  sizeInput.addEventListener('change', commitSize);
  sizeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitSize(); sizeInput.blur(); }
    e.stopPropagation();
  });
  sizeInput.addEventListener('blur', commitSize);
  sizeWrap.appendChild(preview);
  sizeWrap.appendChild(sizeInput);
  toolbar.appendChild(sizeWrap);
  toolbar.appendChild(document.createElement('hr'));
  // Double swatches: front = foreground, back = background.
  // Clicking one opens the Colour panel for that slot.
  const dbl = document.createElement('div');
  dbl.className = 'double-swatches';
  const pair = document.createElement('div');
  pair.className = 'pair';
  const back = document.createElement('button');
  back.className = 'dswatch back' + (activeSlot === 'bg' ? ' active' : '');
  back.style.background = bgColour;
  back.title = 'Back colour';
  back.setAttribute('aria-label', 'Back colour');
  back.addEventListener('click', () => openColour('bg'));
  const front = document.createElement('button');
  front.className = 'dswatch front' + (activeSlot === 'fg' ? ' active' : '');
  front.style.background = color;
  front.title = 'Front colour';
  front.setAttribute('aria-label', 'Front colour');
  front.addEventListener('click', () => openColour('fg'));
  const swap = document.createElement('button');
  swap.className = 'swap-btn';
  swap.title = 'Swap colours (X)';
  swap.setAttribute('aria-label', 'Swap colours');
  swap.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 8h11l-3-3M17 16H6l3 3"/></svg>';
  swap.addEventListener('click', swapColors);
  pair.appendChild(back);
  pair.appendChild(front);
  dbl.appendChild(pair);
  dbl.appendChild(swap);
  toolbar.appendChild(dbl);
}
// The eraser's reach, drawn at the cursor while the eraser tool is
// active — a body-level div like Bowerbird's #eraser-ring, so panel
// re-renders never wipe it mid-drag. Diameter is the eraser radius
// (the brush size) times two, scaled from stage units to screen pixels.
// Declared before updateCursor: that runs at module level and calls
// updateEraserRing, which reads this binding.
let eraserRingEl: HTMLDivElement | null = null;
function updateCursor(): void {
  canvas.classList.toggle('select-cursor', tool === 'select');
  canvas.classList.toggle('eraser-cursor', tool === 'eraser');
  // Space held over the workspace offers a pan (grab), R held offers
  // a rotation; a drag of either kind in progress shows the grabbing
  // hand. View gestures win over the tool cursor.
  canvas.classList.toggle('pan-cursor', (spaceHeld || rotateHeld) && panDrag === null && rotateDrag === null);
  canvas.classList.toggle('panning-cursor', panDrag !== null || rotateDrag !== null);
  if (tool !== 'eraser') updateEraserRing(0, 0, false);
}
renderToolbar();
updateCursor();

function updateEraserRing(clientX: number, clientY: number, show: boolean): void {
  if (!eraserRingEl) {
    eraserRingEl = document.createElement('div');
    eraserRingEl.id = 'eraser-ring';
    document.body.appendChild(eraserRingEl);
  }
  if (!show || tool !== 'eraser') {
    eraserRingEl.style.display = 'none';
    return;
  }
  const scale = workspaceLayout().s;
  const d = penWidth * 2 * scale;
  eraserRingEl.style.display = 'block';
  eraserRingEl.style.width = `${d}px`;
  eraserRingEl.style.height = `${d}px`;
  eraserRingEl.style.left = `${clientX - d / 2}px`;
  eraserRingEl.style.top = `${clientY - d / 2}px`;
}
canvas.addEventListener('pointermove', (e) => {
  updateEraserRing(e.clientX, e.clientY, true);
});
canvas.addEventListener('pointerleave', () => {
  updateEraserRing(0, 0, false);
});

// ---------- geometry ----------
function itemBBox(it: Item): { x: number; y: number; w: number; h: number } {
  if (it.type === 'stroke') {
    const xs = it.points.map((p) => p.x);
    const ys = it.points.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { x: x0 - 4, y: y0 - 4, w: Math.max(8, x1 - x0 + 8), h: Math.max(8, y1 - y0 + 8) };
  }
  if (it.type === 'shape') return { x: it.x, y: it.y, w: it.w, h: it.h };
  const w = Math.max(20, ctx.measureText(it.text || ' ').width + 12);
  return { x: it.x, y: it.y - it.size, w, h: it.size + 8 };
}
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}
function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function isClosedStroke(it: StrokeItem): boolean {
  if (it.points.length < 3) return false;
  const a = it.points[0], b = it.points[it.points.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1.5;
}
// A shape's outline as a polyline, for erasing: the rectangle's four
// corners (closed), the ellipse approximated with 48 segments (closed).
function shapeOutline(it: ShapeItem): Pt[] {
  if (it.kind === 'rect') {
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
function densify(pts: Pt[], step: number): Pt[] {
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
function motionAdjustedPoint(it: Item, p: Pt, t01: number): Pt {
  const m = motionForItem(it, t01);
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
function renderedBBox(it: Item, t01: number): { x: number; y: number; w: number; h: number } {
  const b = itemBBox(it);
  const m = motionForItem(it, t01);
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
function hitDistance(it: Item, q: Pt): { pathD: number; edgeD: number; tol: number; inside: boolean } {
  if (it.type === 'stroke') {
    const tol = Math.max(10, it.width + 6);
    let d = Infinity;
    for (let s = 0; s < it.points.length - 1; s++) d = Math.min(d, distToSegment(q, it.points[s], it.points[s + 1]));
    if (it.points.length === 1) d = Math.hypot(q.x - it.points[0].x, q.y - it.points[0].y);
    // A closed stroke (the beak triangle) is a filled area too.
    const inside = isClosedStroke(it) && pointInPolygon(q, it.points);
    return { pathD: d, edgeD: Infinity, tol, inside };
  }
  if (it.type === 'shape') {
    const pad = it.width / 2 + 8;
    if (it.kind === 'rect') {
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
function hitTest(p: Pt): Item | null {
  const t01 = playTime / loopMs();
  const infos = items.map((it, idx) => ({ it, idx, ...hitDistance(it, motionAdjustedPoint(it, p, t01)) }));
  // Topmost first; only a strictly smaller distance replaces the best,
  // so ties (a click on two crossing strokes) fall to the topmost.
  let best: Item | null = null;
  let bestD = Infinity;
  for (let k = infos.length - 1; k >= 0; k--) {
    const inf = infos[k];
    if (inf.it.type !== 'stroke' || inf.pathD > inf.tol) continue;
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
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------- animation ----------
// A behaviour layer is on for the whole loop when toggled on.
// All on layers superpose; amplitude eases in/out so toggling is smooth.
// ---------- groups ----------
// A layer's effective parameters fold in its group's multipliers.
// A member contributes only when both its own toggle and its group's toggle are on.
function groupOfIn(groups: BehaviourGroup[], layer: BehaviourLayer): BehaviourGroup | undefined {
  return groups.find((g) => g.members.includes(layer.id));
}
function groupOf(it: Item, layer: BehaviourLayer): BehaviourGroup | undefined {
  return groupOfIn(it.groups, layer);
}
function effActiveIn(groups: BehaviourGroup[], layer: BehaviourLayer): boolean {
  const g = groupOfIn(groups, layer);
  return layer.on && (!g || g.active);
}
function effActive(it: Item, layer: BehaviourLayer): boolean {
  return effActiveIn(it.groups, layer);
}
function effCycleIn(groups: BehaviourGroup[], layer: BehaviourLayer): number {
  const g = groupOfIn(groups, layer);
  return layer.cycle * (g ? g.cycle : 1);
}
function effCycle(it: Item, layer: BehaviourLayer): number {
  return effCycleIn(it.groups, layer);
}
function effAmplitudeIn(groups: BehaviourGroup[], layer: BehaviourLayer): number {
  const g = groupOfIn(groups, layer);
  return layer.amplitude * (g ? g.amplitude : 1);
}
function effAmplitude(it: Item, layer: BehaviourLayer): number {
  return effAmplitudeIn(it.groups, layer);
}
function amplitudeScale(a: number): number {
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
function loopMs(): number {
  return loopLength * 1000;
}
// Whole number of cycles an instance at this effective cycle count
// completes in one loop. The cycle math uses this, so the pose at the
// wrap equals the pose at the start.
function loopCycles(cycle: number): number {
  return Math.max(1, Math.round(cycle));
}
function smoothedAmp(layer: BehaviourLayer, target: number): number {
  const cur = smoothed.get(layer.id) ?? 0;
  let next = cur + (target - cur) * 0.06;
  if (Math.abs(next - target) < 0.002) next = target;
  smoothed.set(layer.id, next);
  return next;
}
type Motion = { dx: number; dy: number; scale: number; rot: number; opacity: number; sx: number; sy: number };
// Blink pulse: a smooth raised-cosine bump centred where sin(ph) peaks
// (ph = PI/2), spanning `durationPct` % of the cycle at its base. At the
// default 26% the eye is more than half closed for ~13% of the cycle,
// matching the old sin^8 blink.
function blinkPulse(ph: number, durationPct: number): number {
  const twoPi = Math.PI * 2;
  let d = (ph - Math.PI / 2) / twoPi; // distance from the blink centre, in cycles
  d -= Math.round(d); // wrap to [-0.5, 0.5]
  const w = durationPct / 100;
  if (Math.abs(d) >= w / 2) return 0;
  return 0.5 * (1 + Math.cos((twoPi * d) / w));
}
// Wander jitter amplitude: 50+ is the current smooth summed-sines drift;
// below 50, higher-frequency components creep in, up to 0.9 at 0%.
function wanderJitterAmp(smooth: number): number {
  return smooth >= 50 ? 0 : ((50 - smooth) / 50) * 0.9;
}
// Wander drift terms, shared by the motion and the graph so the two agree.
// `cycles` is the whole number of cycles the instance completes in one
// loop; every component frequency is an integer multiple of it (1x base,
// 2x/3x jitter), so the pose at the cycle end equals the pose at the
// start. The old 0.5x/0.7x base and 2.3x/3.1x jitter never closed.
function wanderTerms(layer: BehaviourLayer, cycles: number, t01: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const j = wanderJitterAmp(layer.wanderSmooth);
  if (layer.easing === 'smooth') {
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
function easedCyclePos(layer: BehaviourLayer, cycles: number, t01: number): number {
  const cyc = cycles * t01 + layer.offset;
  const whole = Math.floor(cyc);
  return whole + easePhase(layer.easing, cyc - whole);
}
// The fractional eased phase, for curves read in [0,1) like Bounce's.
function easedFrac(layer: BehaviourLayer, cycles: number, t01: number): number {
  const pos = easedCyclePos(layer, cycles, t01);
  return pos - Math.floor(pos);
}
// The phase angle for the sine-based behaviours. For Smooth the easing
// is the identity, so this is exactly the old expression — old saves
// and the sample bird move bit-identically.
function phaseOf(layer: BehaviourLayer, cycles: number, t01: number): number {
  if (layer.easing === 'smooth') return Math.PI * 2 * cycles * t01 + Math.PI * 2 * layer.offset;
  return Math.PI * 2 * easedCyclePos(layer, cycles, t01);
}
// Bounce height over one cycle: a parabola peaked mid-cycle — the
// constant-acceleration shape of a ball under gravity. It is 0 at the
// cycle ends (rest on the ground) and the velocity flips there: fast
// fall, sharp rebound. Always >= 0, unlike Bob's sine.
function bounceCurve(u: number): number {
  return 4 * u * (1 - u);
}
// Fade depth over one cycle: a slow raised-cosine ramp, 0 at the ends
// and 1 mid-cycle — the whole loop is one fade out and back in, where
// Blink's pulse spans only blinkDuration % of the cycle.
function fadeRamp(ph: number): number {
  return (1 - Math.cos(ph)) / 2;
}
// Tremble jitter, shared by the motion and the graph. Like Wander's
// drift but at higher integer-multiple frequencies (7x/9x base, 11x/13x
// second harmonic) and a much smaller radius, so it reads as a fast
// shiver rather than a slow drift. Every component is an integer
// multiple of the loop, so the pose at the cycle end equals the pose
// at the start.
function trembleTerms(layer: BehaviourLayer, cycles: number, t01: number): { x: number; y: number } {
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
type LayerCtx = {
  cycle: (l: BehaviourLayer) => number;
  amplitude: (l: BehaviourLayer) => number;
  active: (l: BehaviourLayer) => boolean;
};
function itemCtx(it: Item): LayerCtx {
  return { cycle: (l) => effCycle(it, l), amplitude: (l) => effAmplitude(it, l), active: (l) => effActive(it, l) };
}
function groupCtx(g: ItemGroup): LayerCtx {
  return { cycle: (l) => effCycleIn(g.groups, l), amplitude: (l) => effAmplitudeIn(g.groups, l), active: (l) => effActiveIn(g.groups, l) };
}
// A behaviour stack lives on an item or on an item group. The panel's
// layer cards work on either, and behaviour groups (v9) exist on either too.
type LayerHost = { kind: 'item'; item: Item } | { kind: 'group'; group: ItemGroup };
function hostLayers(h: LayerHost): BehaviourLayer[] {
  return h.kind === 'item' ? h.item.layers : h.group.layers;
}
function hostGroups(h: LayerHost): BehaviourGroup[] {
  return h.kind === 'item' ? h.item.groups : h.group.groups;
}
function hostCtx(h: LayerHost): LayerCtx {
  return h.kind === 'item' ? itemCtx(h.item) : groupCtx(h.group);
}
function hostFindLayer(h: LayerHost, id: string): BehaviourLayer | undefined {
  return hostLayers(h).find((l) => l.id === id);
}
function motionForLayers(layers: BehaviourLayer[], ctx: LayerCtx, t01: number): Motion {
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
function motionFor(it: Item, t01: number): Motion {
  return motionForLayers(it.layers, itemCtx(it), t01);
}
// An item group's own stack, applied to every member.
function groupMotion(g: ItemGroup, t01: number): Motion {
  return motionForLayers(g.layers, groupCtx(g), t01);
}
// An item's full motion: its own stack superposed with its item
// group's stack (if any). Offsets and rotation add, scale multiplies,
// opacity multiplies (both blink).
function motionForItem(it: Item, t01: number): Motion {
  const m = motionFor(it, t01);
  const g = itemGroupOf(it.id);
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
function behaviourValue(layer: BehaviourLayer, ctx: LayerCtx, t01: number): number {
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

// ---------- render ----------
// Workspace layout: the canvas covers the whole centre area; the stage
// is a card inside it, scaled to fit (s <= 1) and centred. Items live
// in stage coordinates (origin at the stage's top-left), so a point in
// the workspace maps to stage coords by subtracting the stage origin
// and dividing by the scale; outside the stage that gives negative or
// over-size coordinates, which is exactly where pasteboard items sit.
type WorkspaceLayout = { s: number; ox: number; oy: number; cw: number; ch: number; r: number };
function workspaceLayout(): WorkspaceLayout {
  const cw = stageWrap.clientWidth, ch = stageWrap.clientHeight;
  const { w, h } = stageSize();
  const fit = Math.min(1, cw / w, ch / h) || 1; // 0-size wrap (pre-layout) falls back to 1
  // Zoom scales the fit around the workspace centre, so the stage
  // grows/shrinks in place; at zoom > 1 the origin goes negative and
  // the stage extends past the visible workspace (clipped by the
  // canvas). Pan shifts that centred origin in workspace pixels.
  // Rotation turns the whole view around the workspace centre.
  // Every stage-space conversion reads this, so hit-testing, drawing,
  // dragging and the marquee all follow zoom, pan and rotation.
  const s = fit * zoom;
  return { s, ox: (cw - w * s) / 2 + panX, oy: (ch - h * s) / 2 + panY, cw, ch, r: rotateDeg * Math.PI / 180 };
}
// Rotate a context around the workspace centre by the view rotation,
// if any. Used by renderFrame and renderWithPreview so the stage, its
// items, the grid, the shape preview and the marquee all rotate
// together; the grey workspace background stays put (it fills the
// viewport either way). The caller's save/restore undoes it.
function rotateView(c: CanvasRenderingContext2D, L: WorkspaceLayout): void {
  if (L.r === 0) return;
  c.translate(L.cw / 2, L.ch / 2);
  c.rotate(L.r);
  c.translate(-L.cw / 2, -L.ch / 2);
}
function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}
function resizeCanvas(): void {
  clampPan(); // a smaller window re-clamps the same pan
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { cw, ch } = workspaceLayout();
  canvas.width = Math.max(1, Math.round(cw * dpr));
  canvas.height = Math.max(1, Math.round(ch * dpr));
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
}
// Focus alpha: the focused part renders full, everything else at 0.1
// (faintly visible, not hidden). A dangling id (item deleted/undone away)
// clears itself. Focus is view state, so it never applies to exports.
function validFocus(): string | null {
  if (focusedId !== null && !items.some((i) => i.id === focusedId)) focusedId = null;
  return focusedId;
}
function focusAlpha(it: Item): number {
  const f = validFocus();
  if (f === null) return 1;
  return it.id === f ? 1 : 0.1;
}
function drawItem(c: CanvasRenderingContext2D, it: Item, t01: number, applyFocus: boolean): void {
  const b = itemBBox(it);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const m = motionForItem(it, t01);
  c.save();
  c.translate(cx + m.dx, cy + m.dy);
  c.rotate(m.rot);
  c.scale(m.scale * m.sx, m.scale * m.sy);
  c.translate(-cx, -cy);
  // Focus dims the part; it multiplies the animated opacity (e.g. Blink)
  // rather than replacing it.
  c.globalAlpha = m.opacity * (applyFocus ? focusAlpha(it) : 1);
  c.strokeStyle = it.color;
  c.fillStyle = it.color;
  c.lineWidth = it.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (it.type === 'stroke') {
    c.beginPath();
    const pts = it.points;
    if (pts.length === 1) {
      c.moveTo(pts[0].x, pts[0].y);
      c.lineTo(pts[0].x, pts[0].y);
    } else if (pts.length < 5) {
      // Short strokes stay exact polylines: the sample bird's beak
      // (4 points), wing (3) and legs (2) keep their sharp corners,
      // so the bird looks identical. A fast user stroke has 5+ samples.
      pts.forEach((p, i) => { if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y); });
    } else {
      // Long strokes render as a smooth curve through the points:
      // the standard midpoint-quadratic technique. Old strokes smooth
      // too, since this is render time — no data migration.
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
    c.stroke();
  } else if (it.type === 'shape') {
    c.beginPath();
    if (it.kind === 'rect') c.rect(it.x, it.y, it.w, it.h);
    else c.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.abs(it.w) / 2, Math.abs(it.h) / 2, 0, 0, Math.PI * 2);
    if (it.fillSolid) c.fill();
    else {
      // Opaque paper base, then the tint: a shape occludes what is
      // beneath it, so Arrange visibly reorders — the body brought to
      // front really covers the head and wing. An isolated shape looks
      // exactly as before: the tint over the stage colour.
      c.fillStyle = stageBgValue(); c.fill();
      c.fillStyle = hexToRgba(it.color, 0.12); c.fill();
    }
    c.stroke();
  } else {
    c.font = `${it.size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    c.textBaseline = 'alphabetic';
    c.fillText(it.text, it.x, it.y);
  }
  c.restore();
}
function renderFrame(t01: number, target: CanvasRenderingContext2D = ctx, dprOverride?: number): void {
  const { w, h } = stageSize();
  const dpr = dprOverride ?? Math.min(2, window.devicePixelRatio || 1);
  const onScreen = target === ctx;
  // On screen the stage is a card inside the workspace (origin ox/oy,
  // scale s); offscreen targets are exactly stage-sized, so the stage
  // sits at the origin at full scale — that is the export crop:
  // anything outside the stage rect simply falls off the canvas.
  const L = onScreen ? workspaceLayout() : { s: 1, ox: 0, oy: 0, cw: w, ch: h, r: 0 };
  target.save();
  target.setTransform(dpr, 0, 0, dpr, 0, 0);
  target.clearRect(0, 0, L.cw, L.ch);
  if (onScreen) {
    // The workspace itself is painted on the canvas (not left to the
    // CSS behind it), so the bitmap is self-contained: the grey
    // workspace, the stage card on it, and items anywhere in it.
    target.fillStyle = '#f5f5f7';
    target.fillRect(0, 0, L.cw, L.ch);
    // The view rotation turns the stage, its items, the grid and the
    // selection around the workspace centre; the grey workspace
    // itself stays put. Offscreen targets never rotate (r is 0
    // there), so exports are always upright.
    rotateView(target, L);
    // The stage card: stage background, soft shadow, hairline border,
    // 14px radius (var(--radius)). Drawn in workspace pixels, before
    // the items — a part straddling the edge paints over the border
    // where it crosses, like paper overlapping a sheet's edge.
    target.save();
    target.shadowColor = 'rgba(0,0,0,0.08)';
    target.shadowBlur = 16;
    target.shadowOffsetY = 4;
    target.fillStyle = stageBgValue();
    roundRectPath(target, L.ox, L.oy, w * L.s, h * L.s, 14);
    target.fill();
    target.restore();
    target.strokeStyle = 'rgba(0,0,0,0.08)';
    target.lineWidth = 1;
    roundRectPath(target, L.ox, L.oy, w * L.s, h * L.s, 14);
    target.stroke();
  } else {
    target.fillStyle = stageBgValue();
    target.fillRect(0, 0, w, h);
  }
  // From here on, stage coordinates: items, grid and selection all
  // live in stage space, on screen and off.
  target.translate(L.ox, L.oy);
  target.scale(L.s, L.s);
  // The grid is a drawing/composition overlay: it renders on the
  // on-screen canvas only, never in exports (offscreen targets), and
  // only inside the stage rect — its lines are stage coordinates.
  if (onScreen && gridMode !== 'empty') {
    const gridCol = stageBgId === 'ink' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)';
    if (gridMode === 'grid') {
      const step = 24;
      target.fillStyle = gridCol;
      for (let x = step; x < w; x += step) {
        for (let y = step; y < h; y += step) target.fillRect(x - 1, y - 1, 2, 2);
      }
    } else {
      // Composition lines: thin, subtle, same hairline language.
      const phi = (1 + Math.sqrt(5)) / 2;
      const g1 = 1 / phi; // ≈0.382
      const g2 = 1 - g1; // ≈0.618
      const vlines: number[] = [];
      const hlines: number[] = [];
      if (gridMode === 'thirds') { vlines.push(w / 3, (2 * w) / 3); hlines.push(h / 3, (2 * h) / 3); }
      if (gridMode === 'horizon') { hlines.push(h / 3, (2 * h) / 3); }
      if (gridMode === 'centre') { vlines.push(w / 2); hlines.push(h / 2); }
      if (gridMode === 'golden') { vlines.push(w * g1, w * g2); hlines.push(h * g1, h * g2); }
      target.strokeStyle = gridCol;
      target.lineWidth = 1;
      target.beginPath();
      for (const x of vlines) { target.moveTo(x, 0); target.lineTo(x, h); }
      for (const y of hlines) { target.moveTo(0, y); target.lineTo(w, y); }
      target.stroke();
    }
  }
  for (const it of items) drawItem(target, it, t01, target === ctx);
  const f = validFocus();
  // Every selected item gets its outline (all of them when nothing is
  // focused; only the focused one while focus is on). The outline
  // follows the item's full motion, group layers included.
  if (target === ctx) {
    for (const it of selectedItems()) {
      if (f !== null && it.id !== f) continue;
      const b = itemBBox(it);
      const m = motionForItem(it, t01);
      target.save();
      target.setLineDash([5, 4]);
      target.strokeStyle = '#007aff';
      target.lineWidth = 1.5;
      target.strokeRect(b.x + m.dx - 5, b.y + m.dy - 5, b.w + 10, b.h + 10);
      target.restore();
    }
  }
  target.restore();
}

function frame(ts: number): void {
  if (playing) {
    if (lastTs) playTime = (playTime + (ts - lastTs)) % loopMs();
    lastTs = ts;
  } else {
    lastTs = 0;
  }
  const t01 = playTime / loopMs();
  renderWithPreview(t01);
  progressFill.style.width = `${(t01 * 100).toFixed(1)}%`;
  timeState.textContent = `${(playTime / 1000).toFixed(1)} / ${(loopMs() / 1000).toFixed(1)}s`;
  requestAnimationFrame(frame);
}

// ---------- panel helpers ----------
// Custom-styled continuous slider row: label + range input + live value text.
// onInput runs live (graph redraw); onCommit runs on release (save).
function paramSlider(opts: {
  label: string; min: number; max: number; step: number; value: number;
  format: (v: number) => string; aria: string;
  onInput: (v: number) => void; onCommit: () => void;
}): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'pslider-row';
  const lab = document.createElement('span');
  lab.className = 'dctl-label';
  lab.textContent = opts.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'pslider';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.setAttribute('aria-label', opts.aria);
  const val = document.createElement('span');
  val.className = 'pslider-value';
  val.textContent = opts.format(opts.value);
  // One undo entry per drag, not one per input event: capture the
  // pre-change snapshot when the interaction starts (pointerdown,
  // focus, or — for synthetic events — the first input) and commit it
  // on release, but only when the value actually moved.
  let pendingBefore: string | null = null;
  let startValue = opts.value;
  const begin = (): void => {
    if (pendingBefore === null) {
      pendingBefore = snapshot();
      startValue = parseFloat(input.value);
    }
  };
  input.addEventListener('pointerdown', begin);
  input.addEventListener('focus', begin);
  input.addEventListener('input', () => {
    begin();
    const v = parseFloat(input.value);
    val.textContent = opts.format(v);
    opts.onInput(v);
  });
  input.addEventListener('change', () => {
    if (pendingBefore !== null) {
      if (parseFloat(input.value) !== startValue) gestureCommit(pendingBefore, true);
      pendingBefore = null;
    }
    opts.onCommit();
  });
  row.appendChild(lab);
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

// A labelled segmented choice (Easing, Orbit Direction): the label sits
// above the control, the control is a .seg. The active button updates in
// place; the caller owns history/save/redraw. A click on the already
// active option is a no-op (no undo entry, no re-render).
function choiceSeg(opts: {
  label: string; aria: string; compact?: boolean;
  options: { id: string; label: string; aria: string }[];
  value: string;
  onPick: (id: string) => void;
}): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'choice-row';
  const lab = document.createElement('span');
  lab.className = 'dctl-label';
  lab.textContent = opts.label;
  row.appendChild(lab);
  const seg = document.createElement('div');
  seg.className = 'seg' + (opts.compact ? ' compact-seg' : '');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', opts.aria);
  let current = opts.value;
  const btns: HTMLButtonElement[] = [];
  for (const o of opts.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = current === o.id ? 'active' : '';
    b.textContent = o.label;
    b.setAttribute('aria-label', o.aria);
    b.addEventListener('click', () => {
      if (current === o.id) return;
      current = o.id;
      for (const x of btns) x.classList.toggle('active', x === b);
      opts.onPick(o.id);
    });
    seg.appendChild(b);
    btns.push(b);
  }
  row.appendChild(seg);
  return row;
}

function drawGraph(cv: HTMLCanvasElement, layer: BehaviourLayer, ctx: LayerCtx): void {
  const W = 232, H = 48;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const g = cv.getContext('2d')!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, H / 2 + 0.5);
  g.lineTo(W, H / 2 + 0.5);
  g.stroke();
  const N = 120;
  const maxAmp = 1.8; // amplitudeScale(1)
  g.strokeStyle = '#1d1d1f';
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const v = behaviourValue(layer, ctx, t) / maxAmp;
    const x = (t * (W - 4)) + 2;
    const y = H / 2 - v * (H / 2 - 5);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

// The panel rebuilds its DOM on every render, which drops the scroll
// position: rebuilding while scrolled clamps scrollTop to 0. Keep the
// scroll where it was when the same stack is still showing; a different
// stack (another part, a group, the Canvas panel) starts at the top.
// After adding a behaviour, scroll the new layer into view; after
// opening the Add list, scroll the list into view.
let lastPanelKey = '';
let scrollToLayerId: string | null = null;
let scrollToAddList = false; // set when the Add button opens the list
function renderPanel(): void {
  const grp = selectedItemGroup();
  const sel = selected();
  const key = panelView + '|' + (grp ? 'g:' + grp.id : sel ? 'i:' + sel.id : selectedIds.length >= 2 ? 'm:' + selectedIds.join(',') : 'canvas');
  const st = panelBody.scrollTop;
  renderPanelInner();
  panelBody.scrollTop = key === lastPanelKey ? st : 0;
  lastPanelKey = key;
  if (scrollToLayerId) {
    const el = panelBody.querySelector(`[data-layer-id="${scrollToLayerId}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    scrollToLayerId = null;
  }
  if (scrollToAddList) {
    const list = panelBody.querySelector('.add-list');
    if (list) (list as HTMLElement).scrollIntoView({ block: 'nearest' });
    scrollToAddList = false;
  }
}
function renderPanelInner(): void {
  syncUndoButtons();
  closeExportDropdownEl();
  closeTooltipEl();
  const grp = selectedItemGroup();
  const sel = selected();
  if (panelView !== 'auto' || (!grp && !sel)) addPickerOpen = false;
  // The Export dropdown is anchored to a button that only exists on
  // the Canvas panel; any other view closes it.
  if (panelView !== 'auto' || grp || sel || selectedIds.length >= 2) exportDropdownOpen = false;
  panelBody.innerHTML = '';
  if (panelView === 'colour') { renderColourPanel(); return; }
  if (grp) { renderItemGroupPanel(grp); return; }
  if (sel) { renderBehavioursPanel(sel); return; }
  if (selectedIds.length >= 2) { renderMultiSelectPanel(selectedItems()); return; }
  renderCanvasPanel();
}

// Combined graph for a group: the sum of its members' effective motion
// over the loop. Only members that are effectively on (own toggle and
// group toggle) contribute, so a suspended group reads flat. The scale is
// fixed to the sum of the members' own amplitudes (before the group
// multiplier), so changing the group's Amplitude visibly shrinks the curve
// instead of re-normalising it away.
function drawGroupGraph(cv: HTMLCanvasElement, host: LayerHost, group: BehaviourGroup): void {
  const W = 232, H = 48;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const g = cv.getContext('2d')!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(0,0,0,0.08)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, H / 2 + 0.5);
  g.lineTo(W, H / 2 + 0.5);
  g.stroke();
  const N = 120;
  const ctx = hostCtx(host);
  const members = group.members.map((id) => hostFindLayer(host, id)).filter((l): l is BehaviourLayer => !!l);
  const vals: number[] = [];
  let scale = 0;
  for (const layer of members) if (ctx.active(layer)) scale += amplitudeScale(layer.amplitude);
  if (scale < 0.01) scale = 1;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let v = 0;
    for (const layer of members) if (ctx.active(layer)) v += behaviourValue(layer, ctx, t);
    vals.push(v);
  }
  g.strokeStyle = '#1d1d1f';
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = ((i / N) * (W - 4)) + 2;
    const y = H / 2 - (vals[i] / scale) * (H / 2 - 5);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

// Display name is derived, not stored: when a stack holds more than one
// instance of a behaviour, each shows its ordinal among instances of that
// behaviour in stack order — first "Bob", second "Bob 2", third "Bob 3".
// A lone instance shows just "Bob".
function layerDisplayName(h: LayerHost, layer: BehaviourLayer): string {
  const same = hostLayers(h).filter((l) => l.behaviour === layer.behaviour);
  if (same.length <= 1) return BEHAVIOURS[layer.behaviour];
  const idx = same.indexOf(layer);
  return idx === 0 ? BEHAVIOURS[layer.behaviour] : `${BEHAVIOURS[layer.behaviour]} ${idx + 1}`;
}

// One behaviour layer row: on/off toggle, name, expand chevron, and — when
// expanded — its graph plus Cycle/Amplitude/Offset and its own extra controls.
// Works on an item's stack or an item group's stack; the host is what
// owns the layer. Returns the row and its graph canvas (null while
// collapsed) so a group can redraw member graphs when a group slider moves.
function behaviourLayer(host: LayerHost, inst: BehaviourLayer, opts: { checkable: boolean; onParamChange?: () => void }): { layer: HTMLDivElement; graph: HTMLCanvasElement | null } {
  const b = inst.behaviour;
  const displayName = layerDisplayName(host, inst);
  const liveLayer = (): BehaviourLayer | undefined => hostFindLayer(host, inst.id);
  const layer = document.createElement('div');
  layer.className = 'blayer' + (expandedLayerId === inst.id ? ' expanded' : '');
  layer.dataset.behaviour = String(b);
  layer.dataset.layerId = inst.id;
  const head = document.createElement('div');
  head.className = 'layer-head';
  if (opts.checkable) {
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'layer-check' + (checkedLayers.has(inst.id) ? ' checked' : '');
    check.setAttribute('aria-label', `Select ${displayName} for grouping`);
    check.setAttribute('aria-pressed', String(checkedLayers.has(inst.id)));
    check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkedLayers.has(inst.id)) checkedLayers.delete(inst.id);
      else checkedLayers.add(inst.id);
      renderPanel();
    });
    head.appendChild(check);
  }
  const icon = document.createElement('span');
  icon.className = 'layer-icon';
  icon.innerHTML = LAYER_ICONS[b];
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'layer-toggle' + (inst.on ? ' on' : '');
  toggle.setAttribute('aria-label', `${displayName} on or off`);
  toggle.setAttribute('aria-pressed', String(inst.on));
  toggle.innerHTML = '<span class="knob"></span>';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const l = liveLayer();
    if (!l) return;
    pushHistory();
    l.on = !l.on;
    save();
    renderPanel();
  });
  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = displayName;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'layer-remove';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', `Remove ${displayName}`);
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  remove.addEventListener('click', (e) => {
    e.stopPropagation();
    removeBehaviourLayer(host, inst.id);
  });
  const chev = document.createElement('button');
  chev.type = 'button';
  chev.className = 'layer-chev';
  chev.setAttribute('aria-label', expandedLayerId === inst.id ? `Collapse ${displayName}` : `Expand ${displayName}`);
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  const toggleExpand = (): void => {
    expandedLayerId = expandedLayerId === inst.id ? null : inst.id;
    renderPanel();
  };
  chev.addEventListener('click', (e) => {
    e.stopPropagation(); // the head row also toggles; without this it flips twice
    toggleExpand();
  });
  head.appendChild(icon);
  head.appendChild(name);
  head.appendChild(toggle);
  head.appendChild(chev);
  head.appendChild(remove);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.layer-toggle, .layer-check, .layer-remove')) return;
    toggleExpand();
  });
  layer.appendChild(head);
  let graph: HTMLCanvasElement | null = null;
  if (expandedLayerId === inst.id) {
    const body = document.createElement('div');
    body.className = 'layer-body';
    graph = document.createElement('canvas');
    graph.className = 'graph';
    graph.setAttribute('aria-label', `${displayName} motion graph`);
    body.appendChild(graph);
    const redraw = (): void => {
      const l = hostFindLayer(host, inst.id);
      if (graph && l) drawGraph(graph, l, hostCtx(host));
      opts.onParamChange?.();
    };
    body.appendChild(paramSlider({
      label: 'Cycle', min: CYCLE_MIN, max: CYCLE_MAX, step: 1, value: inst.cycle,
      format: (v) => `${Math.round(v)}`,
      aria: `${displayName} cycle`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.cycle = Math.round(v); redraw(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Amplitude', min: 0, max: 1, step: 0.01, value: inst.amplitude,
      format: (v) => v.toFixed(2),
      aria: `${displayName} amplitude`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.amplitude = v; redraw(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Offset', min: 0, max: 1, step: 0.01, value: inst.offset,
      format: (v) => v.toFixed(2),
      aria: `${displayName} offset`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.offset = v; redraw(); },
      onCommit: () => save(),
    }));
    body.appendChild(choiceSeg({
      label: 'Easing', aria: `${displayName} easing`, compact: true,
      options: EASING_IDS.map((e) => ({ id: e, label: EASING_LABELS[e], aria: EASING_ARIA[e] })),
      value: inst.easing,
      onPick: (id) => {
        const l = liveLayer();
        if (!l) return;
        pushHistory();
        l.easing = id as EasingName;
        redraw();
        save();
      },
    }));
    if (b === 3) {
      body.appendChild(paramSlider({
        label: 'Duration', min: 10, max: 60, step: 1, value: inst.blinkDuration,
        format: (v) => `${Math.round(v)}%`,
        aria: 'Blink duration',
        onInput: (v) => { const l = liveLayer(); if (!l) return; l.blinkDuration = v; redraw(); },
        onCommit: () => save(),
      }));
    }
    if (b === 4) {
      const revRow = document.createElement('div');
      revRow.className = 'ptoggle-row';
      const revLab = document.createElement('span');
      revLab.className = 'dctl-label';
      revLab.textContent = 'Reverse';
      const revToggle = document.createElement('button');
      revToggle.type = 'button';
      revToggle.className = 'layer-toggle' + (inst.spinReverse ? ' on' : '');
      revToggle.setAttribute('aria-label', 'Spin reverse');
      revToggle.setAttribute('aria-pressed', String(inst.spinReverse));
      revToggle.innerHTML = '<span class="knob"></span>';
      const revVal = document.createElement('span');
      revVal.className = 'pslider-value';
      revVal.textContent = inst.spinReverse ? 'On' : 'Off';
      revToggle.addEventListener('click', () => {
        const l = liveLayer();
        if (!l) return;
        pushHistory();
        l.spinReverse = !l.spinReverse;
        revToggle.classList.toggle('on', l.spinReverse);
        revToggle.setAttribute('aria-pressed', String(l.spinReverse));
        revVal.textContent = l.spinReverse ? 'On' : 'Off';
        redraw();
        save();
      });
      revRow.appendChild(revLab);
      revRow.appendChild(revToggle);
      revRow.appendChild(revVal);
      body.appendChild(revRow);
    }
    if (b === 5) {
      body.appendChild(paramSlider({
        label: 'Smooth', min: 0, max: 100, step: 1, value: inst.wanderSmooth,
        format: (v) => `${Math.round(v)}%`,
        aria: 'Wander smoothness',
        onInput: (v) => { const l = liveLayer(); if (!l) return; l.wanderSmooth = v; redraw(); },
        onCommit: () => save(),
      }));
    }
    if (b === 8) {
      body.appendChild(choiceSeg({
        label: 'Direction', aria: 'Orbit direction',
        options: [
          { id: 'cw', label: 'Clockwise', aria: 'Orbit direction clockwise' },
          { id: 'ccw', label: 'Counter-clockwise', aria: 'Orbit direction counter-clockwise' },
        ],
        value: inst.orbitReverse ? 'ccw' : 'cw',
        onPick: (id) => {
          const l = liveLayer();
          if (!l) return;
          pushHistory();
          l.orbitReverse = id === 'ccw';
          redraw();
          save();
        },
      }));
    }
    layer.appendChild(body);
    drawGraph(graph, inst, hostCtx(host));
  }
  return { layer, graph };
}

// One group row: chevron, name (click to rename inline), on/off toggle,
// ungroup button. When expanded: combined graph, the group's Cycle and
// Amplitude sliders, then the member rows with their own controls.
function groupLayer(host: LayerHost, group: BehaviourGroup): HTMLDivElement {
  const open = expandedGroup === group.id;
  const layer = document.createElement('div');
  layer.className = 'blayer group' + (open ? ' expanded' : '');
  layer.dataset.group = group.id;
  const head = document.createElement('div');
  head.className = 'layer-head group-head';
  const chev = document.createElement('button');
  chev.type = 'button';
  chev.className = 'layer-chev';
  chev.setAttribute('aria-label', open ? `Collapse ${group.name}` : `Expand ${group.name}`);
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  const toggleExpand = (): void => {
    expandedGroup = expandedGroup === group.id ? null : group.id;
    renderPanel();
  };
  chev.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpand();
  });
  const name = document.createElement('span');
  name.className = 'layer-name group-name';
  name.textContent = group.name;
  name.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-rename';
    input.value = group.name;
    input.setAttribute('aria-label', 'Layer group name');
    input.spellcheck = false;
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) {
        const v = input.value.trim();
        if (v && v !== group.name) { pushHistory(); group.name = v; save(); }
      }
      renderPanel();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    head.replaceChild(input, name);
    input.focus();
    input.select();
  });
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'layer-toggle' + (group.active ? ' on' : '');
  toggle.setAttribute('aria-label', `${group.name} on or off`);
  toggle.setAttribute('aria-pressed', String(group.active));
  toggle.innerHTML = '<span class="knob"></span>';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const g = hostGroups(host).find((gg) => gg.id === group.id);
    if (!g) return;
    pushHistory();
    g.active = !g.active;
    save();
    renderPanel();
  });
  const ungroup = document.createElement('button');
  ungroup.type = 'button';
  ungroup.className = 'ungroup-btn';
  ungroup.title = 'Ungroup behaviours';
  ungroup.setAttribute('aria-label', `Ungroup ${group.name}`);
  // One square with a crack in it: a single rounded-square outline
  // with a zigzag crack running from the top edge to the bottom edge.
  // The two-squares version read as two shapes; this one is one
  // shape, broken. Same 16px / stroke 1.8 treatment as the other
  // header icons. Only the behaviour ungroup uses this glyph — the
  // item-group ungroup is a labelled pill, not an icon.
  ungroup.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5"/><path d="M13 5 L9.5 9 L14 12.5 L10 16 L13 19"/></svg>';
  ungroup.addEventListener('click', (e) => {
    e.stopPropagation();
    pushHistory();
    const gs = hostGroups(host);
    const i = gs.findIndex((g) => g.id === group.id);
    if (i >= 0) gs.splice(i, 1);
    if (expandedGroup === group.id) expandedGroup = null;
    save();
    renderPanel();
  });
  // Head order matches a layer head: name, toggle, chevron, action —
  // the expand chevron sits on the right in both, not on the left here.
  head.appendChild(name);
  head.appendChild(toggle);
  head.appendChild(chev);
  head.appendChild(ungroup);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.layer-toggle, .ungroup-btn, .group-rename')) return;
    toggleExpand();
  });
  layer.appendChild(head);
  if (open) {
    const body = document.createElement('div');
    body.className = 'layer-body group-body';
    const graph = document.createElement('canvas');
    graph.className = 'graph';
    graph.setAttribute('aria-label', `${group.name} combined graph`);
    body.appendChild(graph);
    const memberGraphs = new Map<string, HTMLCanvasElement>();
    const redrawGroupGraph = (): void => {
      const g = hostGroups(host).find((gg) => gg.id === group.id);
      if (g) drawGroupGraph(graph, host, g);
    };
    const redrawMemberGraphs = (): void => {
      for (const [id, cv] of memberGraphs) {
        const l = hostFindLayer(host, id);
        if (l) drawGraph(cv, l, hostCtx(host));
      }
    };
    body.appendChild(paramSlider({
      label: 'Cycle', min: CYCLE_MIN, max: CYCLE_MAX, step: 1, value: group.cycle,
      format: (v) => `${Math.round(v)}`,
      aria: `${group.name} cycle`,
      onInput: (v) => { const g = hostGroups(host).find((gg) => gg.id === group.id); if (!g) return; g.cycle = Math.round(v); redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Amplitude', min: 0, max: 1, step: 0.01, value: group.amplitude,
      format: (v) => v.toFixed(2),
      aria: `${group.name} amplitude`,
      onInput: (v) => { const g = hostGroups(host).find((gg) => gg.id === group.id); if (!g) return; g.amplitude = v; redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => save(),
    }));
    const membersWrap = document.createElement('div');
    membersWrap.className = 'group-members';
    for (const memberId of group.members) {
      const member = hostFindLayer(host, memberId);
      if (!member) continue;
      const { layer: mLayer, graph: mGraph } = behaviourLayer(host, member, {
        checkable: false,
        onParamChange: () => redrawGroupGraph(),
      });
      mLayer.classList.add('in-group');
      if (mGraph) memberGraphs.set(member.id, mGraph);
      membersWrap.appendChild(mLayer);
    }
    body.appendChild(membersWrap);
    layer.appendChild(body);
    drawGroupGraph(graph, host, group);
  }
  return layer;
}

// Remove a layer from a stack. On an item its parameters are stashed
// by behaviour, so adding that behaviour again restores them exactly;
// a later removal of the same behaviour overwrites the stash with the
// most recently removed instance. Other instances of the same behaviour
// are untouched. A grouped member leaves its behaviour group; an
// emptied behaviour group is removed. An item group's stack has no
// stash, but it has behaviour groups: a removed member leaves its
// group the same way.
function removeBehaviourLayer(host: LayerHost, layerId: string): void {
  if (host.kind === 'group') {
    pushHistory();
    host.group.layers = host.group.layers.filter((l) => l.id !== layerId);
    for (const g of host.group.groups) g.members = g.members.filter((m) => m !== layerId);
    host.group.groups = host.group.groups.filter((g) => g.members.length > 0);
    if (expandedGroup && !host.group.groups.some((g) => g.id === expandedGroup)) expandedGroup = null;
    checkedLayers.delete(layerId);
    if (expandedLayerId === layerId) expandedLayerId = null;
    save();
    renderPanel();
    return;
  }
  const sel = host.item;
  const layer = sel.layers.find((l) => l.id === layerId);
  if (!layer) return;
  pushHistory();
  sel.stash[layer.behaviour] = {
    on: layer.on, cycle: layer.cycle, amplitude: layer.amplitude, offset: layer.offset,
    easing: layer.easing,
    blinkDuration: layer.blinkDuration, spinReverse: layer.spinReverse, wanderSmooth: layer.wanderSmooth,
    orbitReverse: layer.orbitReverse,
  };
  sel.layers = sel.layers.filter((l) => l.id !== layerId);
  for (const g of sel.groups) g.members = g.members.filter((m) => m !== layerId);
  sel.groups = sel.groups.filter((g) => g.members.length > 0);
  if (expandedGroup && !sel.groups.some((g) => g.id === expandedGroup)) expandedGroup = null;
  checkedLayers.delete(layerId);
  if (expandedLayerId === layerId) expandedLayerId = null;
  save();
  renderPanel();
}

// Add a behaviour to a stack. Always a NEW instance, even when one of
// that behaviour is already there. On an item, a stashed instance (the
// most recently removed one of this behaviour) restores its parameters;
// a never-added behaviour starts at the defaults. An item group's stack
// has no stash: it always starts at the defaults.
function addBehaviour(host: LayerHost, b: number): void {
  pushHistory();
  let layer: BehaviourLayer;
  if (host.kind === 'group') {
    layer = newLayer(b);
    host.group.layers.push(layer);
  } else {
    const stashed = host.item.stash[b];
    layer = stashed
      ? { id: nid(), behaviour: b, ...stashed }
      : newLayer(b);
    if (stashed) delete host.item.stash[b];
    host.item.layers.push(layer);
  }
  scrollToLayerId = layer.id;
  addPickerOpen = false;
  save();
  renderPanel();
}

// The Add behavior list: opens inline in the panel, directly below
// the Add button, as part of the panel's own scrollable flow — it
// covers nothing and pushes nothing aside. Lists all eleven
// behaviours with their icons. Every row is always enabled: the same
// behaviour can be added several times, each add creating a new
// instance. Picking a row adds the behaviour and collapses the list.
function renderAddList(host: LayerHost): HTMLElement {
  const list = document.createElement('div');
  list.className = 'add-list';
  list.setAttribute('role', 'listbox');
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'add-list-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-label', `Add ${BEHAVIOURS[b]}`);
    row.innerHTML = `<span class="layer-icon">${LAYER_ICONS[b]}</span><span class="layer-name">${BEHAVIOURS[b]}</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      addBehaviour(host, b);
    });
    list.appendChild(row);
  }
  return list;
}

// Group the checked layers of a host's stack into one behaviour
// group: the group's Cycle/Amplitude multiply its members'. Same
// flow on an item and on an item group.
function createBehaviourGroup(host: LayerHost): void {
  if (checkedLayers.size < 2) return;
  pushHistory();
  const layers = hostLayers(host);
  const groups = hostGroups(host);
  const members = [...checkedLayers].sort((a, b) => layers.findIndex((l) => l.id === a) - layers.findIndex((l) => l.id === b));
  let n = 1;
  for (const g of groups) {
    const m = /^Layer Group (\d+)$/.exec(g.name);
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
  }
  const group: BehaviourGroup = { id: nid(), name: `Layer Group ${n}`, members, active: true, cycle: 1, amplitude: 1 };
  groups.push(group);
  checkedLayers.clear();
  expandedLayerId = null;
  expandedGroup = group.id;
  save();
  renderPanel();
}

// The checkable stack for a host: the grouping checks reset when the
// host changes, checks drop for layers that left the stack or joined
// a group, and the rows and behaviour-group cards render in stack
// order — a group takes its first member's place, so ungrouping
// restores members to their original positions.
function appendStackEntries(host: LayerHost): void {
  const layers = hostLayers(host);
  const groups = hostGroups(host);
  const hostId = host.kind === 'item' ? host.item.id : host.group.id;
  if (checkedHostId !== hostId) { checkedLayers.clear(); checkedHostId = hostId; addPickerOpen = false; }
  const grouped = new Set(groups.flatMap((g) => g.members));
  // Drop checks for layers that left the stack or joined a group.
  for (const id of [...checkedLayers]) if (!layers.some((l) => l.id === id) || grouped.has(id)) checkedLayers.delete(id);
  type Entry = { pos: number; render: () => HTMLElement };
  const entries: Entry[] = [];
  for (const layer of layers) {
    if (!grouped.has(layer.id)) entries.push({ pos: layers.indexOf(layer), render: () => behaviourLayer(host, layer, { checkable: true }).layer });
  }
  for (const g of groups) {
    const idxs = g.members.map((id) => layers.findIndex((l) => l.id === id)).filter((i) => i >= 0);
    entries.push({ pos: idxs.length ? Math.min(...idxs) : Number.POSITIVE_INFINITY, render: () => groupLayer(host, g) });
  }
  entries.sort((a, b) => a.pos - b.pos);
  for (const e of entries) panelBody.appendChild(e.render());
}

// The "Group behaviours" pill, shown when 2+ layers of the host's
// stack are checked. Same flow on an item and on an item group.
function appendGroupBehavioursAction(host: LayerHost): void {
  if (checkedLayers.size < 2) return;
  panelBody.appendChild(panelDivider());
  const action = document.createElement('div');
  action.className = 'group-action';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pbtn-quiet';
  btn.textContent = 'Group behaviours';
  btn.setAttribute('aria-label', `Group ${checkedLayers.size} behaviours`);
  btn.addEventListener('click', () => createBehaviourGroup(host));
  action.appendChild(btn);
  panelBody.appendChild(action);
}

function renderBehavioursPanel(sel: Item): void {
  panelTitle.textContent = 'Behaviours';
  panelBody.appendChild(renderArrangeSection());
  panelBody.appendChild(panelDivider());
  const host: LayerHost = { kind: 'item', item: sel };
  appendStackEntries(host);
  if (sel.layers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-behaviours';
    empty.textContent = 'No behaviours';
    panelBody.appendChild(empty);
  }
  appendGroupBehavioursAction(host);
  // Add behavior: a quiet pill at the bottom of the stack. Always
  // enabled — adding the same behaviour again creates another instance.
  panelBody.appendChild(renderAddBehaviourButton(host));
}

// The Add behavior pill, shared by the item stack and the item-group
// stack: it expands the behaviour list inline below the button, for
// that host.
function renderAddBehaviourButton(host: LayerHost): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'add-wrap';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-btn';
  addBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Add behavior</span>';
  addBtn.setAttribute('aria-label', 'Add behavior');
  addBtn.setAttribute('aria-expanded', String(addPickerOpen));
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addPickerOpen = !addPickerOpen;
    if (addPickerOpen) scrollToAddList = true;
    renderPanel();
  });
  wrap.appendChild(addBtn);
  if (addPickerOpen) wrap.appendChild(renderAddList(host));
  return wrap;
}

// ---------- item groups (panel) ----------
// Group the current multi-selection: members leave any existing item
// groups first; an old group left with fewer than 2 members dissolves
// and its behaviour layers are deleted with it.
function groupSelection(): void {
  if (selectedIds.length < 2) return;
  pushHistory();
  const memberIds = [...selectedIds];
  for (const g of itemGroups) g.memberIds = g.memberIds.filter((m) => !memberIds.includes(m));
  itemGroups = itemGroups.filter((g) => g.memberIds.length >= 2);
  itemGroups.push({ id: nid(), memberIds, layers: [], groups: [] });
  selectedIds = memberIds;
  save();
  renderPanel();
}
// Ungroup deletes the group and its behaviour layers only — members
// keep their own layers, positions and behaviours, and stay selected
// as a multi-selection afterwards.
function ungroupItemGroup(group: ItemGroup): void {
  pushHistory();
  const members = [...group.memberIds];
  itemGroups = itemGroups.filter((g) => g.id !== group.id);
  selectedIds = members.filter((id) => items.some((i) => i.id === id));
  save();
  renderPanel();
}

// ---------- duplicate / copy / paste / z-order / align ----------
// A full copy of an item, offset by (dx, dy): same geometry, colour
// and width, with its own behaviour layers (fresh ids, so the copy
// never shares layer state with the source) and its own behaviour
// groups (members remapped to the copied layers). Same pattern as the
// eraser's split pieces.
function cloneItemWithOffset(it: Item, dx: number, dy: number): Item {
  const copy = JSON.parse(JSON.stringify(it)) as Item;
  copy.id = nid();
  const layerMap = new Map<string, string>();
  copy.layers = copy.layers.map((l) => {
    const id = nid();
    layerMap.set(l.id, id);
    return { ...l, id };
  });
  copy.groups = copy.groups.map((g) => ({
    ...g,
    id: nid(),
    members: g.members.map((m) => layerMap.get(m)).filter((m): m is string => typeof m === 'string'),
  })).filter((g) => g.members.length > 0);
  copy.stash = JSON.parse(JSON.stringify(copy.stash)) as ItemBase['stash'];
  if (copy.type === 'stroke') copy.points = copy.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  else { copy.x += dx; copy.y += dy; }
  return copy;
}
// Duplicate the current selection: every item is copied at +16/+16
// and the copies are selected. When the selection is exactly one
// item group, the group is duplicated too — new group, copied
// members, copied group layers. Duplicating a picked-out member
// (shift-clicked out of its group) copies just that member.
function duplicateSelection(): void {
  const sel = selectedItems();
  if (sel.length === 0) return;
  pushHistory();
  const copies = new Map<string, Item>();
  for (const it of sel) {
    const c = cloneItemWithOffset(it, 16, 16);
    copies.set(it.id, c);
    items.push(c);
  }
  const grp = selectedItemGroup();
  if (grp) {
    const layerMap = new Map<string, string>();
    const layers = grp.layers.map((l) => { const id = nid(); layerMap.set(l.id, id); return { ...l, id }; });
    itemGroups.push({
      id: nid(),
      memberIds: grp.memberIds.map((m) => copies.get(m)?.id).filter((m): m is string => typeof m === 'string'),
      layers,
      groups: grp.groups.map((g) => ({
        ...g,
        id: nid(),
        members: g.members.map((m) => layerMap.get(m)).filter((m): m is string => typeof m === 'string'),
      })).filter((g) => g.members.length > 0),
    });
  }
  selectedIds = [...copies.values()].map((c) => c.id);
  save();
  renderPanel();
}
// In-app clipboard only — never the system clipboard, so pasting
// into another app (or from it) is untouched. Copy stores deep
// copies of the selection; a group is stored only when all its
// members are selected, otherwise just the picked members.
type Clipboard = { items: Item[]; groups: ItemGroup[] };
let clipboard: Clipboard | null = null;
let pasteCount = 0; // pastes since the last copy; each paste offsets a further +16
function copySelection(): void {
  const sel = selectedItems();
  if (sel.length === 0) return;
  const ids = new Set(sel.map((i) => i.id));
  clipboard = {
    items: JSON.parse(JSON.stringify(sel)) as Item[],
    groups: JSON.parse(JSON.stringify(itemGroups.filter((g) => g.memberIds.every((m) => ids.has(m))))) as ItemGroup[],
  };
  pasteCount = 0;
}
function pasteClipboard(): void {
  if (!clipboard || clipboard.items.length === 0) return;
  pushHistory();
  pasteCount += 1;
  const dx = 16 * pasteCount, dy = 16 * pasteCount;
  const copies = new Map<string, Item>();
  for (const it of clipboard.items) {
    const c = cloneItemWithOffset(it, dx, dy);
    copies.set(it.id, c);
    items.push(c);
  }
  for (const g of clipboard.groups) {
    const layerMap = new Map<string, string>();
    const layers = g.layers.map((l) => { const id = nid(); layerMap.set(l.id, id); return { ...l, id }; });
    itemGroups.push({
      id: nid(),
      memberIds: g.memberIds.map((m) => copies.get(m)?.id).filter((m): m is string => typeof m === 'string'),
      layers,
      groups: g.groups.map((bg) => ({
        ...bg,
        id: nid(),
        members: bg.members.map((m) => layerMap.get(m)).filter((m): m is string => typeof m === 'string'),
      })).filter((bg) => bg.members.length > 0),
    });
  }
  selectedIds = [...copies.values()].map((c) => c.id);
  save();
  renderPanel();
}
// Selection expanded to z-order units: a grouped item drags its
// whole group along (members keep their relative order), so a member
// can never be reordered out of its group by this.
type ZUnit = { items: Item[] };
function selectionUnits(): ZUnit[] {
  const units: ZUnit[] = [];
  const seenGroups = new Set<string>();
  for (const it of selectedItems()) {
    const g = itemGroupOf(it.id);
    if (g) {
      if (seenGroups.has(g.id)) continue;
      seenGroups.add(g.id);
      units.push({ items: g.memberIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i) });
    } else units.push({ items: [it] });
  }
  return units;
}
// Reorder the selection in the stack (items order = draw order, last
// draws on top). A unit moves as a block: its members keep their
// relative order and the block swaps past one neighbour for a
// one-step move. Returns false (and pushes no history) when the move
// would change nothing.
function reorderSelection(mode: 'front' | 'forward' | 'backward' | 'back'): boolean {
  const units = selectionUnits();
  if (units.length === 0) return false;
  const unitIds = new Set(units.flatMap((u) => u.items.map((i) => i.id)));
  const block = items.filter((i) => unitIds.has(i.id)); // unit items, in current stack order
  const rest = items.filter((i) => !unitIds.has(i.id));
  let next: Item[];
  if (mode === 'front') next = [...rest, ...block];
  else if (mode === 'back') next = [...block, ...rest];
  else if (mode === 'forward') {
    const topIdx = Math.max(...block.map((i) => items.indexOf(i)));
    if (topIdx >= items.length - 1) return false;
    const above = items[topIdx + 1];
    const at = rest.indexOf(above);
    next = [...rest.slice(0, at + 1), ...block, ...rest.slice(at + 1)];
  } else {
    const botIdx = Math.min(...block.map((i) => items.indexOf(i)));
    if (botIdx <= 0) return false;
    const below = items[botIdx - 1];
    const at = rest.indexOf(below);
    next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  }
  if (next.every((it, i) => it === items[i])) return false;
  pushHistory();
  items = next;
  save();
  renderPanel();
  return true;
}
// Align the selection's units to an edge/centre of the selection's
// bounding box (stored geometry — the document truth, same as drags).
// A group aligns as a whole: its members move together by one delta.
function alignSelection(mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): boolean {
  const units = selectionUnits();
  if (units.length < 2) return false;
  const boxes = units.map((u) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of u.items) {
      const b = itemBBox(it);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    return { x0, y0, x1, y1 };
  });
  const sx0 = Math.min(...boxes.map((b) => b.x0)), sy0 = Math.min(...boxes.map((b) => b.y0));
  const sx1 = Math.max(...boxes.map((b) => b.x1)), sy1 = Math.max(...boxes.map((b) => b.y1));
  const deltas = boxes.map((b) => {
    switch (mode) {
      case 'left': return { dx: sx0 - b.x0, dy: 0 };
      case 'center': return { dx: (sx0 + sx1) / 2 - (b.x0 + b.x1) / 2, dy: 0 };
      case 'right': return { dx: sx1 - b.x1, dy: 0 };
      case 'top': return { dx: 0, dy: sy0 - b.y0 };
      case 'middle': return { dx: 0, dy: (sy0 + sy1) / 2 - (b.y0 + b.y1) / 2 };
      case 'bottom': return { dx: 0, dy: sy1 - b.y1 };
    }
  });
  if (deltas.every((d) => d.dx === 0 && d.dy === 0)) return false;
  pushHistory();
  units.forEach((u, i) => { for (const it of u.items) moveItem(it, deltas[i].dx, deltas[i].dy); });
  save();
  renderPanel();
  return true;
}

// One shared tooltip for the Arrange/Align hints: a small frosted pill
// above the hovered button. Custom, not the native `title` (which would
// double up). Shown after a short hover delay; hidden on mouseleave,
// click, panel re-render, panel scroll and window resize. A click also
// suppresses any re-show while the mouse stays put: the action
// re-renders the panel, which recreates the button under a stationary
// cursor and would otherwise re-trigger the hover immediately.
let tooltipTimer: number | null = null;
let lastTooltipClick = 0;
function closeTooltipEl(): void {
  if (tooltipTimer !== null) { window.clearTimeout(tooltipTimer); tooltipTimer = null; }
  document.querySelector('.tip')?.remove();
}
function attachTooltip(btn: HTMLButtonElement, text: string): void {
  btn.addEventListener('mouseenter', () => {
    if (btn.disabled) return;
    closeTooltipEl();
    tooltipTimer = window.setTimeout(() => {
      tooltipTimer = null;
      if (Date.now() - lastTooltipClick < 1000) return;
      const r = btn.getBoundingClientRect();
      const tip = document.createElement('div');
      tip.className = 'tip';
      tip.textContent = text;
      document.body.appendChild(tip);
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
      const above = r.top - 6 - h;
      tip.style.left = `${left}px`;
      tip.style.top = `${above >= 8 ? above : r.bottom + 6}px`;
    }, 400);
  });
  btn.addEventListener('mouseleave', () => { closeTooltipEl(); });
  btn.addEventListener('click', () => { closeTooltipEl(); lastTooltipClick = Date.now(); });
}

// Hairline divider separating the Arrange/Align block from the
// Group/Behaviours controls below it — the same hairline as under
// the section headers.
function panelDivider(): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'pdiv';
  d.setAttribute('aria-hidden', 'true');
  return d;
}

// Two or more items selected (and not one group): the count and a
// Group button, in the quiet pill style of "Add behavior".
function renderArrangeSection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'psection';
  const h = document.createElement('h3');
  h.textContent = 'Arrange';
  sec.appendChild(h);
  const row = document.createElement('div');
  row.className = 'seg';
  const units = selectionUnits();
  const unitIds = new Set(units.flatMap((u) => u.items.map((i) => i.id)));
  const idxs = items.map((it, i) => (unitIds.has(it.id) ? i : -1)).filter((i) => i >= 0);
  const atTop = idxs.length > 0 && Math.max(...idxs) === items.length - 1;
  const atBottom = idxs.length > 0 && Math.min(...idxs) === 0;
  const defs: { mode: 'front' | 'forward' | 'backward' | 'back'; label: string; disabled: boolean }[] = [
    { mode: 'front', label: 'Bring to Front', disabled: atTop },
    { mode: 'forward', label: 'Bring Forward', disabled: atTop },
    { mode: 'backward', label: 'Send Backward', disabled: atBottom },
    { mode: 'back', label: 'Send to Back', disabled: atBottom },
  ];
  defs.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.innerHTML = ARRANGE_ICONS[i];
    b.setAttribute('aria-label', d.label);
    attachTooltip(b, d.label);
    b.disabled = d.disabled;
    b.addEventListener('click', () => { reorderSelection(d.mode); });
    row.appendChild(b);
  });
  sec.appendChild(row);
  return sec;
}
function renderAlignSection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'psection';
  const h = document.createElement('h3');
  h.textContent = 'Align';
  sec.appendChild(h);
  const row = document.createElement('div');
  row.className = 'seg';
  const defs: { mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'; label: string }[] = [
    { mode: 'left', label: 'Align Left' },
    { mode: 'center', label: 'Align Centre' },
    { mode: 'right', label: 'Align Right' },
    { mode: 'top', label: 'Align Top' },
    { mode: 'middle', label: 'Align Middle' },
    { mode: 'bottom', label: 'Align Bottom' },
  ];
  defs.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.innerHTML = ALIGN_ICONS[i];
    b.setAttribute('aria-label', d.label);
    attachTooltip(b, d.label);
    b.addEventListener('click', () => { alignSelection(d.mode); });
    row.appendChild(b);
  });
  sec.appendChild(row);
  return sec;
}
function renderMultiSelectPanel(sel: Item[]): void {
  panelTitle.textContent = 'Selection';
  const count = document.createElement('div');
  count.className = 'sel-count';
  count.textContent = `${sel.length} selected`;
  panelBody.appendChild(count);
  panelBody.appendChild(renderArrangeSection());
  panelBody.appendChild(renderAlignSection());
  panelBody.appendChild(panelDivider());
  const action = document.createElement('div');
  action.className = 'group-action';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pbtn-quiet';
  btn.textContent = 'Group objects';
  btn.setAttribute('aria-label', `Group ${sel.length} objects`);
  btn.addEventListener('click', () => { groupSelection(); });
  action.appendChild(btn);
  panelBody.appendChild(action);
}

// A selected item group: its own behaviour layer stack — the same
// layer cards, checkable grouping flow and Add behavior picker as an
// item's stack — plus an Ungroup button for the item group itself.
// The two kinds of group stay distinct by label: "Group behaviours"
// groups layers, "Ungroup objects" dissolves the item group.
function renderItemGroupPanel(group: ItemGroup): void {
  panelTitle.textContent = 'Behaviours';
  panelBody.appendChild(renderArrangeSection());
  panelBody.appendChild(panelDivider());
  const host: LayerHost = { kind: 'group', group };
  appendStackEntries(host);
  if (group.layers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-behaviours';
    empty.textContent = 'No behaviours';
    panelBody.appendChild(empty);
  }
  appendGroupBehavioursAction(host);
  panelBody.appendChild(panelDivider());
  const action = document.createElement('div');
  action.className = 'group-action';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pbtn-quiet';
  btn.textContent = 'Ungroup objects';
  btn.setAttribute('aria-label', 'Ungroup objects');
  btn.addEventListener('click', () => { ungroupItemGroup(group); });
  action.appendChild(btn);
  panelBody.appendChild(action);
  panelBody.appendChild(renderAddBehaviourButton(host));
}

function closeExportDropdownEl(): void {
  document.querySelector('.export-dropdown')?.remove();
}

// The Export card itself, unchanged from the bordered-card round:
// PNG and Video are tabs at its top, the active tab's content sits
// below them. No Scale, no Frame. Built fresh on every render, so
// tab switches and format picks re-render through renderPanel.
function renderExportCard(): HTMLDivElement {
  const card = document.createElement('div');
  card.id = 'export-card';
  const tabs = document.createElement('div');
  tabs.className = 'seg';
  tabs.id = 'export-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Export');
  const tabBtns: HTMLButtonElement[] = [];
  for (const t of [{ id: 'png', label: 'PNG' }, { id: 'video', label: 'Video' }] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = exportTab === t.id ? 'active' : '';
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', exportTab === t.id ? 'true' : 'false');
    b.addEventListener('click', () => {
      if (exportTab === t.id) return;
      exportTab = t.id;
      save();
      renderPanel();
    });
    tabs.appendChild(b);
    tabBtns.push(b);
  }
  card.appendChild(tabs);
  let actionBtn: HTMLButtonElement | null = null;
  const fmtBtns: HTMLButtonElement[] = [];
  if (exportTab === 'png') {
    actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'pbtn';
    actionBtn.id = 'export-png-btn';
    actionBtn.textContent = 'Export PNG';
    actionBtn.addEventListener('click', () => { void exportPNGSequence(); });
    card.appendChild(actionBtn);
  } else {
    // Video format: the small segmented control above the action
    // button. The choice persists (videoFormat) like before.
    const fmtSeg = document.createElement('div');
    fmtSeg.className = 'seg';
    fmtSeg.id = 'video-format-seg';
    fmtSeg.setAttribute('role', 'group');
    fmtSeg.setAttribute('aria-label', 'Video format');
    for (const f of [{ id: 'gif', label: 'GIF' }, { id: 'webm', label: 'WebM' }, { id: 'mp4', label: 'MP4' }] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = videoFormat === f.id ? 'active' : '';
      b.textContent = f.label;
      b.setAttribute('aria-label', `Video format ${f.label}`);
      b.addEventListener('click', () => {
        if (videoFormat === f.id) return;
        videoFormat = f.id;
        save();
        renderPanel();
      });
      fmtSeg.appendChild(b);
      fmtBtns.push(b);
    }
    card.appendChild(fmtSeg);
    actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'pbtn';
    actionBtn.id = 'export-video-btn';
    actionBtn.textContent = `Export ${videoFormat === 'gif' ? 'GIF' : videoFormat === 'webm' ? 'WebM' : 'MP4'}`;
    actionBtn.addEventListener('click', () => { void exportVideo(); });
    card.appendChild(actionBtn);
  }
  if (exporting) {
    for (const b of tabBtns) b.disabled = true;
    for (const b of fmtBtns) b.disabled = true;
    if (actionBtn) actionBtn.disabled = true;
    // An offline export (PNG sequence, GIF, MP4) shows its progress on
    // the action button; a WebM recording has no progress to show.
    if (exportProgress && actionBtn) actionBtn.textContent = exportProgress.text;
    else if (actionBtn && exportTab === 'video') actionBtn.textContent = 'Recording…';
  }
  return card;
}

// The Export dropdown: the card in a frosted popover anchored below
// the Export button, like the Add behavior picker. Fixed-position so
// it floats above the panel content and never pushes it down; flips
// above the button when there is no room below.
function renderExportDropdown(anchorBtn: HTMLElement): void {
  closeExportDropdownEl();
  const pop = document.createElement('div');
  pop.className = 'export-dropdown';
  pop.setAttribute('role', 'menu');
  pop.appendChild(renderExportCard());
  document.body.appendChild(pop);
  const r = anchorBtn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = (r.bottom + 6 + h > window.innerHeight) ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function renderCanvasPanel(): void {
  panelTitle.textContent = 'Canvas';
  const mkSection = (label: string): HTMLDivElement => {
    const sec = document.createElement('div');
    sec.className = 'psection';
    const h = document.createElement('h3');
    h.textContent = label;
    sec.appendChild(h);
    panelBody.appendChild(sec);
    return sec;
  };
  const stageSec = mkSection('Stage');
  const stageSeg = document.createElement('div');
  stageSeg.className = 'seg';
  stageSeg.setAttribute('role', 'group');
  stageSeg.setAttribute('aria-label', 'Stage size');
  for (const s of STAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = stageId === s.id ? 'active' : '';
    b.textContent = s.label;
    b.setAttribute('aria-label', `Stage ${s.label}`);
    b.addEventListener('click', () => {
      if (stageId === s.id) return;
      pushHistory();
      stageId = s.id;
      save();
      resizeCanvas();
      renderPanel();
    });
    stageSeg.appendChild(b);
  }
  stageSec.appendChild(stageSeg);
  const loopSec = mkSection('Loop');
  const loopSeg = document.createElement('div');
  loopSeg.className = 'seg';
  loopSeg.setAttribute('role', 'group');
  loopSeg.setAttribute('aria-label', 'Loop length');
  for (const len of LOOP_LENGTHS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = loopLength === len ? 'active' : '';
    b.textContent = `${len}s`;
    b.setAttribute('aria-label', `Loop ${len} seconds`);
    b.addEventListener('click', () => {
      if (loopLength === len) return;
      pushHistory();
      loopLength = len;
      playTime = playTime % loopMs();
      save();
      renderPanel();
    });
    loopSeg.appendChild(b);
  }
  loopSec.appendChild(loopSeg);
  const bgSec = mkSection('Background');
  const bgDots = document.createElement('div');
  bgDots.className = 'bg-dots';
  if (stageBgId === 'custom' && stageBgCustom) {
    const b = document.createElement('button');
    b.className = 'bg-dot active';
    b.style.background = stageBgCustom;
    b.title = 'Custom';
    b.setAttribute('aria-label', 'Background custom colour');
    bgDots.appendChild(b);
  }
  for (const bg of STAGE_BGS) {
    const b = document.createElement('button');
    b.className = 'bg-dot' + (stageBgId === bg.id ? ' active' : '');
    b.style.background = bg.value;
    b.title = bg.label;
    b.setAttribute('aria-label', `Background ${bg.label}`);
    b.addEventListener('click', () => {
      if (stageBgId === bg.id && stageBgCustom === null) return;
      pushHistory();
      stageBgId = bg.id;
      stageBgCustom = null;
      save();
      resizeCanvas();
      renderPanel();
    });
    bgDots.appendChild(b);
  }
  bgSec.appendChild(bgDots);
  const gridSec = mkSection('Grid');
  const gridTiles = document.createElement('div');
  gridTiles.className = 'grid-tiles';
  gridTiles.setAttribute('role', 'group');
  gridTiles.setAttribute('aria-label', 'Grid');
  for (const g of GRID_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'grid-tile' + (gridMode === g.id ? ' active' : '');
    b.title = g.label;
    b.setAttribute('aria-label', `Grid ${g.label}`);
    b.innerHTML = g.svg;
    b.addEventListener('click', () => {
      if (gridMode === g.id) return;
      pushHistory();
      gridMode = g.id;
      save();
      renderPanel();
    });
    gridTiles.appendChild(b);
  }
  gridSec.appendChild(gridTiles);
  const actionsSec = mkSection('Actions');
  const mkAction = (label: string, id: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pbtn';
    b.id = id;
    b.textContent = label;
    b.addEventListener('click', fn);
    actionsSec.appendChild(b);
    return b;
  };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveBtn = mkAction('Save', 'save-btn', () => {
    save();
    saveBtn.textContent = 'Saved';
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
  });
  // Export is a button with a chevron; clicking it opens a dropdown
  // holding the bordered card (PNG / Video tabs). The dropdown is an
  // overlay, so Clear never moves when it opens.
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'pbtn export-btn' + (exportDropdownOpen ? ' open' : '');
  exportBtn.id = 'export-btn';
  exportBtn.setAttribute('aria-haspopup', 'true');
  exportBtn.setAttribute('aria-expanded', String(exportDropdownOpen));
  exportBtn.innerHTML = '<span>Export</span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdownOpen = !exportDropdownOpen;
    renderPanel();
  });
  actionsSec.appendChild(exportBtn);
  if (exportDropdownOpen) renderExportDropdown(exportBtn);
  mkAction('Clear', 'clear-btn', clearStage);
}

// ---------- colour panel ----------
// Clicking a swatch opens this view for that slot: hue ring +
// saturation/value square, hex, recent colours, saved palette.
function renderColourPanel(): void {
  panelTitle.textContent = 'Colour';
  const hsv = hexToHsv(slotColour()) ?? { h: 0, s: 0, v: 0.12 };
  let hue = hsv.h;
  if (colourHue360 && hue === 0) hue = 360;
  let sat = hsv.s;
  let val = hsv.v;
  const applyDraft = (commit: boolean): void => {
    const hex = hsvToHex(hue, sat, val);
    if (activeSlot === 'fg') color = hex; else bgColour = hex;
    const front = toolbar.querySelector('.dswatch.front') as HTMLElement | null;
    const backSw = toolbar.querySelector('.dswatch.back') as HTMLElement | null;
    if (front) front.style.background = color;
    if (backSw) backSw.style.background = bgColour;
    const hexInput = panelBody.querySelector('.hex-input') as HTMLInputElement | null;
    if (hexInput && document.activeElement !== hexInput) hexInput.value = hex;
    if (commit) {
      pushRecent(hex);
      save();
      renderToolbar();
      renderPanel();
    }
  };
  // Saturation / value square.
  const svSquare = document.createElement('div');
  svSquare.className = 'sv-square';
  svSquare.setAttribute('aria-label', 'Saturation and value');
  svSquare.style.backgroundColor = `hsl(${Math.round(hue)}, 100%, 50%)`;
  const svMarker = document.createElement('span');
  svMarker.className = 'sv-marker';
  svSquare.appendChild(svMarker);
  const placeSvMarker = (): void => {
    svMarker.style.left = `calc(${sat * 100}% - 6px)`;
    svMarker.style.top = `calc(${(1 - val) * 100}% - 6px)`;
  };
  placeSvMarker();
  const svFromEvent = (e: PointerEvent): void => {
    const rect = svSquare.getBoundingClientRect();
    sat = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    val = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    placeSvMarker();
    applyDraft(false);
  };
  svSquare.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { svSquare.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    svFromEvent(e);
    const onMove = (ev: PointerEvent): void => svFromEvent(ev);
    const onUp = (): void => {
      svSquare.removeEventListener('pointermove', onMove);
      svSquare.removeEventListener('pointerup', onUp);
      svSquare.removeEventListener('pointercancel', onUp);
      applyDraft(true);
    };
    svSquare.addEventListener('pointermove', onMove);
    svSquare.addEventListener('pointerup', onUp);
    svSquare.addEventListener('pointercancel', onUp);
  });
  panelBody.appendChild(svSquare);
  // Hue bar: a horizontal full-spectrum strip under the square, with a
  // thumb showing the current hue. Dragging it changes hue only.
  const hueBar = document.createElement('div');
  hueBar.className = 'hue-bar';
  hueBar.setAttribute('aria-label', 'Hue');
  const hueThumb = document.createElement('span');
  hueThumb.className = 'hue-thumb';
  hueBar.appendChild(hueThumb);
  const placeHueThumb = (): void => {
    hueThumb.style.left = `calc(${(hue / 360) * 100}% - 7px)`;
  };
  placeHueThumb();
  const hueFromEvent = (e: PointerEvent): void => {
    const rect = hueBar.getBoundingClientRect();
    hue = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 360;
    colourHue360 = hue >= 360;
    placeHueThumb();
    svSquare.style.backgroundColor = `hsl(${Math.round(hue)}, 100%, 50%)`;
    applyDraft(false);
  };
  hueBar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { hueBar.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    hueFromEvent(e);
    const onMove = (ev: PointerEvent): void => hueFromEvent(ev);
    const onUp = (): void => {
      hueBar.removeEventListener('pointermove', onMove);
      hueBar.removeEventListener('pointerup', onUp);
      hueBar.removeEventListener('pointercancel', onUp);
      applyDraft(true);
    };
    hueBar.addEventListener('pointermove', onMove);
    hueBar.addEventListener('pointerup', onUp);
    hueBar.addEventListener('pointercancel', onUp);
  });
  panelBody.appendChild(hueBar);
  // Hex field.
  const hexRow = document.createElement('div');
  hexRow.className = 'hex-row';
  const hexInput = document.createElement('input');
  hexInput.className = 'hex-input';
  hexInput.type = 'text';
  hexInput.value = slotColour();
  hexInput.setAttribute('aria-label', 'Hex colour');
  hexInput.spellcheck = false;
  const commitHex = (): void => {
    const h = normHex(hexInput.value);
    if (!h) { hexInput.value = slotColour(); return; }
    const hsv2 = hexToHsv(h);
    if (!hsv2) { hexInput.value = slotColour(); return; }
    hue = hsv2.h; sat = hsv2.s; val = hsv2.v;
    colourHue360 = false;
    if (activeSlot === 'fg') color = h; else bgColour = h;
    pushRecent(h);
    save();
    renderToolbar();
    renderPanel();
  };
  hexInput.addEventListener('change', commitHex);
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitHex(); hexInput.blur(); }
    e.stopPropagation();
  });
  hexRow.appendChild(hexInput);
  panelBody.appendChild(hexRow);
  // Recent colours.
  const mkChips = (label: string, list: string[]): HTMLDivElement => {
    const sec = document.createElement('div');
    sec.className = 'psection';
    const h = document.createElement('h3');
    h.textContent = label;
    sec.appendChild(h);
    const row = document.createElement('div');
    row.className = 'colour-chips';
    if (list.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'colour-empty';
      empty.textContent = label === 'Saved palette' ? 'No saved colours' : 'No recent colours';
      row.appendChild(empty);
    }
    for (const c of list) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'colour-chip';
      chip.style.background = c;
      chip.title = c;
      chip.setAttribute('aria-label', `Use colour ${c}`);
      chip.addEventListener('click', () => {
        const hsv2 = hexToHsv(c);
        if (hsv2) { hue = hsv2.h; sat = hsv2.s; val = hsv2.v; }
        colourHue360 = false;
        if (activeSlot === 'fg') color = c; else bgColour = c;
        pushRecent(c);
        save();
        renderToolbar();
        renderPanel();
      });
      row.appendChild(chip);
    }
    sec.appendChild(row);
    panelBody.appendChild(sec);
    return row;
  };
  mkChips('Recent', recentColours);
  const savedRow = mkChips('Saved palette', savedColours);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'pbtn-quiet';
  saveBtn.textContent = 'Save current colour';
  saveBtn.addEventListener('click', () => {
    const hex = slotColour().toLowerCase();
    if (!savedColours.includes(hex)) savedColours.push(hex);
    save();
    renderPanel();
    void savedRow;
  });
  panelBody.appendChild(saveBtn);
}

// ---------- pointer ----------
// Pointer to stage coordinates: the canvas covers the whole workspace,
// so subtract the stage origin and divide by the stage scale. Points
// outside the stage map to negative or over-size stage coordinates —
// that is where pasteboard items live. Clamped to the workspace rect,
// so a drag (which keeps firing under pointer capture) cannot carry an
// item out of the visible centre area, under the toolbar, panel or
// player.
function stagePoint(e: { clientX: number; clientY: number }): Pt {
  const rect = canvas.getBoundingClientRect();
  const { s, ox, oy, cw, ch, r } = workspaceLayout();
  // Undo the view rotation first: rotate the screen point back around
  // the workspace centre, then the usual origin/scale mapping. The
  // clamp below is in unrotated workspace space, which bounds the
  // visible region either way.
  let x = e.clientX - rect.left, y = e.clientY - rect.top;
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
// the inverse of stagePoint — origin and scale, then the view
// rotation around the workspace centre.
function stageToScreen(p: Pt): Pt {
  const { s, ox, oy, cw, ch, r } = workspaceLayout();
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
let drag: {
  kind: 'brush' | 'shape' | 'select' | 'erase' | 'marquee';
  start: Pt; last: Pt; item: Item | null; moved: boolean;
  before: string | null; // pre-gesture snapshot, for lazy history (move / erase)
  erased: boolean; // the eraser actually removed ink during this sweep
} | null = null;
let previewShape: ShapeItem | null = null;
let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  // Pan: middle-button drag, or Space+left-drag. It is never a tool
  // gesture — no selection change, no item, no undo entry — so it is
  // intercepted before the pointer is mapped to stage coordinates
  // and before the double-click bookkeeping below.
  if (e.button === 1 || (spaceHeld && e.button === 0)) {
    e.preventDefault();
    panDrag = { x: e.clientX, y: e.clientY, panX, panY };
    updateCursor();
    return;
  }
  // Rotate: R+left-drag turns the view around the workspace centre.
  // Same interception as pan — never a tool gesture, no selection
  // change, no item, no undo entry. The drag angle is measured from
  // the centre, so the stage turns under the pointer like paper on
  // a desk. Space wins if both modifiers are held.
  if (rotateHeld && e.button === 0) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    rotateDrag = { startAngle: Math.atan2(e.clientY - cy, e.clientX - cx), startDeg: rotateDeg };
    updateCursor();
    return;
  }
  const p = stagePoint(e);
  // The second press of a double-click pair (same spot, <400ms) is a
  // repeat, not a new action: paint and the text editor must not fire
  // twice for one double-click.
  lastPressRepeat = lastDown !== null && Date.now() - lastDown.t < 400 &&
    Math.hypot(p.x - lastDown.x, p.y - lastDown.y) < 8;
  lastDown = { t: Date.now(), x: p.x, y: p.y };
  if (tool === 'brush') {
    pushHistory();
    const stroke: StrokeItem = { ...baseItem(color, penWidth), type: 'stroke', points: [p] };
    items.push(stroke);
    drag = { kind: 'brush', start: p, last: p, item: stroke, moved: false, before: null, erased: false };
  } else if (tool === 'paint') {
    if (!lastPressRepeat) paintAt(p);
    drag = null;
  } else if (tool === 'shape') {
    drag = { kind: 'shape', start: p, last: p, item: null, moved: false, before: null, erased: false };
  } else if (tool === 'eraser') {
    // Lazy history: capture the pre-state now, commit it on pointerup
    // only if the sweep actually erased ink.
    const before = gestureStart();
    const erased = eraseAt(p);
    drag = { kind: 'erase', start: p, last: p, item: null, moved: false, before, erased };
  } else if (tool === 'select') {
    const hit = hitTest(p);
    if (hit) {
      if (e.shiftKey) {
        // Shift-click toggles that single item in/out of the
        // selection, even when it belongs to a group — this is how a
        // single member is picked out of a group to edit its own
        // behaviours.
        selectedIds = selectedIds.includes(hit.id)
          ? selectedIds.filter((id) => id !== hit.id)
          : [...selectedIds, hit.id];
        if (focusedId === hit.id && !selectedIds.includes(hit.id)) focusedId = null;
        renderPanel();
        drag = null;
      } else {
        // Plain click: a group member selects its whole group — even
        // when the member was picked out alone before (shift-click or
        // double-click). Only when the group itself is already the
        // selection, or the item is already selected alone, does the
        // click keep the selection, so the drag below can move it.
        const g = itemGroupOf(hit.id);
        const groupSelected = !!g && g.memberIds.length === selectedIds.length &&
          g.memberIds.every((m) => selectedIds.includes(m));
        if (g && !groupSelected) {
          selectedIds = [...g.memberIds];
          renderPanel();
        } else if (!selectedIds.includes(hit.id)) {
          selectedIds = [hit.id];
          renderPanel();
        }
        drag = { kind: 'select', start: p, last: p, item: hit, moved: false, before: gestureStart(), erased: false };
      }
    } else {
      // Empty workspace: start a marquee. A click without moving
      // deselects on release; a drag selects what the rectangle
      // touches (see pointerup).
      drag = { kind: 'marquee', start: p, last: p, item: null, moved: false, before: null, erased: false };
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (panDrag) {
    // Pan moves in screen pixels, not stage coordinates — the drag
    // delta is added to the pan directly, then clamped.
    panX = panDrag.panX + (e.clientX - panDrag.x);
    panY = panDrag.panY + (e.clientY - panDrag.y);
    clampPan();
    return;
  }
  if (rotateDrag) {
    // Rotate follows the pointer's angle around the workspace centre,
    // not its distance: dragging a quarter-turn around the centre
    // turns the view 90°. Rotation is around the centre, so it can
    // never fling the stage out of view the way a pan could.
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const a = Math.atan2(e.clientY - cy, e.clientX - cx);
    rotateDeg = normDeg(rotateDrag.startDeg + (a - rotateDrag.startAngle) * 180 / Math.PI);
    updateZoomLabel();
    return;
  }
  if (!drag) return;
  const p = stagePoint(e);
  if (drag.kind === 'brush' && drag.item?.type === 'stroke') {
    // The stored path keeps the raw pointer samples — deliberately NOT
    // interpolated. The midpoint-quadratic render below rounds each
    // joint by an amount that follows the segment length, so sparse
    // fast samples smooth out; filling the gaps first makes the path
    // dense and shrinks that rounding to ~2px, leaving the corners
    // sharp (measured: a 5-sample arc stored as 129 interpolated
    // points still rendered with visible corners at 3x).
    drag.item.points.push(p);
    drag.moved = true;
  } else if (drag.kind === 'shape') {
    const x = Math.min(drag.start.x, p.x), y = Math.min(drag.start.y, p.y);
    previewShape = {
      ...baseItem(color, penWidth), type: 'shape', kind: shapeKind,
      x, y, w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y), fillSolid: false,
    };
    drag.moved = true;
  } else if (drag.kind === 'erase') {
    // Erase continuously along the sweep, not only at sampled points:
    // a fast sweep jumps 20px+ between pointermove events, and without
    // interpolation it would leave stripes of unerased ink behind.
    const step = Math.max(2, penWidth / 2);
    const d = Math.hypot(p.x - drag.last.x, p.y - drag.last.y);
    const n = Math.max(1, Math.ceil(d / step));
    for (let s = 1; s <= n; s++) {
      if (eraseAt({ x: drag.last.x + (p.x - drag.last.x) * (s / n), y: drag.last.y + (p.y - drag.last.y) * (s / n) })) drag.erased = true;
    }
    drag.last = p;
  } else if (drag.kind === 'select' && drag.item) {
    const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    if (dx !== 0 || dy !== 0) drag.moved = true;
    // Move the whole selection together: one clamp for the union box,
    // so the items keep their relative positions. One undo entry per
    // drag (committed on release).
    const sel = selectedItems();
    const c = clampMoveUnion(sel, dx, dy);
    for (const it of sel) moveItem(it, c.dx, c.dy);
    drag.last = p;
  } else if (drag.kind === 'marquee') {
    marquee = { x0: drag.start.x, y0: drag.start.y, x1: p.x, y1: p.y };
    if (Math.abs(p.x - drag.start.x) > 4 || Math.abs(p.y - drag.start.y) > 4) drag.moved = true;
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (panDrag) {
    // A pan is view state, not a document change: no history entry,
    // no save, nothing moved.
    panDrag = null;
    updateCursor();
    return;
  }
  if (rotateDrag) {
    // A rotation is view state too: no history entry, no save,
    // nothing moved.
    rotateDrag = null;
    updateCursor();
    return;
  }
  if (!drag) return;
  const p = stagePoint(e);
  if (drag.kind === 'shape' && previewShape && previewShape.w > 4 && previewShape.h > 4) {
    pushHistory();
    items.push(previewShape);
  }
  // A move is one undo entry, committed on release — a click without
  // moving adds nothing. Same for an erase sweep over empty space.
  if (drag.kind === 'select' && drag.moved) {
    if (drag.before) gestureCommit(drag.before, true);
    save();
  }
  if (drag.kind === 'marquee') {
    if (drag.moved && marquee) {
      // Select every item the rectangle touches, individually —
      // regardless of groups. The rectangle is drawn over what the
      // user sees, so items are tested by their rendered (animated)
      // bbox, not their stored one.
      const t01 = playTime / loopMs();
      const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
      selectedIds = items.filter((it) => {
        const b = renderedBBox(it, t01);
        return b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0;
      }).map((it) => it.id);
    } else {
      // A click on empty workspace deselects and exits focus, as before.
      selectedIds = [];
      if (focusedId !== null) focusedId = null;
    }
    marquee = null;
  }
  if (drag.kind === 'erase') {
    if (drag.before) gestureCommit(drag.before, drag.erased);
  }
  if (drag.kind === 'brush' || drag.kind === 'erase' || drag.kind === 'shape') save(); // shapes were lost on reload until the next save — they never saved on creation
  previewShape = null;
  drag = null;
  renderPanel();
});
// A cancelled pointer ends a pan or rotate drag without applying
// anything further; tool drags already tolerate a missing pointerup.
canvas.addEventListener('pointercancel', () => {
  if (panDrag) { panDrag = null; updateCursor(); }
  if (rotateDrag) { rotateDrag = null; updateCursor(); }
});
// Wheel over the workspace pans the view — trackpad two-finger
// scroll included, like scrolling a document (content moves against
// the scroll direction). Zoom stays on the buttons and Cmd/Ctrl+=/-/0.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = e.deltaMode === 1 ? 16 : 1; // line mode: ~16px a line
  panX -= e.deltaX * f;
  panY -= e.deltaY * f;
  clampPan();
}, { passive: false });
// Paint bucket: a shape fills solid with the foreground colour;
// a stroke or text is recoloured; empty stage fills the stage
// background with the foreground colour. Clicking empty workspace
// outside the stage does nothing — the bucket fills the stage, not
// the pasteboard. Undo restores it.
function paintAt(p: Pt): void {
  const hit = hitTest(p);
  if (!hit) {
    const { w, h } = stageSize();
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) return;
  }
  pushHistory();
  if (!hit) {
    stageBgCustom = color;
    stageBgId = 'custom';
    save();
    resizeCanvas();
    renderPanel();
    return;
  }
  hit.color = color;
  if (hit.type === 'shape') hit.fillSolid = true;
  save();
  renderPanel();
}
// The eraser acts like the pen: it removes only the ink under it, not
// the whole item it touches. Eraser radius is the brush size (penWidth).
// A stroke loses the points within the radius and splits into
// contiguous runs, each run of 2+ points becoming its own stroke item
// inheriting the original's colour, width, layers and groups (with
// fresh ids, so pieces never share layer state). A run of 1 point is
// dropped, unless the original was a single-point stroke. A shape
// becomes its outline polyline on first contact, then splits the same
// way, so a grazing touch never deletes a whole shape. Text has no
// partial erasure: touching it deletes the whole item. Returns true
// when anything was actually erased.
function eraseAt(p: Pt): boolean {
  const radius = penWidth;
  let changed = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'text') {
      const b = itemBBox(it);
      if (p.x >= b.x - radius && p.x <= b.x + b.w + radius && p.y >= b.y - radius && p.y <= b.y + b.h + radius) {
        items.splice(i, 1);
        if (selectedIds.includes(it.id)) selectedIds = selectedIds.filter((id) => id !== it.id);
        // The erased layers' eased amplitudes stay in `smoothed`: undo
        // restores this item, and its pose must come back exactly
        // instead of re-easing from 0.
        changed = true;
      }
      continue;
    }
    const rawPts: Pt[] = it.type === 'stroke' ? it.points : shapeOutline(it);
    // Densify first, so a sparse polyline (a two-point leg, a rectangle
    // edge) can be erased in the middle, not only at stored points.
    const pts = densify(rawPts, Math.max(3, radius / 2));
    const runs: Pt[][] = [];
    let cur: Pt[] = [];
    let removed = 0;
    for (const pt of pts) {
      if (Math.hypot(pt.x - p.x, pt.y - p.y) > radius) cur.push(pt);
      else {
        removed++;
        if (cur.length) { runs.push(cur); cur = []; }
      }
    }
    if (cur.length) runs.push(cur);
    if (removed === 0) continue;
    changed = true;
    const survivors = runs.filter((r) => r.length >= 2 || (it.type === 'stroke' && it.points.length === 1));
    const replacements: StrokeItem[] = survivors.map((run) => {
      const base = baseItem(it.color, it.width);
      const layerIdMap = new Map<string, string>();
      base.layers = it.layers.map((l) => {
        const id = nid();
        layerIdMap.set(l.id, id);
        return { ...l, id };
      });
      base.groups = it.groups.map((g) => ({
        ...g,
        id: nid(),
        members: g.members.map((m) => layerIdMap.get(m)).filter((m): m is string => typeof m === 'string'),
      })).filter((g) => g.members.length > 0);
      base.stash = JSON.parse(JSON.stringify(it.stash)) as ItemBase['stash'];
      return { ...base, type: 'stroke', points: run };
    });
    // The old layers' eased amplitudes stay (see above): split pieces
    // get fresh layer ids, and undo of the erase restores the original
    // item at its exact pose.
    items.splice(i, 1, ...replacements);
    if (selectedIds.includes(it.id)) {
      selectedIds = selectedIds.filter((id) => id !== it.id).concat(replacements.map((r) => r.id));
    }
  }
  pruneItemGroups();
  if (changed) renderPanel();
  return changed;
}
function moveItem(it: Item, dx: number, dy: number): void {
  if (it.type === 'stroke') it.points.forEach((pt) => { pt.x += dx; pt.y += dy; });
  else if (it.type === 'shape') { it.x += dx; it.y += dy; }
  else { it.x += dx; it.y += dy; }
}
// A dragged selection stays inside the visible workspace: clamp the
// move so the UNION bounding box of all selected items never crosses
// the workspace edge (under the toolbar, panel or player). The stage
// itself is inside the workspace, so parts can still straddle the
// stage edge freely. One clamp for the union keeps the items' relative
// positions; clamping each item separately would squash them together
// at the edge.
function clampMoveUnion(sel: Item[], dx: number, dy: number): { dx: number; dy: number } {
  const { s, ox, oy, cw, ch } = workspaceLayout();
  const minX = -ox / s, maxX = (cw - ox) / s;
  const minY = -oy / s, maxY = (ch - oy) / s;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of sel) {
    const b = itemBBox(it);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (!sel.length) return { dx: 0, dy: 0 };
  let cx = dx, cy = dy;
  if (x0 + cx < minX) cx = minX - x0;
  if (x1 + cx > maxX) cx = maxX - x1;
  if (y0 + cy < minY) cy = minY - y0;
  if (y1 + cy > maxY) cy = maxY - y1;
  return { dx: cx, dy: cy };
}

// Draw the in-progress shape preview on top of the normal frame,
// in stage coordinates like everything else.
function renderWithPreview(t01: number): void {
  renderFrame(t01);
  if (previewShape) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const L = workspaceLayout();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rotateView(ctx, L);
    ctx.translate(L.ox, L.oy);
    ctx.scale(L.s, L.s);
    ctx.strokeStyle = previewShape.color;
    ctx.lineWidth = previewShape.width;
    ctx.setLineDash([5, 4]);
    if (previewShape.kind === 'rect') ctx.strokeRect(previewShape.x, previewShape.y, previewShape.w, previewShape.h);
    else ctx.beginPath(), ctx.ellipse(previewShape.x + previewShape.w / 2, previewShape.y + previewShape.h / 2, previewShape.w / 2, previewShape.h / 2, 0, 0, Math.PI * 2), ctx.stroke();
    ctx.restore();
  }
  if (marquee) {
    const L = workspaceLayout();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rotateView(ctx, L);
    ctx.translate(L.ox, L.oy);
    ctx.scale(L.s, L.s);
    ctx.fillStyle = 'rgba(0, 122, 255, 0.06)';
    ctx.strokeStyle = '#007aff';
    ctx.lineWidth = 1 / L.s;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

// ---------- text ----------
// One editor session at a time, tracked at module level. Opening a new
// one finishes the open one first: without this, a second open while
// one is pending leaves two finish closures, and the next blur/Enter
// creates the text twice.
let textSession: { it: TextItem | null; p: Pt } | null = null;
function closeTextEditor(commit: boolean): void {
  const s = textSession;
  if (!s) return;
  textSession = null; // first, so a re-entrant close cannot run twice
  textEditor.style.display = 'none';
  const value = textEditor.value.trim();
  if (commit && value) {
    if (s.it) {
      if (value !== s.it.text) { pushHistory(); s.it.text = value; }
    } else {
      pushHistory();
      const item: TextItem = { ...baseItem(color, penWidth), type: 'text', x: s.p.x, y: s.p.y, text: value, size: 20 };
      items.push(item);
      selectedIds = [item.id];
    }
    save();
    renderPanel();
  }
}
function openTextEditor(it: TextItem | null, p: Pt): void {
  if (textSession) closeTextEditor(true);
  // The editor sits in the stage-wrap (the workspace), so position it
  // by the stage origin and scale — like the text it edits.
  const L = workspaceLayout();
  textEditor.style.display = 'block';
  // Positioned in stage space, so it follows zoom, pan and rotation
  // like everything else on the canvas.
  const sp = stageToScreen({ x: it ? it.x : p.x, y: it ? it.y - it.size : p.y - 20 });
  textEditor.style.left = `${sp.x}px`;
  textEditor.style.top = `${sp.y}px`;
  textEditor.style.fontSize = `${20 * L.s}px`;
  textEditor.style.width = '220px';
  textEditor.value = it ? it.text : '';
  textSession = { it, p };
  textEditor.focus();
  textEditor.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeTextEditor(true); }
    if (ev.key === 'Escape') closeTextEditor(false);
    ev.stopPropagation();
  };
}
// Clicking away commits the text.
textEditor.addEventListener('blur', () => closeTextEditor(true));
// The browser's mousedown default moves focus to the clicked element:
// on the canvas (not focusable) that blurs the text editor the
// pointerdown handler just opened and focused, closing it at once.
// Prevent it while the text tool is active.
canvas.addEventListener('mousedown', (e) => {
  if (tool === 'text') e.preventDefault();
});
canvas.addEventListener('dblclick', (e) => {
  const p = stagePoint(e);
  const hit = hitTest(p);
  // Double-click focuses a part: it stays full opacity, everything else
  // dims to 0.1. Double-clicking the focused part again, or empty stage,
  // exits focus. The text and paint tools keep their click meanings, so
  // focus only applies with the other tools. A double-click never opens
  // the text editor — text is created only by a single click with the
  // Text tool.
  if (tool === 'text' || tool === 'paint') return;
  if (hit) {
    if (focusedId === hit.id) focusedId = null;
    else focusedId = hit.id;
    selectedIds = [hit.id];
    renderPanel();
    return;
  }
  if (focusedId !== null) {
    focusedId = null;
    selectedIds = [];
    renderPanel();
  }
});
canvas.addEventListener('pointerdown', (e) => {
  if (tool === 'text') {
    if (lastPressRepeat) return; // second press of a double-click pair
    const p = stagePoint(e);
    const hit = hitTest(p);
    if (hit?.type === 'text') { selectedIds = [hit.id]; openTextEditor(hit, p); }
    else openTextEditor(null, p);
  }
});

// ---------- header / panel actions ----------
(document.getElementById('undo-btn') as HTMLButtonElement).addEventListener('click', undo);
(document.getElementById('redo-btn') as HTMLButtonElement).addEventListener('click', redo);
(document.getElementById('zoom-in') as HTMLButtonElement).addEventListener('click', () => zoomStep(1));
(document.getElementById('zoom-out') as HTMLButtonElement).addEventListener('click', () => zoomStep(-1));
(document.getElementById('zoom-label') as HTMLButtonElement).addEventListener('click', () => resetView());
function clearStage(): void {
  if (items.length === 0) return;
  pushHistory();
  items = [];
  itemGroups = [];
  selectedIds = [];
  smoothed.clear();
  save();
  renderPanel();
}
const PLAY_ICON = '<svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 12 12"><path d="M2.5 2h2.6v8H2.5zM6.9 2h2.6v8H6.9z"/></svg>';
function setPlayLabel(): void {
  playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  playBtn.classList.toggle('playing', playing);
  playBtn.title = playing ? 'Pause' : 'Play';
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
playBtn.addEventListener('click', () => {
  playing = !playing;
  setPlayLabel();
  if (playing) lastTs = 0;
});
backBtn.addEventListener('click', () => { playTime = 0; });
stopBtn.addEventListener('click', () => {
  playing = false;
  playTime = 0;
  setPlayLabel();
});
forwardBtn.addEventListener('click', () => { playTime = loopMs() - 1; });
// PNG export writes a sequence of one PNG per frame over one full loop
// (30fps, stage size), into a folder the user picks. Frames render
// offline to an offscreen canvas — the on-screen canvas and play state
// are left alone, and exports never carry the grid, focus dimming or
// selection outline (renderFrame gates those to the on-screen target).
async function exportPNGSequence(): Promise<void> {
  if (exporting) return;
  const bridge = window.manakin;
  if (!bridge) return; // folder picking needs Electron
  const dir = await bridge.pickSequenceFolder();
  if (!dir) return; // user cancelled the folder dialog
  exporting = true;
  exportProgress = null;
  renderPanel();
  try {
    const { w, h } = stageSize();
    const n = Math.max(1, Math.round((loopMs() / 1000) * 30));
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    for (let i = 0; i < n; i++) {
      renderFrame(i / n, octx, 1);
      const dataUrl = off.toDataURL('image/png');
      await bridge.writeSequenceFile(dir, `frame-${String(i + 1).padStart(4, '0')}.png`, dataUrl);
      setExportProgress(`Exporting ${i + 1}/${n}`, 'png');
    }
  } finally {
    exporting = false;
    exportProgress = null;
    renderPanel();
  }
}
// Video export: GIF, WebM or MP4, one full loop at 30fps, stage size,
// artwork only. The format is picked in the Actions area; no other
// parameters.
async function exportVideo(): Promise<void> {
  if (exporting) return;
  if (videoFormat === 'gif') { await exportGIF(); return; }
  if (videoFormat === 'mp4') { await exportMP4(); return; }
  await exportWebM();
}
// GIF: animated, looping forever. Frames render offline the same way as
// the PNG sequence; gifenc quantizes each frame to a 256-colour palette.
// GIF delays are stored in 10ms units, so the per-frame delay alternates
// 30/40ms to average exactly 1/30s.
async function exportGIF(): Promise<void> {
  exporting = true;
  renderPanel();
  try {
    const { w, h } = stageSize();
    const n = Math.max(1, Math.round((loopMs() / 1000) * 30));
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    const gif = GIFEncoder();
    for (let i = 0; i < n; i++) {
      renderFrame(i / n, octx, 1);
      const img = octx.getImageData(0, 0, w, h);
      const palette = quantize(img.data, 256);
      const index = applyPalette(img.data, palette);
      const delay = (Math.round(((i + 1) * 10) / 3) - Math.round((i * 10) / 3)) * 10;
      gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
      setExportProgress(`Exporting ${i + 1}/${n}`, 'video');
    }
    gif.finish();
    downloadBlob(new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }), 'manakin.gif');
  } finally {
    exporting = false;
    exportProgress = null;
    renderPanel();
  }
}
// MP4: H.264 via WebCodecs (VideoEncoder) + mp4-muxer, both JS-only.
// Chromium cannot do this with MediaRecorder. If this build has no
// H.264 encoder, isConfigSupported says so and nothing is exported.
async function exportMP4(): Promise<void> {
  if (typeof VideoEncoder === 'undefined') return;
  const { w, h } = stageSize();
  const config: VideoEncoderConfig = {
    codec: 'avc1.42001f', width: w, height: h,
    bitrate: 8_000_000, framerate: 30, avc: { format: 'avc' },
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) return;
  exporting = true;
  renderPanel();
  try {
    const n = Math.max(1, Math.round((loopMs() / 1000) * 30));
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: 30 },
      fastStart: 'in-memory',
    });
    let encoderError: Error | null = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encoderError = e; },
    });
    encoder.configure(config);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    for (let i = 0; i < n; i++) {
      renderFrame(i / n, octx, 1);
      const frame = new VideoFrame(off, { timestamp: (i * 1e6) / 30 });
      encoder.encode(frame, { keyFrame: i === 0 });
      frame.close();
      setExportProgress(`Exporting ${i + 1}/${n}`, 'video');
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 10));
    }
    await encoder.flush();
    encoder.close();
    if (encoderError) throw encoderError;
    muxer.finalize();
    downloadBlob(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'manakin.mp4');
  } finally {
    exporting = false;
    exportProgress = null;
    renderPanel();
  }
}
// WebM: the existing path — one full loop, recorded in real time to an
// offscreen canvas at stage size. The on-screen canvas and play state
// are left alone.
async function exportWebM(): Promise<void> {
  if (exporting) return;
  exporting = true;
  renderPanel();
  const { w, h } = stageSize();
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  const stream = off.captureStream(30);
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
  const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  rec.start(100);
  const L = loopMs();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const el = performance.now() - start;
      if (el >= L) { renderFrame(0, octx, 1); resolve(); return; }
      renderFrame(el / L, octx, 1);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;
  downloadBlob(new Blob(chunks, { type: 'video/webm' }), 'manakin.webm');
  exporting = false;
  renderPanel();
}
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  // The synthetic click must not bubble to the document: the
  // outside-click handler would read it as a click outside the
  // Export dropdown and close it mid-download.
  a.addEventListener('click', (e) => e.stopPropagation());
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'c') { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); pasteClipboard(); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'BracketRight') { e.preventDefault(); reorderSelection(e.shiftKey ? 'front' : 'forward'); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'BracketLeft') { e.preventDefault(); reorderSelection(e.shiftKey ? 'back' : 'backward'); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'Equal') { e.preventDefault(); zoomStep(1); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'Minus') { e.preventDefault(); zoomStep(-1); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'Digit0') { e.preventDefault(); resetView(); return; }
  // Space held over the workspace is the pan modifier: the cursor
  // turns to a grab hand (see updateCursor) and the next drag pans
  // instead of starting a tool gesture. Repeat events are ignored;
  // the keyup below clears it.
  if (k === ' ' && !e.repeat) { e.preventDefault(); spaceHeld = true; updateCursor(); return; }
  // R held is the rotate modifier, like Space is for pan: the cursor
  // turns to a grab hand and the next drag rotates the view around
  // the workspace centre. No Ctrl/Cmd/Alt — those belong to the
  // browser (Ctrl/Cmd+R reloads). Typing in an input is already
  // guarded by the check at the top of this handler.
  if (k === 'r' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); rotateHeld = true; updateCursor(); return; }
  if (k === 'escape') {
    if (addPickerOpen) { addPickerOpen = false; renderPanel(); return; }
    if (exportDropdownOpen) { exportDropdownOpen = false; closeExportDropdownEl(); renderPanel(); return; }
    if (focusedId !== null) { focusedId = null; renderPanel(); return; }
    if (selectedIds.length > 0) { selectedIds = []; renderPanel(); return; }
    if (panelView === 'colour') { panelView = 'auto'; renderPanel(); }
    return;
  }
  if (k === 'delete' || k === 'backspace') {
    const sel = selectedItems();
    if (sel.length > 0) {
      pushHistory();
      const ids = new Set(sel.map((i) => i.id));
      items = items.filter((i) => !ids.has(i.id));
      selectedIds = [];
      if (focusedId !== null && ids.has(focusedId)) focusedId = null;
      pruneItemGroups();
      save(); renderPanel();
    }
    return;
  }
  if (k === 'v') tool = 'select';
  else if (k === 'p') tool = 'brush';
  else if (k === 'b') tool = 'paint';
  else if (k === 'x') { swapColors(); return; }
  else if (k === 'e') { if (tool === 'shape') shapeKind = shapeKind === 'rect' ? 'ellipse' : 'rect'; tool = 'shape'; }
  else if (k === 't') tool = 'text';
  else return;
  renderToolbar();
  updateCursor();
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceHeld = false; updateCursor(); }
  if (e.key.toLowerCase() === 'r') { rotateHeld = false; updateCursor(); }
});
// Losing the window while Space or R is held (or mid-pan, mid-rotate)
// must not leave the grab hand stuck on.
window.addEventListener('blur', () => {
  spaceHeld = false;
  panDrag = null;
  rotateHeld = false;
  rotateDrag = null;
  updateCursor();
});

// The Add behavior list closes on a click anywhere else, on Escape
// (handled above), or when the panel switches — it lives in the panel
// flow, so scrolling and resizing leave it alone. The Export
// dropdown closes the same way.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null;
  if (addPickerOpen) {
    if (t && t.closest('.add-wrap')) return;
    addPickerOpen = false;
    renderPanel();
    return;
  }
  if (exportDropdownOpen) {
    if (t && t.closest('.export-dropdown, #export-btn')) return;
    exportDropdownOpen = false;
    closeExportDropdownEl();
    renderPanel();
    return;
  }
});
panelBody.addEventListener('scroll', () => {
  if (!exportDropdownOpen) return;
  exportDropdownOpen = false;
  closeExportDropdownEl();
  renderPanel();
}, { passive: true });
// A tooltip is anchored to a button rect that moves with the panel,
// so it hides on scroll or resize rather than going stale.
panelBody.addEventListener('scroll', () => { closeTooltipEl(); }, { passive: true });
window.addEventListener('resize', () => { closeTooltipEl(); });
window.addEventListener('resize', () => {
  if (!exportDropdownOpen) return;
  exportDropdownOpen = false;
  closeExportDropdownEl();
  renderPanel();
});

// ---------- init ----------
load();
projectInput.value = projectName;
renderPanel();
setPlayLabel();
applyPanelOpen();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(frame);


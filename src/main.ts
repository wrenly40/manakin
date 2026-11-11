import './styles.css';

// The frameless window's controls, exposed by electron/preload.ts.
// Absent when the page runs outside Electron (e.g. vite preview).
type ManakinBridge = {
  platform: string;
  quit: () => Promise<void>;
  minimise: () => Promise<void>;
  maximise: () => Promise<boolean>;
  fullscreen: () => Promise<boolean>;
  windowState: () => Promise<{ maximised: boolean; fullscreen: boolean }>;
};
declare global {
  interface Window { manakin?: ManakinBridge; }
}

type Pt = { x: number; y: number };
type BehaviourName = 'Bob' | 'Sway' | 'Breathe' | 'Blink' | 'Spin' | 'Wander';
const BEHAVIOURS: BehaviourName[] = ['Bob', 'Sway', 'Breathe', 'Blink', 'Spin', 'Wander'];
// One behaviour cycle at tempo 1x lasts 4s; a tempo of tx makes it 4/t s.
// Tempo is stepped: only powers of two, so the ratio of any two tempos is
// an integer and every behaviour completes a whole number of cycles in the
// loop (see loopMs / loopCycles below).
const BASE_CYCLE_MS = 4000;
const TEMPO_STOPS = [0.25, 0.5, 1, 2];
function snapTempo(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  if (v <= 0.25) return 0.25;
  if (v >= 2) return 2;
  let best = TEMPO_STOPS[0], bestD = Math.abs(v - TEMPO_STOPS[0]);
  for (const s of TEMPO_STOPS) {
    const d = Math.abs(v - s);
    if (d <= bestD) { best = s; bestD = d; } // exact ties go to the higher stop
  }
  return best;
}
function stopAt(i: number): number {
  return TEMPO_STOPS[Math.max(0, Math.min(TEMPO_STOPS.length - 1, Math.round(i)))];
}
function tempoStopIndex(t: number): number {
  return TEMPO_STOPS.indexOf(snapTempo(t));
}
function formatTempoStop(s: number): string {
  return `${s.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x`;
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
];

type BehaviourGroup = {
  id: string;
  name: string;
  members: string[]; // layer ids; a layer belongs to at most one group
  active: boolean; // group off suspends its members without losing their own on/off states
  tempo: number; // one of TEMPO_STOPS, multiplies each member's tempo
  amplitude: number; // 0-1, scales each member's amplitude
};
// One layer = one instance of a behaviour on one item. The same behaviour
// can appear several times in a stack, each instance with its own id and
// its own parameters; only the parameters relevant to its behaviour are
// used (Blink also uses blinkDuration, Spin also spinReverse, Wander also
// wanderSmooth).
type LayerParams = {
  on: boolean;
  tempo: number; // one of TEMPO_STOPS
  amplitude: number; // 0-1
  offset: number; // 0-1 shift of the motion within its own cycle
  blinkDuration: number; // % of the cycle the blink bump spans (Blink only)
  spinReverse: boolean; // Spin only: run the spin backwards
  wanderSmooth: number; // 0-100% (Wander only); 50+ is the smooth drift
};
type BehaviourLayer = LayerParams & {
  id: string; // unique within the item; never reused
  behaviour: number; // 0-5, index into BEHAVIOURS
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
type GridMode = 'dots' | 'lines' | 'off';
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
  return { on: true, tempo: 1, amplitude: 0.66, offset: 0, blinkDuration: 26, spinReverse: false, wanderSmooth: 50 };
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
let selectedId: string | null = null;
// Double-click focus (view state only — never saved, never an undo entry):
// the focused part renders full, every other part at 0.1.
let focusedId: string | null = null;
let lastFocusExitAt = 0; // when focus was last exited by a single click on empty stage
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
let stageBgId: StageBgId = 'white';
let stageBgCustom: string | null = null;
let gridMode: GridMode = 'off';
let projectName = 'Untitled';
let panelOpen = true;
let panelView: 'auto' | 'colour' = 'auto';
let colourSlot: 'fg' | 'bg' = 'fg';
let expandedLayerId: string | null = null;
let expandedGroup: string | null = null; // id of the open group in the Behaviours panel
let addPickerOpen = false; // the Add behavior popover is showing
let checkedLayers: Set<string> = new Set(); // top-level layer ids picked for grouping
let checkedItemId: string | null = null; // the item the checked rows belong to
let recentColours: string[] = [];
let savedColours: string[] = [];
let playing = false;
let playTime = 0; // ms within the loop, frozen when paused
let lastTs = 0;
let history: string[] = [];
let redoStack: string[] = [];
const smoothed = new Map<string, number>(); // layer id -> smoothed amplitude 0..1

function stageSize(): { w: number; h: number } {
  const s = STAGES.find((s) => s.id === stageId) ?? STAGES[0];
  return { w: s.w, h: s.h };
}
function selected(): Item | null {
  return items.find((i) => i.id === selectedId) ?? null;
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
      items, stageId, projectName, stageBgId, stageBgCustom, gridMode, panelOpen,
      fg: color, bg: bgColour, penWidth, recent: recentColours, saved: savedColours,
    }));
  } catch { /* storage full or unavailable */ }
}
function snapshot(): string {
  // The whole document state: items, stage size, background and grid.
  // Tool settings (pen width, colours, project name) are not document
  // state and stay out of undo.
  return JSON.stringify({ items, stageId, stageBgId, stageBgCustom, gridMode });
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
    } else if (data && typeof data === 'object') {
      const d = data as {
        items?: Item[]; stageId?: typeof stageId; stageBgId?: StageBgId;
        stageBgCustom?: string | null; gridMode?: GridMode;
      };
      if (Array.isArray(d.items)) items = d.items;
      if (d.stageId === 'wide' || d.stageId === 'square' || d.stageId === 'portrait') stageId = d.stageId;
      if (d.stageBgId) stageBgId = d.stageBgId;
      stageBgCustom = typeof d.stageBgCustom === 'string' ? d.stageBgCustom : null;
      if (d.gridMode === 'dots' || d.gridMode === 'lines' || d.gridMode === 'off') gridMode = d.gridMode;
    }
  } catch { /* corrupted history entry: keep current items */ }
  items.forEach(migrateItem); // undo snapshots from older saves may lack the newer parameter fields
  if (selectedId && !items.some((i) => i.id === selectedId)) selectedId = null;
  smoothed.clear();
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
    // to hard-code, so the preset bird blinks exactly as before.
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

function migrateItem(it: Item): void {
  const anyIt = it as unknown as Record<string, unknown>;
  const clampNum = (v: unknown, min: number, max: number, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : dflt;
  // Merge saved params with the current defaults, clamping them. Migration
  // is keyed on FIELD PRESENCE: an old save stores percents under `amount`
  // (66 = 66%) and `phase` (50 = half a loop) and a continuous `speed`,
  // while a new save stores fractions under `amplitude`/`offset` and a
  // stepped `tempo` — so an old amount of 1 (1%) and a new amplitude of 1
  // (full) are told apart by the field name, never by the value.
  const cleanParams = (p: Partial<LayerParams>): LayerParams => {
    const legacy = p as Partial<LayerParams> & { amount?: unknown; phase?: unknown; speed?: unknown };
    return {
      on: typeof p.on === 'boolean' ? p.on : true,
      tempo: typeof p.tempo === 'number' ? snapTempo(p.tempo) : (typeof legacy.speed === 'number' ? snapTempo(legacy.speed) : 1),
      amplitude: typeof p.amplitude === 'number'
        ? clampNum(p.amplitude, 0, 1, 0.66)
        : clampNum(legacy.amount, 0, 100, 66) / 100,
      offset: typeof p.offset === 'number'
        ? clampNum(p.offset, 0, 1, 0)
        : clampNum(legacy.phase, 0, 100, 0) / 100,
      blinkDuration: clampNum(p.blinkDuration, 10, 60, 26),
      spinReverse: p.spinReverse === true,
      wanderSmooth: clampNum(p.wanderSmooth, 0, 100, 50),
    };
  };
  // New format: layers are instances with ids (an empty array is a valid
  // empty stack). Just validate, in place.
  const layersAreInstances = Array.isArray(it.layers) &&
    (it.layers.length === 0 || (typeof it.layers[0] === 'object' && it.layers[0] !== null));
  if (layersAreInstances) {
    const seenIds = new Set<string>();
    const clean: BehaviourLayer[] = [];
    for (const raw of it.layers as unknown[]) {
      const l = (raw ?? {}) as Partial<BehaviourLayer>;
      if (typeof l.behaviour !== 'number' || !Number.isInteger(l.behaviour) || l.behaviour < 0 || l.behaviour >= BEHAVIOURS.length) continue;
      let id = typeof l.id === 'string' && l.id ? l.id : nid();
      if (seenIds.has(id)) id = nid();
      seenIds.add(id);
      clean.push({ id, behaviour: l.behaviour, ...cleanParams(l) });
    }
    it.layers = clean;
    const ids = new Set(clean.map((l) => l.id));
    const seenMember = new Set<string>();
    it.groups = (Array.isArray(it.groups) ? it.groups : []).map((raw) => {
      const g = (raw ?? {}) as Partial<BehaviourGroup>;
      const legacy = g as Partial<BehaviourGroup> & { speed?: unknown; amount?: unknown };
      const members = (Array.isArray(g.members) ? g.members : [])
        .filter((m): m is string => typeof m === 'string' && ids.has(m) && !seenMember.has(m));
      members.forEach((m) => seenMember.add(m));
      if (members.length === 0) return null;
      return {
        id: typeof g.id === 'string' && g.id ? g.id : nid(),
        name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Group',
        members: [...new Set(members)],
        active: typeof g.active === 'boolean' ? g.active : true,
        tempo: typeof g.tempo === 'number' ? snapTempo(g.tempo) : (typeof legacy.speed === 'number' ? snapTempo(legacy.speed) : 1),
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
  let active = [false, false, false, false, false, false];
  if (Array.isArray(anyIt.pattern)) {
    const grid = anyIt.pattern as boolean[][];
    active = BEHAVIOURS.map((_, b) => Array.isArray(grid[b]) && grid[b].some(Boolean));
  } else if (Array.isArray(anyIt.active) && anyIt.active.length === BEHAVIOURS.length) {
    active = (anyIt.active as unknown[]).map((v) => v === true);
  }
  const tempos = (Array.isArray(anyIt.speeds) && anyIt.speeds.length === BEHAVIOURS.length
    ? (anyIt.speeds as unknown[]).map((v) => snapTempo(v)) : [1, 1, 1, 1, 1, 1]);
  const amounts = (Array.isArray(anyIt.amounts) && anyIt.amounts.length === BEHAVIOURS.length
    ? (anyIt.amounts as unknown[]).map((a) => {
        const n = typeof a === 'number' ? a : NaN;
        return n === 0.5 ? 33 : n === 1 ? 66 : n === 2 ? 100 : n > 2 ? n : 66;
      }) : [66, 66, 66, 66, 66, 66]);
  const phases = (Array.isArray(anyIt.phases) && anyIt.phases.length === BEHAVIOURS.length
    ? (anyIt.phases as unknown[]).map((p) => (typeof p === 'number' && p >= 0 && p <= 100 ? p : 0)) : [0, 0, 0, 0, 0, 0]);
  const blinkDuration = clampNum(anyIt.blinkDuration, 10, 60, 26);
  const spinReverse = anyIt.spinReverse === true;
  const wanderSmooth = clampNum(anyIt.wanderSmooth, 0, 100, 50);
  const paramsOf = (b: number): LayerParams => ({
    on: active[b], tempo: tempos[b], amplitude: amounts[b] / 100, offset: phases[b] / 100,
    blinkDuration, spinReverse, wanderSmooth,
  });
  const hasCustom = (b: number): boolean =>
    tempos[b] !== 1 || amounts[b] !== 66 || phases[b] !== 0 ||
    (b === 3 && blinkDuration !== 26) ||
    (b === 4 && spinReverse === true) ||
    (b === 5 && wanderSmooth !== 50);
  // Groups: flat only, a behaviour in at most one group, members valid and
  // ascending. Members are behaviour indices here; they become layer ids below.
  const seen = new Set<number>();
  const oldGroups = (Array.isArray(anyIt.groups) ? anyIt.groups : []).map((raw) => {
    const g = (raw ?? {}) as Partial<BehaviourGroup>;
    const legacy = g as Partial<BehaviourGroup> & { speed?: unknown; amount?: unknown };
    const rawMembers = (Array.isArray(g.members) ? g.members : []) as unknown[];
    const members = rawMembers
      .filter((m): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 0 && m < BEHAVIOURS.length && !seen.has(m));
    members.forEach((m) => seen.add(m));
    return {
      id: typeof g.id === 'string' && g.id ? g.id : nid(),
      name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Group',
      members: [...members].sort((a, b) => a - b),
      active: typeof g.active === 'boolean' ? g.active : true,
      tempo: typeof g.tempo === 'number' ? snapTempo(g.tempo) : (typeof legacy.speed === 'number' ? snapTempo(legacy.speed) : 1),
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
    oldStack = [...new Set((anyIt.layers as number[]).filter((m) => m >= 0 && m < BEHAVIOURS.length))];
  } else {
    oldStack = BEHAVIOURS.map((_, b) => b).filter((b) => active[b] || hasCustom(b));
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
  for (let b = 0; b < BEHAVIOURS.length; b++) if (!indexToId.has(b) && hasCustom(b)) stash[b] = paramsOf(b);
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
        items: Item[]; stageId: typeof stageId; projectName?: string;
        stageBgId?: StageBgId; stageBgCustom?: string | null; gridMode?: GridMode; panelOpen?: boolean;
        fg?: string; bg?: string; penWidth?: number; recent?: string[]; saved?: string[];
      };
      if (Array.isArray(data.items) && data.items.length > 0) {
        items = data.items;
        items.forEach(migrateItem);
        if (data.stageId) stageId = data.stageId;
        if (typeof data.projectName === 'string' && data.projectName.trim()) projectName = data.projectName;
        if (data.stageBgId && (STAGE_BGS.some((b) => b.id === data.stageBgId) || data.stageBgId === 'custom')) stageBgId = data.stageBgId;
        if (typeof data.stageBgCustom === 'string') stageBgCustom = data.stageBgCustom;
        if (data.gridMode === 'dots' || data.gridMode === 'lines' || data.gridMode === 'off') gridMode = data.gridMode;
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
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / stageSize().w;
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
function hitTest(p: Pt): Item | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'stroke') {
      const tol = Math.max(8, it.width + 4);
      for (let s = 0; s < it.points.length - 1; s++) {
        if (distToSegment(p, it.points[s], it.points[s + 1]) <= tol) return it;
      }
      if (it.points.length === 1 && Math.hypot(p.x - it.points[0].x, p.y - it.points[0].y) <= 10) return it;
      // A closed stroke (the beak triangle) is a filled area: clicking
      // inside it selects it, not only on its outline.
      if (isClosedStroke(it) && pointInPolygon(p, it.points)) return it;
    } else if (it.type === 'shape') {
      // Inside the filled area, not just the bounding box: a click in a
      // bbox corner outside the ellipse must not select it.
      const pad = it.width / 2 + 2;
      if (it.kind === 'rect') {
        if (p.x >= it.x - pad && p.x <= it.x + it.w + pad && p.y >= it.y - pad && p.y <= it.y + it.h + pad) return it;
      } else {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const rx = Math.abs(it.w) / 2 + pad, ry = Math.abs(it.h) / 2 + pad;
        if (rx > 0 && ry > 0 && (((p.x - cx) ** 2) / (rx * rx) + ((p.y - cy) ** 2) / (ry * ry)) <= 1) return it;
      }
    } else {
      const b = itemBBox(it);
      if (p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4) return it;
    }
  }
  return null;
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
function groupOf(it: Item, layer: BehaviourLayer): BehaviourGroup | undefined {
  return it.groups.find((g) => g.members.includes(layer.id));
}
function effActive(it: Item, layer: BehaviourLayer): boolean {
  const g = groupOf(it, layer);
  // Only layers in the stack contribute; a member contributes only when
  // both its own toggle and its group's toggle are on.
  return layer.on && (!g || g.active);
}
function effTempo(it: Item, layer: BehaviourLayer): number {
  const g = groupOf(it, layer);
  return layer.tempo * (g ? g.tempo : 1);
}
function effAmplitude(it: Item, layer: BehaviourLayer): number {
  const g = groupOf(it, layer);
  return layer.amplitude * (g ? g.amplitude : 1);
}
function amplitudeScale(a: number): number {
  // Amplitudes are fractions (0-1); the 1.8 is the peak scale so a
  // full-amplitude layer reaches 1.8 in graph units and (via 0.08/0.35
  // factors) ~11% max scale and ~0.63 rad max rotation in the motion.
  return a * 1.8;
}
// The loop follows the slowest contributing behaviour: an instance
// contributes when it is effectively on and its amplitude is above 0 (an
// amplitude-0 layer moves nothing and must not stretch the loop). Its
// cycle is BASE_CYCLE_MS / effective tempo; the loop is the longest cycle,
// so every contributing instance completes a whole number of cycles in it
// — all effective tempos are powers of two, so every ratio is an integer.
function minContributingTempo(): number | null {
  let min: number | null = null;
  for (const it of items) for (const layer of it.layers) {
    if (!effActive(it, layer) || layer.amplitude <= 0) continue;
    const t = effTempo(it, layer);
    if (min === null || t < min) min = t;
  }
  return min;
}
function loopMs(): number {
  const min = minContributingTempo();
  return min === null ? BASE_CYCLE_MS : BASE_CYCLE_MS / min;
}
// Whole number of cycles an instance completes in one loop. The cycle
// math uses this, so the pose at the wrap equals the pose at the start.
function loopCycles(it: Item, layer: BehaviourLayer): number {
  const min = minContributingTempo();
  return min === null ? 1 : effTempo(it, layer) / min;
}
function smoothedAmp(layer: BehaviourLayer, target: number): number {
  const cur = smoothed.get(layer.id) ?? 0;
  let next = cur + (target - cur) * 0.06;
  if (Math.abs(next - target) < 0.002) next = target;
  smoothed.set(layer.id, next);
  return next;
}
type Motion = { dx: number; dy: number; scale: number; rot: number; opacity: number };
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
  const ph = twoPi * layer.offset;
  const j = wanderJitterAmp(layer.wanderSmooth);
  return {
    x: Math.sin(twoPi * cycles * t01 + ph) + j * Math.sin(twoPi * 2 * cycles * t01 + 0.4 + ph),
    y: Math.sin(twoPi * cycles * t01 + 1.3 + ph) + j * Math.sin(twoPi * 3 * cycles * t01 + 2.1 + ph),
  };
}
function motionFor(it: Item, t01: number): Motion {
  const twoPi = Math.PI * 2;
  let dx = 0, dy = 0, scale = 1, rot = 0, opacity = 1;
  for (const layer of it.layers) {
    const a = smoothedAmp(layer, effActive(it, layer) ? 1 : 0);
    if (a < 0.01) continue;
    const cycles = loopCycles(it, layer);
    const am = amplitudeScale(effAmplitude(it, layer));
    const ph = twoPi * cycles * t01 + twoPi * layer.offset; // Offset shifts the motion within its own cycle
    if (layer.behaviour === 0) dy += a * am * 16 * Math.sin(ph); // Bob
    if (layer.behaviour === 1) dx += a * am * 16 * Math.sin(ph + Math.PI / 2); // Sway
    if (layer.behaviour === 2) scale += a * am * 0.08 * Math.sin(ph); // Breathe
    if (layer.behaviour === 3) opacity -= a * effAmplitude(it, layer) * blinkPulse(ph, layer.blinkDuration); // Blink: depth is the amplitude (0 = never closes, 1 = fully shut)
    if (layer.behaviour === 4) rot += (layer.spinReverse ? -1 : 1) * a * am * 0.35 * Math.sin(ph); // Spin
    if (layer.behaviour === 5) { const w = wanderTerms(layer, cycles, t01); dx += a * am * 18 * w.x; dy += a * am * 14 * w.y; } // Wander
  }
  return { dx, dy, scale, rot, opacity: Math.max(0.05, Math.min(1, opacity)) };
}
// Motion value of one layer over the loop, for the layer graph.
// Reads the same parameters as motionFor, so the graph and the motion agree.
function behaviourValue(it: Item, layer: BehaviourLayer, t01: number): number {
  const twoPi = Math.PI * 2;
  const am = amplitudeScale(effAmplitude(it, layer));
  const cycles = loopCycles(it, layer);
  const ph = twoPi * cycles * t01 + twoPi * layer.offset;
  if (layer.behaviour === 3) return am * blinkPulse(ph, layer.blinkDuration); // Blink: the widened pulse itself, not a square wave
  if (layer.behaviour === 4) return (layer.spinReverse ? -1 : 1) * am * Math.sin(ph); // Spin: mirrors when reversed
  if (layer.behaviour === 5) { const w = wanderTerms(layer, cycles, t01); return am * (w.x + 0.7 * w.y) / 1.7; } // Wander
  return am * Math.sin(ph);
}

// ---------- render ----------
function resizeCanvas(): void {
  canvas.style.background = stageBgValue();
  const { w, h } = stageSize();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.maxWidth = '100%';
  canvas.style.maxHeight = '100%';
  const area = document.getElementById('stage-area')!;
  const aw = area.clientWidth - 48, ah = area.clientHeight - 48;
  const s = Math.min(1, aw / w, ah / h);
  if (s < 1) {
    canvas.style.width = `${Math.floor(w * s)}px`;
    canvas.style.height = `${Math.floor(h * s)}px`;
  }
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
  const m = motionFor(it, t01);
  c.save();
  c.translate(cx + m.dx, cy + m.dy);
  c.rotate(m.rot);
  c.scale(m.scale, m.scale);
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
    else { c.fillStyle = hexToRgba(it.color, 0.12); c.fill(); }
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
  target.save();
  target.scale(dpr, dpr);
  target.clearRect(0, 0, w, h);
  target.fillStyle = stageBgValue();
  target.fillRect(0, 0, w, h);
  if (gridMode !== 'off') {
    const step = 24;
    const gridCol = stageBgId === 'ink' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)';
    if (gridMode === 'dots') {
      target.fillStyle = gridCol;
      for (let x = step; x < w; x += step) {
        for (let y = step; y < h; y += step) target.fillRect(x - 1, y - 1, 2, 2);
      }
    } else {
      target.strokeStyle = gridCol;
      target.lineWidth = 1;
      target.beginPath();
      for (let x = step; x < w; x += step) { target.moveTo(x, 0); target.lineTo(x, h); }
      for (let y = step; y < h; y += step) { target.moveTo(0, y); target.lineTo(w, y); }
      target.stroke();
    }
  }
  for (const it of items) drawItem(target, it, t01, target === ctx);
  const f = validFocus();
  if (target === ctx && selected() && (f === null || selected()!.id === f)) {
    const b = itemBBox(selected()!);
    const m = motionFor(selected()!, t01);
    target.save();
    target.setLineDash([5, 4]);
    target.strokeStyle = '#007aff';
    target.lineWidth = 1.5;
    target.strokeRect(b.x + m.dx - 5, b.y + m.dy - 5, b.w + 10, b.h + 10);
    target.restore();
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

function drawGraph(cv: HTMLCanvasElement, it: Item, layer: BehaviourLayer): void {
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
    const v = behaviourValue(it, layer, t) / maxAmp;
    const x = (t * (W - 4)) + 2;
    const y = H / 2 - v * (H / 2 - 5);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

function renderPanel(): void {
  syncUndoButtons();
  closeAddPickerEl();
  if (panelView !== 'auto' || !selected()) addPickerOpen = false;
  panelBody.innerHTML = '';
  if (panelView === 'colour') { renderColourPanel(); return; }
  const sel = selected();
  if (sel) { renderBehavioursPanel(sel); return; }
  renderCanvasPanel();
}

// Combined graph for a group: the sum of its members' effective motion
// over the loop. Only members that are effectively on (own toggle and
// group toggle) contribute, so a suspended group reads flat. The scale is
// fixed to the sum of the members' own amplitudes (before the group
// multiplier), so changing the group's Amplitude visibly shrinks the curve
// instead of re-normalising it away.
function drawGroupGraph(cv: HTMLCanvasElement, it: Item, group: BehaviourGroup): void {
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
  const members = group.members.map((id) => it.layers.find((l) => l.id === id)).filter((l): l is BehaviourLayer => !!l);
  const vals: number[] = [];
  let scale = 0;
  for (const layer of members) if (effActive(it, layer)) scale += amplitudeScale(layer.amplitude);
  if (scale < 0.01) scale = 1;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let v = 0;
    for (const layer of members) if (effActive(it, layer)) v += behaviourValue(it, layer, t);
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
function layerDisplayName(it: Item, layer: BehaviourLayer): string {
  const same = it.layers.filter((l) => l.behaviour === layer.behaviour);
  if (same.length <= 1) return BEHAVIOURS[layer.behaviour];
  const idx = same.indexOf(layer);
  return idx === 0 ? BEHAVIOURS[layer.behaviour] : `${BEHAVIOURS[layer.behaviour]} ${idx + 1}`;
}

// One behaviour layer row: on/off toggle, name, expand chevron, and — when
// expanded — its graph plus Tempo/Amplitude/Offset and its own extra controls.
// Returns the row and its graph canvas (null while collapsed) so a group
// can redraw member graphs when a group slider moves.
function behaviourLayer(sel: Item, inst: BehaviourLayer, opts: { checkable: boolean; onParamChange?: () => void }): { layer: HTMLDivElement; graph: HTMLCanvasElement | null } {
  const b = inst.behaviour;
  const displayName = layerDisplayName(sel, inst);
  const liveLayer = (): BehaviourLayer | undefined => selected()?.layers.find((l) => l.id === inst.id);
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
    const s = selected();
    if (!s) return;
    removeBehaviourLayer(s, inst.id);
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
      const s = selected();
      const l = s?.layers.find((x) => x.id === inst.id);
      if (s && graph && l) drawGraph(graph, s, l);
      opts.onParamChange?.();
    };
    body.appendChild(paramSlider({
      label: 'Tempo', min: 0, max: TEMPO_STOPS.length - 1, step: 1, value: tempoStopIndex(inst.tempo),
      format: (v) => formatTempoStop(stopAt(v)),
      aria: `${displayName} tempo`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.tempo = stopAt(v); redraw(); },
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
    layer.appendChild(body);
    drawGraph(graph, sel, inst);
  }
  return { layer, graph };
}

// One group row: chevron, name (click to rename inline), on/off toggle,
// ungroup button. When expanded: combined graph, the group's Tempo and
// Amplitude sliders, then the member rows with their own controls.
function groupLayer(sel: Item, group: BehaviourGroup): HTMLDivElement {
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
    input.setAttribute('aria-label', 'Group name');
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
    const s = selected();
    if (!s) return;
    const g = s.groups.find((gg) => gg.id === group.id);
    if (!g) return;
    pushHistory();
    g.active = !g.active;
    save();
    renderPanel();
  });
  const ungroup = document.createElement('button');
  ungroup.type = 'button';
  ungroup.className = 'ungroup-btn';
  ungroup.title = 'Ungroup';
  ungroup.setAttribute('aria-label', `Ungroup ${group.name}`);
  ungroup.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="7" height="12" rx="2"/><rect x="14" y="6" width="7" height="12" rx="2"/></svg>';
  ungroup.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = selected();
    if (!s) return;
    pushHistory();
    s.groups = s.groups.filter((g) => g.id !== group.id);
    if (expandedGroup === group.id) expandedGroup = null;
    save();
    renderPanel();
  });
  head.appendChild(chev);
  head.appendChild(name);
  head.appendChild(toggle);
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
      const s = selected();
      if (s) {
        const g = s.groups.find((gg) => gg.id === group.id);
        if (g) drawGroupGraph(graph, s, g);
      }
    };
    const redrawMemberGraphs = (): void => {
      const s = selected();
      if (!s) return;
      for (const [id, cv] of memberGraphs) {
        const l = s.layers.find((x) => x.id === id);
        if (l) drawGraph(cv, s, l);
      }
    };
    body.appendChild(paramSlider({
      label: 'Tempo', min: 0, max: TEMPO_STOPS.length - 1, step: 1, value: tempoStopIndex(group.tempo),
      format: (v) => formatTempoStop(stopAt(v)),
      aria: `${group.name} tempo`,
      onInput: (v) => { const s = selected(); if (!s) return; const g = s.groups.find((gg) => gg.id === group.id); if (!g) return; g.tempo = stopAt(v); redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Amplitude', min: 0, max: 1, step: 0.01, value: group.amplitude,
      format: (v) => v.toFixed(2),
      aria: `${group.name} amplitude`,
      onInput: (v) => { const s = selected(); if (!s) return; const g = s.groups.find((gg) => gg.id === group.id); if (!g) return; g.amplitude = v; redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => save(),
    }));
    const membersWrap = document.createElement('div');
    membersWrap.className = 'group-members';
    for (const memberId of group.members) {
      const member = sel.layers.find((l) => l.id === memberId);
      if (!member) continue;
      const { layer: mLayer, graph: mGraph } = behaviourLayer(sel, member, {
        checkable: false,
        onParamChange: () => redrawGroupGraph(),
      });
      mLayer.classList.add('in-group');
      if (mGraph) memberGraphs.set(member.id, mGraph);
      membersWrap.appendChild(mLayer);
    }
    body.appendChild(membersWrap);
    layer.appendChild(body);
    drawGroupGraph(graph, sel, group);
  }
  return layer;
}

// Remove a layer from the stack. Its parameters are stashed by behaviour,
// so adding that behaviour again restores them exactly; a later removal of
// the same behaviour overwrites the stash with the most recently removed
// instance. Other instances of the same behaviour are untouched.
// A grouped member leaves its group; an emptied group is removed.
function removeBehaviourLayer(sel: Item, layerId: string): void {
  const layer = sel.layers.find((l) => l.id === layerId);
  if (!layer) return;
  pushHistory();
  sel.stash[layer.behaviour] = {
    on: layer.on, tempo: layer.tempo, amplitude: layer.amplitude, offset: layer.offset,
    blinkDuration: layer.blinkDuration, spinReverse: layer.spinReverse, wanderSmooth: layer.wanderSmooth,
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

// Add a behaviour to the stack. Always a NEW instance, even when one of
// that behaviour is already there. A stashed instance (the most recently
// removed one of this behaviour) restores its parameters; a never-added
// behaviour starts at the defaults.
function addBehaviour(sel: Item, b: number): void {
  pushHistory();
  const stashed = sel.stash[b];
  const layer = stashed
    ? { id: nid(), behaviour: b, ...stashed }
    : newLayer(b);
  if (stashed) delete sel.stash[b];
  sel.layers.push(layer);
  addPickerOpen = false;
  save();
  renderPanel();
}

function closeAddPickerEl(): void {
  document.querySelector('.add-picker')?.remove();
}

// The Add behavior picker: a small popover anchored to the Add button,
// listing all six behaviours with their icons. Every row is always
// enabled: the same behaviour can be added several times, each add
// creating a new instance. Fixed-position so the panel's scroll cannot
// clip it; flips above the button when there is no room below.
function renderAddPicker(anchorBtn: HTMLElement): void {
  closeAddPickerEl();
  const pop = document.createElement('div');
  pop.className = 'add-picker';
  pop.setAttribute('role', 'menu');
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'add-picker-row';
    row.setAttribute('role', 'menuitem');
    row.setAttribute('aria-label', `Add ${BEHAVIOURS[b]}`);
    row.innerHTML = `<span class="layer-icon">${LAYER_ICONS[b]}</span><span class="layer-name">${BEHAVIOURS[b]}</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = selected();
      if (!s) return;
      addBehaviour(s, b);
    });
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  const r = anchorBtn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = (r.bottom + 6 + h > window.innerHeight) ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function renderBehavioursPanel(sel: Item): void {
  panelTitle.textContent = 'Behaviours';
  if (checkedItemId !== sel.id) { checkedLayers.clear(); checkedItemId = sel.id; addPickerOpen = false; }
  const grouped = new Set(sel.groups.flatMap((g) => g.members));
  // Drop checks for layers that left the stack or joined a group.
  for (const id of [...checkedLayers]) if (!sel.layers.some((l) => l.id === id) || grouped.has(id)) checkedLayers.delete(id);
  // Order: each entry sits at its position in the stack, so a group takes
  // the first selected member's place and ungrouping restores members to
  // their original positions.
  type Entry = { pos: number; render: () => HTMLElement };
  const entries: Entry[] = [];
  for (const layer of sel.layers) {
    if (!grouped.has(layer.id)) entries.push({ pos: sel.layers.indexOf(layer), render: () => behaviourLayer(sel, layer, { checkable: true }).layer });
  }
  for (const g of sel.groups) {
    const idxs = g.members.map((id) => sel.layers.findIndex((l) => l.id === id)).filter((i) => i >= 0);
    entries.push({ pos: idxs.length ? Math.min(...idxs) : Number.POSITIVE_INFINITY, render: () => groupLayer(sel, g) });
  }
  entries.sort((a, b) => a.pos - b.pos);
  for (const e of entries) panelBody.appendChild(e.render());
  if (sel.layers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-behaviours';
    empty.textContent = 'No behaviours';
    panelBody.appendChild(empty);
  }
  if (checkedLayers.size >= 2) {
    const action = document.createElement('div');
    action.className = 'group-action';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pbtn-quiet';
    btn.textContent = 'Group';
    btn.setAttribute('aria-label', `Group ${checkedLayers.size} behaviours`);
    btn.addEventListener('click', () => {
      const s = selected();
      if (!s || checkedLayers.size < 2) return;
      pushHistory();
      const members = [...checkedLayers].sort((a, b) => s.layers.findIndex((l) => l.id === a) - s.layers.findIndex((l) => l.id === b));
      let n = 1;
      for (const g of s.groups) {
        const m = /^Group (\d+)$/.exec(g.name);
        if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
      }
      const group: BehaviourGroup = { id: nid(), name: `Group ${n}`, members, active: true, tempo: 1, amplitude: 1 };
      s.groups.push(group);
      checkedLayers.clear();
      expandedLayerId = null;
      expandedGroup = group.id;
      save();
      renderPanel();
    });
    action.appendChild(btn);
    panelBody.appendChild(action);
  }
  // Add behavior: a quiet pill at the bottom of the stack. Always
  // enabled — adding the same behaviour again creates another instance.
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
    renderPanel();
  });
  wrap.appendChild(addBtn);
  panelBody.appendChild(wrap);
  if (addPickerOpen) renderAddPicker(addBtn);
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
  const gridSeg = document.createElement('div');
  gridSeg.className = 'seg';
  gridSeg.setAttribute('role', 'group');
  gridSeg.setAttribute('aria-label', 'Grid');
  for (const g of [{ id: 'dots', label: 'Dots' }, { id: 'lines', label: 'Lines' }, { id: 'off', label: 'Off' }] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = gridMode === g.id ? 'active' : '';
    b.textContent = g.label;
    b.addEventListener('click', () => {
      if (gridMode === g.id) return;
      pushHistory();
      gridMode = g.id;
      save();
      renderPanel();
    });
    gridSeg.appendChild(b);
  }
  gridSec.appendChild(gridSeg);
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
  mkAction('Clear', 'clear-btn', clearStage);
  mkAction('Export PNG', 'png-btn', exportPNG);
  mkAction('Export Video', 'video-btn', exportVideo);
}

// ---------- colour panel ----------
// Clicking a swatch opens this view for that slot: hue ring +
// saturation/value square, hex, recent colours, saved palette.
function renderColourPanel(): void {
  panelTitle.textContent = 'Colour';
  const hsv = hexToHsv(slotColour()) ?? { h: 0, s: 0, v: 0.12 };
  let hue = hsv.h;
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
  // Hue ring.
  const ringWrap = document.createElement('div');
  ringWrap.className = 'hue-wrap';
  const ring = document.createElement('div');
  ring.className = 'hue-ring';
  ring.setAttribute('aria-label', 'Hue');
  const ringMarker = document.createElement('span');
  ringMarker.className = 'hue-marker';
  ringWrap.appendChild(ring);
  ringWrap.appendChild(ringMarker);
  const placeRingMarker = (): void => {
    const rad = (hue * Math.PI) / 180;
    const r = 60;
    ringMarker.style.left = `${70 + r * Math.cos(rad) - 6}px`;
    ringMarker.style.top = `${70 + r * Math.sin(rad) - 6}px`;
    ringMarker.style.background = `hsl(${Math.round(hue)}, 100%, 50%)`;
  };
  placeRingMarker();
  const hueFromEvent = (e: PointerEvent): void => {
    const rect = ring.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    placeRingMarker();
    svSquare.style.backgroundColor = `hsl(${Math.round(hue)}, 100%, 50%)`;
    applyDraft(false);
  };
  ring.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { ring.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    hueFromEvent(e);
    const onMove = (ev: PointerEvent): void => hueFromEvent(ev);
    const onUp = (): void => {
      ring.removeEventListener('pointermove', onMove);
      ring.removeEventListener('pointerup', onUp);
      ring.removeEventListener('pointercancel', onUp);
      applyDraft(true);
    };
    ring.addEventListener('pointermove', onMove);
    ring.addEventListener('pointerup', onUp);
    ring.addEventListener('pointercancel', onUp);
  });
  panelBody.appendChild(ringWrap);
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
function stagePoint(e: { clientX: number; clientY: number }): Pt {
  const rect = canvas.getBoundingClientRect();
  const { w, h } = stageSize();
  return { x: ((e.clientX - rect.left) / rect.width) * w, y: ((e.clientY - rect.top) / rect.height) * h };
}
let drag: {
  kind: 'brush' | 'shape' | 'select' | 'erase';
  start: Pt; last: Pt; item: Item | null; moved: boolean;
  before: string | null; // pre-gesture snapshot, for lazy history (move / erase)
  erased: boolean; // the eraser actually removed ink during this sweep
} | null = null;
let previewShape: ShapeItem | null = null;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
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
      selectedId = hit.id;
      renderPanel();
      drag = { kind: 'select', start: p, last: p, item: hit, moved: false, before: gestureStart(), erased: false };
    } else {
      selectedId = null;
      // Single-clicking empty stage exits focus (and deselects). The
      // timestamp stops the following dblclick event reopening the text
      // editor behind the exit.
      if (focusedId !== null) { focusedId = null; lastFocusExitAt = Date.now(); }
      renderPanel();
      drag = null;
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
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
    moveItem(drag.item, dx, dy);
    drag.last = p;
  }
});
canvas.addEventListener('pointerup', (e) => {
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
  if (drag.kind === 'erase') {
    if (drag.before) gestureCommit(drag.before, drag.erased);
  }
  if (drag.kind === 'brush' || drag.kind === 'erase' || drag.kind === 'shape') save(); // shapes were lost on reload until the next save — they never saved on creation
  previewShape = null;
  drag = null;
  renderPanel();
});
// Paint bucket: a shape fills solid with the foreground colour;
// a stroke or text is recoloured; empty stage fills the stage
// background with the foreground colour. Undo restores it.
function paintAt(p: Pt): void {
  const hit = hitTest(p);
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
        if (selectedId === it.id) selectedId = null;
        for (const l of it.layers) smoothed.delete(l.id);
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
    for (const l of it.layers) smoothed.delete(l.id);
    items.splice(i, 1, ...replacements);
    if (selectedId === it.id) selectedId = replacements.length ? replacements[0].id : null;
  }
  if (changed) renderPanel();
  return changed;
}
function moveItem(it: Item, dx: number, dy: number): void {
  if (it.type === 'stroke') it.points.forEach((pt) => { pt.x += dx; pt.y += dy; });
  else if (it.type === 'shape') { it.x += dx; it.y += dy; }
  else { it.x += dx; it.y += dy; }
}

// Draw the in-progress shape preview on top of the normal frame.
function renderWithPreview(t01: number): void {
  renderFrame(t01);
  if (previewShape) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = previewShape.color;
    ctx.lineWidth = previewShape.width;
    ctx.setLineDash([5, 4]);
    if (previewShape.kind === 'rect') ctx.strokeRect(previewShape.x, previewShape.y, previewShape.w, previewShape.h);
    else ctx.beginPath(), ctx.ellipse(previewShape.x + previewShape.w / 2, previewShape.y + previewShape.h / 2, previewShape.w / 2, previewShape.h / 2, 0, 0, Math.PI * 2), ctx.stroke();
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
      selectedId = item.id;
    }
    save();
    renderPanel();
  }
}
function openTextEditor(it: TextItem | null, p: Pt): void {
  if (textSession) closeTextEditor(true);
  const { w } = stageSize();
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / w;
  textEditor.style.display = 'block';
  textEditor.style.left = `${(it ? it.x : p.x) * scaleX}px`;
  textEditor.style.top = `${(it ? it.y - it.size : p.y - 20) * scaleX}px`;
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
  // focus only applies with the other tools.
  if (tool !== 'text' && tool !== 'paint') {
    if (hit) {
      if (focusedId === hit.id) focusedId = null;
      else focusedId = hit.id;
      selectedId = hit.id;
      renderPanel();
      return;
    }
    // Empty stage: exit focus. The gesture is consumed here — including
    // when a single click just exited it, so no text editor opens
    // behind the exit — and otherwise the old behaviour below runs.
    if (focusedId !== null || Date.now() - lastFocusExitAt < 500) {
      focusedId = null;
      selectedId = null;
      renderPanel();
      return;
    }
  }
  if (hit && hit.type === 'text') { selectedId = hit.id; openTextEditor(hit, p); }
  else if (tool === 'text' || !hit) openTextEditor(null, p);
});
canvas.addEventListener('pointerdown', (e) => {
  if (tool === 'text') {
    if (lastPressRepeat) return; // second press of a double-click pair
    const p = stagePoint(e);
    const hit = hitTest(p);
    if (hit?.type === 'text') { selectedId = hit.id; openTextEditor(hit, p); }
    else openTextEditor(null, p);
  }
});

// ---------- header / panel actions ----------
(document.getElementById('undo-btn') as HTMLButtonElement).addEventListener('click', undo);
(document.getElementById('redo-btn') as HTMLButtonElement).addEventListener('click', redo);
function clearStage(): void {
  if (items.length === 0) return;
  pushHistory();
  items = [];
  selectedId = null;
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
function exportPNG(): void {
  const { w, h } = stageSize();
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  renderFrame(playTime / loopMs(), octx, 1);
  off.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, 'manakin.png');
  }, 'image/png');
}
async function exportVideo(): Promise<void> {
  const btn = document.getElementById('video-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.title = 'Recording…'; }
  const wasPlaying = playing;
  if (!playing) { playing = true; setPlayLabel(); lastTs = 0; }
  const stream = canvas.captureStream(30);
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
  const done = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  rec.start(100);
  await new Promise((r) => setTimeout(r, loopMs() + 200));
  rec.stop();
  await done;
  if (!wasPlaying) { playing = false; setPlayLabel(); }
  downloadBlob(new Blob(chunks, { type: 'video/webm' }), 'manakin.webm');
  const btn2 = document.getElementById('video-btn') as HTMLButtonElement | null;
  if (btn2) { btn2.disabled = false; btn2.classList.remove('busy'); btn2.title = 'Video'; }
}
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
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
  if (k === 'escape') {
    if (addPickerOpen) { addPickerOpen = false; closeAddPickerEl(); renderPanel(); return; }
    if (focusedId !== null) { focusedId = null; renderPanel(); return; }
    if (panelView === 'colour') { panelView = 'auto'; renderPanel(); }
    return;
  }
  if (k === 'delete' || k === 'backspace') {
    const sel = selected();
    if (sel) { pushHistory(); items = items.filter((i) => i.id !== sel.id); selectedId = null; save(); renderPanel(); }
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

// The Add behavior picker closes on a click anywhere else, on Escape
// (handled above), or when the panel scrolls / the window resizes —
// its anchor moved, so the popover would point at nothing.
document.addEventListener('click', (e) => {
  if (!addPickerOpen) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest('.add-picker, .add-btn')) return;
  addPickerOpen = false;
  closeAddPickerEl();
  renderPanel();
});
panelBody.addEventListener('scroll', () => {
  if (!addPickerOpen) return;
  addPickerOpen = false;
  closeAddPickerEl();
}, { passive: true });
window.addEventListener('resize', () => {
  if (!addPickerOpen) return;
  addPickerOpen = false;
  closeAddPickerEl();
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


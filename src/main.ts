import './styles.css';

type Pt = { x: number; y: number };
type BehaviourName = 'Bob' | 'Sway' | 'Breathe' | 'Blink' | 'Spin' | 'Wander';
const BEHAVIOURS: BehaviourName[] = ['Bob', 'Sway', 'Breathe', 'Blink', 'Spin', 'Wander'];
const LOOP_MS = 4000;

type BehaviourGroup = {
  id: string;
  name: string;
  members: number[]; // behaviour indices, ascending; a behaviour belongs to at most one group
  active: boolean; // group off suspends its members without losing their own on/off states
  speed: number; // 0.25-3, multiplies each member's speed
  amount: number; // 0-100, scales each member's amount
};
type ItemBase = {
  id: string;
  color: string;
  width: number;
  active: boolean[]; // one on/off layer per behaviour, on for the whole loop
  speeds: number[];
  amounts: number[];
  phases: number[]; // 0-100% shift of the motion within the loop, per behaviour
  blinkDuration: number; // % of the cycle the blink bump spans (Blink only)
  spinReverse: boolean; // Spin only: run the spin backwards
  wanderSmooth: number; // 0-100% (Wander only); 50+ is the smooth drift
  groups: BehaviourGroup[]; // per-item behaviour groups; flat only, no groups in groups
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
function defaultActive(): boolean[] { return [false, false, false, false, false, false]; }
function defaultSpeeds(): number[] { return [1, 1, 1, 1, 1, 1]; }
function defaultAmounts(): number[] { return [66, 66, 66, 66, 66, 66]; }
function defaultPhases(): number[] { return [0, 0, 0, 0, 0, 0]; }
function defaultBlinkDuration(): number { return 26; } // raised-cosine bump whose half-depth width (13%) matches the old sin^8 blink
function baseItem(color: string, width: number): ItemBase {
  return { id: nid(), color, width, active: defaultActive(), speeds: defaultSpeeds(), amounts: defaultAmounts(), phases: defaultPhases(), blinkDuration: defaultBlinkDuration(), spinReverse: false, wanderSmooth: 50, groups: [] };
}

// ---------- state ----------
let items: Item[] = [];
let selectedId: string | null = null;
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
let expandedBehaviour: number | null = null;
let expandedGroup: string | null = null; // id of the open group in the Behaviours panel
let checkedBehaviours: Set<number> = new Set(); // top-level rows picked for grouping
let checkedItemId: string | null = null; // the item the checked rows belong to
let recentColours: string[] = [];
let savedColours: string[] = [];
let playing = false;
let playTime = 0; // ms within the loop, frozen when paused
let lastTs = 0;
let history: string[] = [];
let redoStack: string[] = [];
const smoothed = new Map<string, number[]>(); // item id -> per-behaviour smoothed amplitude 0..1

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
  return JSON.stringify({ items, stageBgId, stageBgCustom });
}
function pushHistory(): void {
  history.push(snapshot());
  if (history.length > 50) history.shift();
  redoStack = [];
}
function restore(json: string): void {
  try {
    const data = JSON.parse(json) as unknown;
    if (Array.isArray(data)) {
      items = data as Item[];
    } else if (data && typeof data === 'object') {
      const d = data as { items?: Item[]; stageBgId?: StageBgId; stageBgCustom?: string | null };
      if (Array.isArray(d.items)) items = d.items;
      if (d.stageBgId) stageBgId = d.stageBgId;
      stageBgCustom = typeof d.stageBgCustom === 'string' ? d.stageBgCustom : null;
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
  const withAct = (it: Item): Item => { it.active = [...act]; return it; };
  const body: ShapeItem = { ...baseItem('#1d1d1f', 4), type: 'shape', kind: 'ellipse', x: 370, y: 230, w: 220, h: 150, fillSolid: false };
  const head: ShapeItem = { ...baseItem('#1d1d1f', 4), type: 'shape', kind: 'ellipse', x: 545, y: 175, w: 95, h: 95, fillSolid: false };
  const eye: ShapeItem = { ...baseItem('#1d1d1f', 2), type: 'shape', kind: 'ellipse', x: 578, y: 208, w: 14, h: 14, fillSolid: true };
  const beak: StrokeItem = { ...baseItem('#d2592d', 4), type: 'stroke', points: [{ x: 632, y: 208 }, { x: 668, y: 224 }, { x: 632, y: 240 }, { x: 632, y: 208 }] };
  const wing: StrokeItem = { ...baseItem('#007aff', 4), type: 'stroke', points: [{ x: 430, y: 285 }, { x: 480, y: 325 }, { x: 535, y: 288 }] };
  const leg1: StrokeItem = { ...baseItem('#1d1d1f', 4), type: 'stroke', points: [{ x: 450, y: 380 }, { x: 450, y: 415 }] };
  const leg2: StrokeItem = { ...baseItem('#1d1d1f', 4), type: 'stroke', points: [{ x: 510, y: 380 }, { x: 510, y: 415 }] };
  return [body, head, eye, beak, wing, leg1, leg2].map(withAct);
}

function migrateItem(it: Item): void {
  const anyIt = it as unknown as Record<string, unknown>;
  // v2 saves stored a 6x8 beat grid; a row with any cell on becomes layer on.
  if (Array.isArray(anyIt.pattern)) {
    const grid = anyIt.pattern as boolean[][];
    it.active = BEHAVIOURS.map((_, b) => Array.isArray(grid[b]) && grid[b].some(Boolean));
    delete anyIt.pattern;
  }
  if (!Array.isArray(it.active) || it.active.length !== BEHAVIOURS.length) it.active = defaultActive();
  if (!Array.isArray(it.speeds) || it.speeds.length !== BEHAVIOURS.length) it.speeds = defaultSpeeds();
  if (!Array.isArray(it.amounts) || it.amounts.length !== BEHAVIOURS.length) it.amounts = defaultAmounts();
  else it.amounts = it.amounts.map((a) => (a === 0.5 ? 33 : a === 1 ? 66 : a === 2 ? 100 : a > 2 ? a : 66));
  if (!Array.isArray(it.phases) || it.phases.length !== BEHAVIOURS.length) it.phases = defaultPhases();
  else it.phases = it.phases.map((p) => (typeof p === 'number' && p >= 0 && p <= 100 ? p : 0));
  if (typeof it.blinkDuration !== 'number' || it.blinkDuration < 10 || it.blinkDuration > 60) it.blinkDuration = defaultBlinkDuration();
  if (typeof it.spinReverse !== 'boolean') it.spinReverse = false;
  if (typeof it.wanderSmooth !== 'number' || it.wanderSmooth < 0 || it.wanderSmooth > 100) it.wanderSmooth = 50;
  // Groups: flat only, a behaviour in at most one group, members valid and ascending.
  const clampNum = (v: unknown, min: number, max: number, dflt: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : dflt;
  if (!Array.isArray(it.groups)) it.groups = [];
  else {
    const seen = new Set<number>();
    it.groups = (it.groups as unknown[]).map((raw) => {
      const g = (raw ?? {}) as Partial<BehaviourGroup>;
      const members = (Array.isArray(g.members) ? g.members : [])
        .filter((m): m is number => Number.isInteger(m) && m >= 0 && m < BEHAVIOURS.length && !seen.has(m));
      members.forEach((m) => seen.add(m));
      return {
        id: typeof g.id === 'string' && g.id ? g.id : nid(),
        name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Group',
        members: [...members].sort((a, b) => a - b),
        active: typeof g.active === 'boolean' ? g.active : true,
        speed: clampNum(g.speed, 0.25, 3, 1),
        amount: clampNum(g.amount, 0, 100, 100),
      };
    }).filter((g) => g.members.length > 0);
  }
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
function updateCursor(): void {
  canvas.classList.toggle('select-cursor', tool === 'select');
}
renderToolbar();
updateCursor();

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
function hitTest(p: Pt): Item | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'stroke') {
      for (let s = 0; s < it.points.length - 1; s++) {
        if (distToSegment(p, it.points[s], it.points[s + 1]) <= Math.max(8, it.width + 4)) return it;
      }
      if (it.points.length === 1 && Math.hypot(p.x - it.points[0].x, p.y - it.points[0].y) <= 10) return it;
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
// A behaviour's effective parameters fold in its group's multipliers.
// A member contributes only when both its own toggle and its group's toggle are on.
function groupOf(it: Item, b: number): BehaviourGroup | undefined {
  return it.groups.find((g) => g.members.includes(b));
}
function effActive(it: Item, b: number): boolean {
  const g = groupOf(it, b);
  return it.active[b] && (!g || g.active);
}
function effSpeed(it: Item, b: number): number {
  const g = groupOf(it, b);
  return (it.speeds[b] ?? 1) * (g ? g.speed : 1);
}
function effAmount(it: Item, b: number): number {
  const g = groupOf(it, b);
  return (it.amounts[b] ?? 1) * (g ? g.amount / 100 : 1);
}

function amountScale(a: number): number {
  // Amounts are percents (0-100) since the v3 migration mapped the old
  // segmented 0.5/1/2 values to 33/66/100 — so this is pure percent math.
  // (The old legacy branches returned 1 for a <= 2, which would have made
  // a group Amount of 0% behave like 100%.)
  return (a / 100) * 1.8;
}
function smoothedAmps(it: Item): number[] {
  let arr = smoothed.get(it.id);
  if (!arr) { arr = [0, 0, 0, 0, 0, 0]; smoothed.set(it.id, arr); }
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const target = effActive(it, b) ? 1 : 0;
    arr[b] += (target - arr[b]) * 0.06;
    if (Math.abs(arr[b] - target) < 0.002) arr[b] = target;
  }
  return arr;
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
function wanderTerms(it: Item, t01: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const sp = effSpeed(it, 5);
  const ph = twoPi * ((it.phases?.[5] ?? 0) / 100);
  const j = wanderJitterAmp(it.wanderSmooth ?? 50);
  return {
    x: Math.sin(twoPi * 0.5 * sp * t01 + ph) + j * Math.sin(twoPi * 2.3 * sp * t01 + 0.4 + ph),
    y: Math.sin(twoPi * 0.7 * sp * t01 + 1.3 + ph) + j * Math.sin(twoPi * 3.1 * sp * t01 + 2.1 + ph),
  };
}
function motionFor(it: Item, t01: number): Motion {
  const amps = smoothedAmps(it);
  const twoPi = Math.PI * 2;
  let dx = 0, dy = 0, scale = 1, rot = 0, opacity = 1;
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const a = amps[b];
    if (a < 0.01) continue;
    const sp = effSpeed(it, b);
    const am = amountScale(effAmount(it, b));
    const ph = twoPi * sp * t01 + twoPi * ((it.phases?.[b] ?? 0) / 100); // Phase shifts the motion within the loop
    if (b === 0) dy += a * am * 16 * Math.sin(ph); // Bob
    if (b === 1) dx += a * am * 16 * Math.sin(ph + Math.PI / 2); // Sway
    if (b === 2) scale += a * am * 0.08 * Math.sin(ph); // Breathe
    if (b === 3) opacity -= a * 0.85 * blinkPulse(ph, it.blinkDuration ?? 26); // Blink
    if (b === 4) rot += (it.spinReverse ? -1 : 1) * a * am * 0.35 * Math.sin(ph); // Spin
    if (b === 5) { const w = wanderTerms(it, t01); dx += a * am * 18 * w.x; dy += a * am * 14 * w.y; } // Wander
  }
  return { dx, dy, scale, rot, opacity: Math.max(0.05, Math.min(1, opacity)) };
}
// Motion value of one behaviour over the loop, for the layer graph.
// Reads the same parameters as motionFor, so the graph and the motion agree.
function behaviourValue(it: Item, b: number, t01: number): number {
  const twoPi = Math.PI * 2;
  const am = amountScale(effAmount(it, b));
  const sp = effSpeed(it, b);
  const ph = twoPi * sp * t01 + twoPi * ((it.phases?.[b] ?? 0) / 100);
  if (b === 3) return am * blinkPulse(ph, it.blinkDuration ?? 26); // Blink: the widened pulse itself, not a square wave
  if (b === 4) return (it.spinReverse ? -1 : 1) * am * Math.sin(ph); // Spin: mirrors when reversed
  if (b === 5) { const w = wanderTerms(it, t01); return am * (w.x + 0.7 * w.y) / 1.7; } // Wander
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
function drawItem(c: CanvasRenderingContext2D, it: Item, t01: number): void {
  const b = itemBBox(it);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const m = motionFor(it, t01);
  c.save();
  c.translate(cx + m.dx, cy + m.dy);
  c.rotate(m.rot);
  c.scale(m.scale, m.scale);
  c.translate(-cx, -cy);
  c.globalAlpha = m.opacity;
  c.strokeStyle = it.color;
  c.fillStyle = it.color;
  c.lineWidth = it.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (it.type === 'stroke') {
    c.beginPath();
    it.points.forEach((p, i) => { if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y); });
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
  for (const it of items) drawItem(target, it, t01);
  if (target === ctx && selected()) {
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
    if (lastTs) playTime = (playTime + (ts - lastTs)) % LOOP_MS;
    lastTs = ts;
  } else {
    lastTs = 0;
  }
  const t01 = playTime / LOOP_MS;
  renderWithPreview(t01);
  progressFill.style.width = `${(t01 * 100).toFixed(1)}%`;
  timeState.textContent = `${(playTime / 1000).toFixed(1)} / ${(LOOP_MS / 1000).toFixed(1)}s`;
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
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    val.textContent = opts.format(v);
    opts.onInput(v);
  });
  input.addEventListener('change', () => opts.onCommit());
  row.appendChild(lab);
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

function drawGraph(cv: HTMLCanvasElement, it: Item, b: number): void {
  const W = 248, H = 48;
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
  const maxAmp = 1.8; // amountScale(2)
  g.strokeStyle = '#1d1d1f';
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const v = behaviourValue(it, b, t) / maxAmp;
    const x = (t * (W - 4)) + 2;
    const y = H / 2 - v * (H / 2 - 5);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

function renderPanel(): void {
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  undoBtn.disabled = history.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  panelBody.innerHTML = '';
  if (panelView === 'colour') { renderColourPanel(); return; }
  const sel = selected();
  if (sel) { renderBehavioursPanel(sel); return; }
  renderCanvasPanel();
}

// Combined graph for a group: the sum of its members' effective motion
// over the loop. Only members that are effectively on (own toggle and
// group toggle) contribute, so a suspended group reads flat. The scale is
// fixed to the sum of the members' own amounts (before the group
// multiplier), so changing the group's Amount visibly shrinks the curve
// instead of re-normalising it away.
function drawGroupGraph(cv: HTMLCanvasElement, it: Item, group: BehaviourGroup): void {
  const W = 248, H = 48;
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
  const vals: number[] = [];
  let scale = 0;
  for (const b of group.members) if (effActive(it, b)) scale += amountScale(it.amounts[b] ?? 1);
  if (scale < 0.01) scale = 1;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let v = 0;
    for (const b of group.members) if (effActive(it, b)) v += behaviourValue(it, b, t);
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

// One behaviour row: on/off toggle, name, expand chevron, and — when
// expanded — its graph plus Speed/Amount/Phase and its own extra controls.
// Returns the row and its graph canvas (null while collapsed) so a group
// can redraw member graphs when a group slider moves.
function behaviourLayer(sel: Item, b: number, opts: { checkable: boolean; onParamChange?: () => void }): { layer: HTMLDivElement; graph: HTMLCanvasElement | null } {
  const layer = document.createElement('div');
  layer.className = 'blayer' + (expandedBehaviour === b ? ' expanded' : '');
  layer.dataset.behaviour = String(b);
  const head = document.createElement('div');
  head.className = 'layer-head';
  if (opts.checkable) {
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'layer-check' + (checkedBehaviours.has(b) ? ' checked' : '');
    check.setAttribute('aria-label', `Select ${BEHAVIOURS[b]} for grouping`);
    check.setAttribute('aria-pressed', String(checkedBehaviours.has(b)));
    check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkedBehaviours.has(b)) checkedBehaviours.delete(b);
      else checkedBehaviours.add(b);
      renderPanel();
    });
    head.appendChild(check);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'layer-toggle' + (sel.active[b] ? ' on' : '');
  toggle.setAttribute('aria-label', `${BEHAVIOURS[b]} on or off`);
  toggle.setAttribute('aria-pressed', String(sel.active[b]));
  toggle.innerHTML = '<span class="knob"></span>';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = selected();
    if (!s) return;
    s.active[b] = !s.active[b];
    save();
    renderPanel();
  });
  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = BEHAVIOURS[b];
  const chev = document.createElement('button');
  chev.type = 'button';
  chev.className = 'layer-chev';
  chev.setAttribute('aria-label', expandedBehaviour === b ? `Collapse ${BEHAVIOURS[b]}` : `Expand ${BEHAVIOURS[b]}`);
  chev.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  const toggleExpand = (): void => {
    expandedBehaviour = expandedBehaviour === b ? null : b;
    renderPanel();
  };
  chev.addEventListener('click', (e) => {
    e.stopPropagation(); // the head row also toggles; without this it flips twice
    toggleExpand();
  });
  head.appendChild(toggle);
  head.appendChild(name);
  head.appendChild(chev);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.layer-toggle, .layer-check')) return;
    toggleExpand();
  });
  layer.appendChild(head);
  let graph: HTMLCanvasElement | null = null;
  if (expandedBehaviour === b) {
    const body = document.createElement('div');
    body.className = 'layer-body';
    graph = document.createElement('canvas');
    graph.className = 'graph';
    graph.setAttribute('aria-label', `${BEHAVIOURS[b]} motion graph`);
    body.appendChild(graph);
    const redraw = (): void => {
      const s = selected();
      if (s && graph) drawGraph(graph, s, b);
      opts.onParamChange?.();
    };
    body.appendChild(paramSlider({
      label: 'Speed', min: 0.25, max: 3, step: 0.05, value: sel.speeds[b],
      format: (v) => `${v.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x`,
      aria: `${BEHAVIOURS[b]} speed`,
      onInput: (v) => { const s = selected(); if (!s) return; s.speeds[b] = v; redraw(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Amount', min: 0, max: 100, step: 1, value: sel.amounts[b],
      format: (v) => `${Math.round(v)}%`,
      aria: `${BEHAVIOURS[b]} amount`,
      onInput: (v) => { const s = selected(); if (!s) return; s.amounts[b] = v; redraw(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Phase', min: 0, max: 100, step: 1, value: sel.phases[b] ?? 0,
      format: (v) => `${Math.round(v)}%`,
      aria: `${BEHAVIOURS[b]} phase`,
      onInput: (v) => { const s = selected(); if (!s) return; s.phases[b] = v; redraw(); },
      onCommit: () => save(),
    }));
    if (b === 3) {
      body.appendChild(paramSlider({
        label: 'Duration', min: 10, max: 60, step: 1, value: sel.blinkDuration ?? 26,
        format: (v) => `${Math.round(v)}%`,
        aria: 'Blink duration',
        onInput: (v) => { const s = selected(); if (!s) return; s.blinkDuration = v; redraw(); },
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
      revToggle.className = 'layer-toggle' + (sel.spinReverse ? ' on' : '');
      revToggle.setAttribute('aria-label', 'Spin reverse');
      revToggle.setAttribute('aria-pressed', String(sel.spinReverse));
      revToggle.innerHTML = '<span class="knob"></span>';
      const revVal = document.createElement('span');
      revVal.className = 'pslider-value';
      revVal.textContent = sel.spinReverse ? 'On' : 'Off';
      revToggle.addEventListener('click', () => {
        const s = selected();
        if (!s) return;
        s.spinReverse = !s.spinReverse;
        revToggle.classList.toggle('on', s.spinReverse);
        revToggle.setAttribute('aria-pressed', String(s.spinReverse));
        revVal.textContent = s.spinReverse ? 'On' : 'Off';
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
        label: 'Smooth', min: 0, max: 100, step: 1, value: sel.wanderSmooth ?? 50,
        format: (v) => `${Math.round(v)}%`,
        aria: 'Wander smoothness',
        onInput: (v) => { const s = selected(); if (!s) return; s.wanderSmooth = v; redraw(); },
        onCommit: () => save(),
      }));
    }
    layer.appendChild(body);
    drawGraph(graph, sel, b);
  }
  return { layer, graph };
}

// One group row: chevron, name (click to rename inline), on/off toggle,
// ungroup button. When expanded: combined graph, the group's Speed and
// Amount sliders, then the member rows with their own controls.
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
        if (v && v !== group.name) { group.name = v; save(); }
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
    const memberGraphs = new Map<number, HTMLCanvasElement>();
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
      for (const [b, cv] of memberGraphs) drawGraph(cv, s, b);
    };
    body.appendChild(paramSlider({
      label: 'Speed', min: 0.25, max: 3, step: 0.05, value: group.speed,
      format: (v) => `${v.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x`,
      aria: `${group.name} speed`,
      onInput: (v) => { const s = selected(); if (!s) return; const g = s.groups.find((gg) => gg.id === group.id); if (!g) return; g.speed = v; redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => save(),
    }));
    body.appendChild(paramSlider({
      label: 'Amount', min: 0, max: 100, step: 1, value: group.amount,
      format: (v) => `${Math.round(v)}%`,
      aria: `${group.name} amount`,
      onInput: (v) => { const s = selected(); if (!s) return; const g = s.groups.find((gg) => gg.id === group.id); if (!g) return; g.amount = v; redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => save(),
    }));
    const membersWrap = document.createElement('div');
    membersWrap.className = 'group-members';
    for (const b of group.members) {
      const { layer: mLayer, graph: mGraph } = behaviourLayer(sel, b, {
        checkable: false,
        onParamChange: () => redrawGroupGraph(),
      });
      mLayer.classList.add('in-group');
      if (mGraph) memberGraphs.set(b, mGraph);
      membersWrap.appendChild(mLayer);
    }
    body.appendChild(membersWrap);
    layer.appendChild(body);
    drawGroupGraph(graph, sel, group);
  }
  return layer;
}

function renderBehavioursPanel(sel: Item): void {
  panelTitle.textContent = 'Behaviours';
  if (checkedItemId !== sel.id) { checkedBehaviours.clear(); checkedItemId = sel.id; }
  // Order: each entry sits at the position of its earliest behaviour, so a
  // group takes the first selected member's place and ungrouping restores
  // members to their original positions.
  type Entry = { pos: number; render: () => HTMLElement };
  const entries: Entry[] = [];
  const grouped = new Set(sel.groups.flatMap((g) => g.members));
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    if (!grouped.has(b)) entries.push({ pos: b, render: () => behaviourLayer(sel, b, { checkable: true }).layer });
  }
  for (const g of sel.groups) {
    entries.push({ pos: Math.min(...g.members), render: () => groupLayer(sel, g) });
  }
  entries.sort((a, b) => a.pos - b.pos);
  for (const e of entries) panelBody.appendChild(e.render());
  if (checkedBehaviours.size >= 2) {
    const action = document.createElement('div');
    action.className = 'group-action';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pbtn-quiet';
    btn.textContent = 'Group';
    btn.setAttribute('aria-label', `Group ${checkedBehaviours.size} behaviours`);
    btn.addEventListener('click', () => {
      const s = selected();
      if (!s || checkedBehaviours.size < 2) return;
      pushHistory();
      const members = [...checkedBehaviours].sort((a, b) => a - b);
      let n = 1;
      for (const g of s.groups) {
        const m = /^Group (\d+)$/.exec(g.name);
        if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
      }
      const group: BehaviourGroup = { id: nid(), name: `Group ${n}`, members, active: true, speed: 1, amount: 100 };
      s.groups.push(group);
      checkedBehaviours.clear();
      expandedBehaviour = null;
      expandedGroup = group.id;
      save();
      renderPanel();
    });
    action.appendChild(btn);
    panelBody.appendChild(action);
  }
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
} | null = null;
let previewShape: ShapeItem | null = null;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  const p = stagePoint(e);
  if (tool === 'brush') {
    pushHistory();
    const stroke: StrokeItem = { ...baseItem(color, penWidth), type: 'stroke', points: [p] };
    items.push(stroke);
    drag = { kind: 'brush', start: p, last: p, item: stroke, moved: false };
  } else if (tool === 'paint') {
    paintAt(p);
    drag = null;
  } else if (tool === 'shape') {
    drag = { kind: 'shape', start: p, last: p, item: null, moved: false };
  } else if (tool === 'eraser') {
    pushHistory();
    eraseAt(p);
    drag = { kind: 'erase', start: p, last: p, item: null, moved: false };
  } else if (tool === 'select') {
    const hit = hitTest(p);
    if (hit) {
      selectedId = hit.id;
      renderPanel();
      drag = { kind: 'select', start: p, last: p, item: hit, moved: false };
    } else {
      selectedId = null;
      renderPanel();
      drag = null;
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = stagePoint(e);
  if (drag.kind === 'brush' && drag.item?.type === 'stroke') {
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
    eraseAt(p);
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
  if (drag.kind === 'select' && drag.moved) save();
  if (drag.kind === 'brush' || drag.kind === 'erase') save();
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
function eraseAt(p: Pt): void {
  const hit = hitTest(p);
  if (hit) {
    items = items.filter((i) => i.id !== hit.id);
    if (selectedId === hit.id) selectedId = null;
    smoothed.delete(hit.id);
    renderPanel();
  }
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
function openTextEditor(it: TextItem | null, p: Pt): void {
  const { w, h } = stageSize();
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / w;
  textEditor.style.display = 'block';
  textEditor.style.left = `${(it ? it.x : p.x) * scaleX}px`;
  textEditor.style.top = `${(it ? it.y - it.size : p.y - 20) * scaleX}px`;
  textEditor.style.width = '220px';
  textEditor.value = it ? it.text : '';
  textEditor.focus();
  const finish = (commit: boolean) => {
    textEditor.style.display = 'none';
    const value = textEditor.value.trim();
    if (commit && value) {
      if (it) { it.text = value; }
      else {
        pushHistory();
        const item: TextItem = { ...baseItem(color, penWidth), type: 'text', x: p.x, y: p.y, text: value, size: 20 };
        items.push(item);
        selectedId = item.id;
      }
      save();
      renderPanel();
    }
    textEditor.removeEventListener('blur', onBlur);
  };
  const onBlur = () => finish(true);
  textEditor.addEventListener('blur', onBlur, { once: true });
  textEditor.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') finish(false);
    ev.stopPropagation();
  };
}
canvas.addEventListener('dblclick', (e) => {
  const p = stagePoint(e);
  const hit = hitTest(p);
  if (hit && hit.type === 'text') { selectedId = hit.id; openTextEditor(hit, p); }
  else if (tool === 'text' || !hit) openTextEditor(null, p);
});
canvas.addEventListener('pointerdown', (e) => {
  if (tool === 'text') {
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
forwardBtn.addEventListener('click', () => { playTime = LOOP_MS - 1; });
function exportPNG(): void {
  const { w, h } = stageSize();
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  renderFrame(playTime / LOOP_MS, octx, 1);
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
  await new Promise((r) => setTimeout(r, LOOP_MS + 200));
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

// ---------- init ----------
load();
projectInput.value = projectName;
renderPanel();
setPlayLabel();
applyPanelOpen();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(frame);


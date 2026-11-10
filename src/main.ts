import './styles.css';

type Pt = { x: number; y: number };
type BehaviourName = 'Bob' | 'Sway' | 'Breathe' | 'Blink' | 'Spin' | 'Wander';
const BEHAVIOURS: BehaviourName[] = ['Bob', 'Sway', 'Breathe', 'Blink', 'Spin', 'Wander'];
const BEATS = 8;
const LOOP_MS = 4000;

type Pattern = boolean[][];
type ItemBase = {
  id: string;
  color: string;
  width: number;
  pattern: Pattern;
  speeds: number[];
  amounts: number[];
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

const COLORS = [
  { name: 'Ink', value: '#1d1d1f' },
  { name: 'Terracotta', value: '#d2592d' },
  { name: 'Blue', value: '#007aff' },
  { name: 'Green', value: '#2d9d5f' },
  { name: 'Yellow', value: '#e8b93e' },
  { name: 'Pink', value: '#d96a9b' },
];
const STAGE_BGS = [
  { id: 'white', label: 'White', value: '#ffffff' },
  { id: 'paper', label: 'Paper', value: '#f5f0e6' },
  { id: 'sage', label: 'Sage', value: '#dfe8dd' },
  { id: 'sky', label: 'Sky', value: '#dbe9f5' },
  { id: 'ink', label: 'Ink', value: '#1d1d1f' },
] as const;
type StageBgId = (typeof STAGE_BGS)[number]['id'];
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
function emptyPattern(): Pattern {
  return BEHAVIOURS.map(() => Array<boolean>(BEATS).fill(false));
}
function defaultSpeeds(): number[] { return [1, 1, 1, 1, 1, 1]; }
function defaultAmounts(): number[] { return [1, 1, 1, 1, 1, 1]; }
function baseItem(color: string, width: number): ItemBase {
  return { id: nid(), color, width, pattern: emptyPattern(), speeds: defaultSpeeds(), amounts: defaultAmounts() };
}

// ---------- state ----------
let items: Item[] = [];
let selectedId: string | null = null;
type ToolId = 'select' | 'brush' | 'eraser' | 'shape' | 'text' | 'paint';
let tool: ToolId = 'brush';
let color = COLORS[0].value; // foreground
let bgColour = COLORS[2].value; // background (secondary swatch)
let activeSlot: 'fg' | 'bg' = 'fg';
let penWidth = 4;
let shapeKind: 'rect' | 'ellipse' = 'rect';
let stageId: 'wide' | 'square' | 'portrait' = 'wide';
let stageBgId: StageBgId = 'white';
let gridMode: GridMode = 'off';
let projectName = 'Untitled';
let panelOpen = true;
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
  return STAGE_BGS.find((b) => b.id === stageBgId)?.value ?? '#ffffff';
}
function save(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      items, stageId, projectName, stageBgId, gridMode, panelOpen,
      fg: color, bg: bgColour, penWidth,
    }));
  } catch { /* storage full or unavailable */ }
}
function snapshot(): string { return JSON.stringify(items); }
function pushHistory(): void {
  history.push(snapshot());
  if (history.length > 50) history.shift();
  redoStack = [];
}
function restore(json: string): void {
  items = JSON.parse(json) as Item[];
  if (selectedId && !items.some((i) => i.id === selectedId)) selectedId = null;
  smoothed.clear();
  save();
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

// ---------- sample ----------
function sampleBird(): Item[] {
  const pat = emptyPattern();
  for (let b = 0; b < BEATS; b++) { pat[0][b] = true; pat[2][b] = true; }
  for (const b of [0, 2, 4, 6]) pat[1][b] = true;
  pat[3][0] = true; pat[3][4] = true;
  const withPat = (it: Item): Item => { it.pattern = pat.map((r) => [...r]); return it; };
  const body: ShapeItem = { ...baseItem('#1d1d1f', 4), type: 'shape', kind: 'ellipse', x: 370, y: 230, w: 220, h: 150, fillSolid: false };
  const head: ShapeItem = { ...baseItem('#1d1d1f', 4), type: 'shape', kind: 'ellipse', x: 545, y: 175, w: 95, h: 95, fillSolid: false };
  const eye: ShapeItem = { ...baseItem('#1d1d1f', 2), type: 'shape', kind: 'ellipse', x: 578, y: 208, w: 14, h: 14, fillSolid: true };
  const beak: StrokeItem = { ...baseItem('#d2592d', 4), type: 'stroke', points: [{ x: 632, y: 208 }, { x: 668, y: 224 }, { x: 632, y: 240 }, { x: 632, y: 208 }] };
  const wing: StrokeItem = { ...baseItem('#007aff', 4), type: 'stroke', points: [{ x: 430, y: 285 }, { x: 480, y: 325 }, { x: 535, y: 288 }] };
  const leg1: StrokeItem = { ...baseItem('#1d1d1f', 4), type: 'stroke', points: [{ x: 450, y: 380 }, { x: 450, y: 415 }] };
  const leg2: StrokeItem = { ...baseItem('#1d1d1f', 4), type: 'stroke', points: [{ x: 510, y: 380 }, { x: 510, y: 415 }] };
  return [body, head, eye, beak, wing, leg1, leg2].map(withPat);
}

function load(): void {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as {
        items: Item[]; stageId: typeof stageId; projectName?: string;
        stageBgId?: StageBgId; gridMode?: GridMode; panelOpen?: boolean;
        fg?: string; bg?: string; penWidth?: number;
      };
      if (Array.isArray(data.items) && data.items.length > 0) {
        items = data.items;
        if (data.stageId) stageId = data.stageId;
        if (typeof data.projectName === 'string' && data.projectName.trim()) projectName = data.projectName;
        if (data.stageBgId && STAGE_BGS.some((b) => b.id === data.stageBgId)) stageBgId = data.stageBgId;
        if (data.gridMode === 'dots' || data.gridMode === 'lines' || data.gridMode === 'off') gridMode = data.gridMode;
        if (typeof data.panelOpen === 'boolean') panelOpen = data.panelOpen;
        if (typeof data.fg === 'string') color = data.fg;
        if (typeof data.bg === 'string') bgColour = data.bg;
        if (typeof data.penWidth === 'number' && data.penWidth >= 2 && data.penWidth <= 32) penWidth = data.penWidth;
        return;
      }
    }
  } catch { /* corrupted save: fall through to sample */ }
  items = sampleBird();
  save();
}

// ---------- DOM ----------
const app = document.getElementById('app')!;
app.innerHTML = `
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
<div id="body-row">
  <div id="main-row">
    <div id="toolbar" role="toolbar" aria-label="Tools"></div>
    <div id="stage-area">
      <div id="stage-wrap">
        <canvas id="stage"></canvas>
        <textarea id="text-editor" rows="1" aria-label="Text"></textarea>
      </div>
    </div>
  </div>
  <aside id="panel" aria-label="Panel">
    <div id="panel-head">
      <h2 id="panel-title">Canvas</h2>
      <span id="panel-state"></span>
    </div>
    <div id="panel-body"></div>
  </aside>
</div>
<footer id="player">
  <button id="play-btn"><svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg><span>Play</span></button>
  <div id="beats" aria-label="Beat"></div>
  <div id="progress-track" aria-hidden="true"><div id="progress-fill"></div></div>
  <span id="beat-state">Beat 1 / 8</span>
  <span id="time-state">0.0 / 4.0s</span>
  <span id="player-state"></span>
</footer>`;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const stageWrap = document.getElementById('stage-wrap')!;
const textEditor = document.getElementById('text-editor') as HTMLTextAreaElement;
const panelEl = document.getElementById('panel')!;
const panelTitle = document.getElementById('panel-title')!;
const panelState = document.getElementById('panel-state')!;
const panelBody = document.getElementById('panel-body')!;
const playerState = document.getElementById('player-state')!;
const beatState = document.getElementById('beat-state')!;
const timeState = document.getElementById('time-state')!;
const progressFill = document.getElementById('progress-fill')!;
const playBtn = document.getElementById('play-btn')!;
const beatsEl = document.getElementById('beats')!;
const projectInput = document.getElementById('project-name') as HTMLInputElement;
const panelBtn = document.getElementById('panel-btn') as HTMLButtonElement;

for (let b = 0; b < BEATS; b++) {
  const dot = document.createElement('span');
  beatsEl.appendChild(dot);
}

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
  { id: 'eraser', label: 'Eraser', key: '', svg: '<path d="M7 20h10"/><path d="M5 15l8-8 4 4-5 5H9z"/>' },
  { id: 'shape', label: 'Geometry', key: 'E', svg: '<rect x="4" y="4" width="16" height="16" rx="2"/>' },
  { id: 'text', label: 'Text', key: 'T', svg: '<path d="M5 6h14M12 6v13"/>' },
  { id: 'paint', label: 'Paint', key: 'B', svg: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>' },
];
const toolbar = document.getElementById('toolbar')!;
function swapColors(): void {
  const t = color;
  color = bgColour;
  bgColour = t;
  save();
  renderToolbar();
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
  // Brush size: vertical slider, with the size preview circle BELOW it.
  const sizeWrap = document.createElement('div');
  sizeWrap.className = 'size-wrap';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '2';
  slider.max = '32';
  slider.step = '1';
  slider.value = String(penWidth);
  slider.className = 'brush-slider';
  slider.setAttribute('aria-label', 'Brush size');
  const preview = document.createElement('div');
  preview.className = 'brush-preview';
  const dot = document.createElement('span');
  dot.className = 'brush-dot';
  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'brush-size-label';
  const paintPreview = (): void => {
    dot.style.width = `${penWidth}px`;
    dot.style.height = `${penWidth}px`;
    sizeLabel.textContent = `${penWidth} px`;
  };
  paintPreview();
  slider.addEventListener('input', () => {
    penWidth = Number(slider.value);
    paintPreview();
  });
  slider.addEventListener('change', () => { penWidth = Number(slider.value); save(); });
  preview.appendChild(dot);
  sizeWrap.appendChild(slider);
  sizeWrap.appendChild(preview);
  sizeWrap.appendChild(sizeLabel);
  toolbar.appendChild(sizeWrap);
  toolbar.appendChild(document.createElement('hr'));
  // Double swatches: front = foreground, back = background.
  // Clicking one makes it the active slot; the swap control (X) swaps them.
  const dbl = document.createElement('div');
  dbl.className = 'double-swatches';
  const pair = document.createElement('div');
  pair.className = 'pair';
  const back = document.createElement('button');
  back.className = 'dswatch back' + (activeSlot === 'bg' ? ' active' : '');
  back.style.background = bgColour;
  back.title = 'Background colour';
  back.setAttribute('aria-label', 'Background colour');
  back.addEventListener('click', () => { activeSlot = 'bg'; renderToolbar(); });
  const front = document.createElement('button');
  front.className = 'dswatch front' + (activeSlot === 'fg' ? ' active' : '');
  front.style.background = color;
  front.title = 'Foreground colour';
  front.setAttribute('aria-label', 'Foreground colour');
  front.addEventListener('click', () => { activeSlot = 'fg'; renderToolbar(); });
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
  // Palette dots: set the active slot's colour.
  const sw = document.createElement('div');
  sw.className = 'swatches';
  for (const c of COLORS) {
    const b = document.createElement('button');
    const slotValue = activeSlot === 'fg' ? color : bgColour;
    b.className = 'swatch' + (slotValue === c.value ? ' active' : '');
    b.style.background = c.value;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', () => {
      if (activeSlot === 'fg') color = c.value; else bgColour = c.value;
      save();
      renderToolbar();
    });
    sw.appendChild(b);
  }
  toolbar.appendChild(sw);
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
function amountScale(a: number): number { return a === 0.5 ? 0.5 : a === 2 ? 1.8 : 1; }
function smoothedAmps(it: Item, beat: number): number[] {
  let arr = smoothed.get(it.id);
  if (!arr) { arr = [0, 0, 0, 0, 0, 0]; smoothed.set(it.id, arr); }
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const target = it.pattern[b][beat] ? 1 : 0;
    arr[b] += (target - arr[b]) * 0.06;
    if (Math.abs(arr[b] - target) < 0.002) arr[b] = target;
  }
  return arr;
}
type Motion = { dx: number; dy: number; scale: number; rot: number; opacity: number };
function motionFor(it: Item, t01: number, beat: number): Motion {
  const amps = smoothedAmps(it, beat);
  const twoPi = Math.PI * 2;
  let dx = 0, dy = 0, scale = 1, rot = 0, opacity = 1;
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const a = amps[b];
    if (a < 0.01) continue;
    const sp = it.speeds[b] ?? 1;
    const am = amountScale(it.amounts[b] ?? 1);
    const ph = twoPi * sp * t01;
    if (b === 0) dy += a * am * 16 * Math.sin(ph); // Bob
    if (b === 1) dx += a * am * 16 * Math.sin(ph + Math.PI / 2); // Sway
    if (b === 2) scale += a * am * 0.08 * Math.sin(ph); // Breathe
    if (b === 3) opacity -= a * 0.85 * Math.pow(Math.max(0, Math.sin(ph)), 8); // Blink
    if (b === 4) rot += a * am * 0.35 * Math.sin(ph); // Spin
    if (b === 5) { dx += a * am * 18 * Math.sin(twoPi * 0.5 * sp * t01); dy += a * am * 14 * Math.sin(twoPi * 0.7 * sp * t01 + 1.3); } // Wander
  }
  return { dx, dy, scale, rot, opacity: Math.max(0.05, Math.min(1, opacity)) };
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
  // Keep the displayed stage fitting the area: scale down via CSS if needed.
  const area = document.getElementById('stage-area')!;
  const aw = area.clientWidth - 48, ah = area.clientHeight - 48;
  const s = Math.min(1, aw / w, ah / h);
  if (s < 1) {
    canvas.style.width = `${Math.floor(w * s)}px`;
    canvas.style.height = `${Math.floor(h * s)}px`;
  }
}
function drawItem(c: CanvasRenderingContext2D, it: Item, t01: number, beat: number): void {
  const b = itemBBox(it);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const m = motionFor(it, t01, beat);
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
function renderFrame(t01: number, beat: number, target: CanvasRenderingContext2D = ctx, dprOverride?: number): void {
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
  for (const it of items) drawItem(target, it, t01, beat);
  if (target === ctx && selected()) {
    const b = itemBBox(selected()!);
    const m = motionFor(selected()!, t01, beat);
    target.save();
    target.setLineDash([5, 4]);
    target.strokeStyle = '#007aff';
    target.lineWidth = 1.5;
    target.strokeRect(b.x + m.dx - 5, b.y + m.dy - 5, b.w + 10, b.h + 10);
    target.restore();
  }
  target.restore();
}

function currentBeat(): number {
  const t01 = playTime / LOOP_MS;
  return Math.min(BEATS - 1, Math.floor(t01 * BEATS));
}
function frame(ts: number): void {
  if (playing) {
    if (lastTs) playTime = (playTime + (ts - lastTs)) % LOOP_MS;
    lastTs = ts;
  } else {
    lastTs = 0;
  }
  const t01 = playTime / LOOP_MS;
  const beat = currentBeat();
  renderWithPreview(t01, beat);
  const dots = beatsEl.children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === beat);
  progressFill.style.width = `${(t01 * 100).toFixed(1)}%`;
  beatState.textContent = `Beat ${beat + 1} / ${BEATS}`;
  timeState.textContent = `${(playTime / 1000).toFixed(1)} / ${(LOOP_MS / 1000).toFixed(1)}s`;
  requestAnimationFrame(frame);
}

// ---------- panel helpers ----------
function segMini(
  options: { value: number; label: string }[],
  current: number,
  disabled: boolean,
  aria: string,
  onPick: (v: number) => void,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'seg-mini';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', aria);
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = o.value === current ? 'active' : '';
    b.disabled = disabled;
    b.textContent = o.label;
    b.addEventListener('click', () => onPick(o.value));
    wrap.appendChild(b);
  }
  return wrap;
}

function renderPanel(): void {
  const sel = selected();
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  undoBtn.disabled = history.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  panelBody.innerHTML = '';
  if (sel) {
    panelTitle.textContent = 'Behaviours';
    panelState.textContent = 'Selected part';
    const head = document.createElement('div');
    head.className = 'dhead';
    const headCells = document.createElement('div');
    headCells.className = 'dcells';
    for (let i = 0; i < BEATS; i++) {
      const s = document.createElement('span');
      s.textContent = String(i + 1);
      headCells.appendChild(s);
    }
    head.appendChild(headCells);
    panelBody.appendChild(head);
    for (let b = 0; b < BEHAVIOURS.length; b++) {
      const row = document.createElement('div');
      row.className = 'drow';
      const label = document.createElement('span');
      label.className = 'dlabel';
      label.textContent = BEHAVIOURS[b];
      row.appendChild(label);
      const cells = document.createElement('div');
      cells.className = 'dcells';
      for (let beat = 0; beat < BEATS; beat++) {
        const cell = document.createElement('button');
        cell.className = 'cell' + (sel.pattern[b][beat] ? ' on' : '');
        cell.setAttribute('aria-label', `${BEHAVIOURS[b]} beat ${beat + 1}`);
        cell.addEventListener('click', () => {
          const s = selected();
          if (!s) return;
          s.pattern[b][beat] = !s.pattern[b][beat];
          save();
          renderPanel();
        });
        cells.appendChild(cell);
      }
      row.appendChild(cells);
      const controls = document.createElement('div');
      controls.className = 'dcontrols';
      const speedGroup = document.createElement('div');
      speedGroup.className = 'dctl';
      const speedLabel = document.createElement('span');
      speedLabel.className = 'dctl-label';
      speedLabel.textContent = 'Speed';
      speedGroup.appendChild(speedLabel);
      speedGroup.appendChild(segMini(
        [{ value: 0.5, label: '0.5×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }],
        sel.speeds[b],
        false,
        `${BEHAVIOURS[b]} speed`,
        (v) => {
          const s = selected(); if (!s) return;
          s.speeds[b] = v; save(); renderPanel();
        },
      ));
      const amountGroup = document.createElement('div');
      amountGroup.className = 'dctl';
      const amountLabel = document.createElement('span');
      amountLabel.className = 'dctl-label';
      amountLabel.textContent = 'Amount';
      amountGroup.appendChild(amountLabel);
      amountGroup.appendChild(segMini(
        [{ value: 0.5, label: 'S' }, { value: 1, label: 'M' }, { value: 2, label: 'L' }],
        sel.amounts[b],
        false,
        `${BEHAVIOURS[b]} amount`,
        (v) => {
          const s = selected(); if (!s) return;
          s.amounts[b] = v; save(); renderPanel();
        },
      ));
      controls.appendChild(speedGroup);
      controls.appendChild(amountGroup);
      row.appendChild(controls);
      panelBody.appendChild(row);
    }
    return;
  }
  // Nothing selected: canvas properties.
  panelTitle.textContent = 'Canvas';
  panelState.textContent = items.length === 0 ? 'Empty stage' : `${items.length} part${items.length === 1 ? '' : 's'}`;
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
  for (const bg of STAGE_BGS) {
    const b = document.createElement('button');
    b.className = 'bg-dot' + (stageBgId === bg.id ? ' active' : '');
    b.style.background = bg.value;
    b.title = bg.label;
    b.setAttribute('aria-label', `Background ${bg.label}`);
    b.addEventListener('click', () => {
      stageBgId = bg.id;
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
function paintAt(p: Pt): void {
  const hit = hitTest(p);
  if (!hit) return; // nothing under the cursor: do nothing
  pushHistory();
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
function renderWithPreview(t01: number, beat: number): void {
  renderFrame(t01, beat);
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
  playBtn.innerHTML = (playing ? PAUSE_ICON : PLAY_ICON) + `<span>${playing ? 'Pause' : 'Play'}</span>`;
}
playBtn.addEventListener('click', () => {
  playing = !playing;
  setPlayLabel();
  if (playing) lastTs = 0;
});
function exportPNG(): void {
  const { w, h } = stageSize();
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  renderFrame(playTime / LOOP_MS, currentBeat(), octx, 1);
  off.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, 'manakin.png');
  }, 'image/png');
}
async function exportVideo(): Promise<void> {
  const btn = document.getElementById('video-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.title = 'Recording…'; }
  playerState.textContent = 'Recording video…';
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
  playerState.textContent = `Downloading ${filename} (${blob.size} bytes)`;
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
applyPanelOpen();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(frame);

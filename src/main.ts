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
const WIDTHS = [2, 4, 8];
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
type ToolId = 'select' | 'pen' | 'eraser' | 'shape' | 'text';
let tool: ToolId = 'pen';
let color = COLORS[0].value;
let penWidth = 4;
let shapeKind: 'rect' | 'ellipse' = 'rect';
let stageId: 'wide' | 'square' | 'portrait' = 'wide';
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
function save(): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ items, stageId }));
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
  renderDrumbox();
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
      const data = JSON.parse(raw) as { items: Item[]; stageId: typeof stageId };
      if (Array.isArray(data.items) && data.items.length > 0) {
        items = data.items;
        if (data.stageId) stageId = data.stageId;
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
    <span id="live-state"></span>
  </div>
  <div id="stage-picker" class="seg" role="group" aria-label="Stage size"></div>
  <div class="header-actions">
    <button class="hbtn" id="undo-btn" title="Undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
    <button class="hbtn" id="redo-btn" title="Redo" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
    <span class="vdiv"></span>
    <button class="hbtn" id="clear-btn" title="Clear" aria-label="Clear"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg></button>
    <button class="hbtn" id="png-btn" title="PNG" aria-label="Export PNG"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="m21 15-5-5-9 9"/></svg></button>
    <button class="hbtn" id="video-btn" title="Video" aria-label="Export video"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg></button>
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
<div id="drumbox">
  <div id="drumbox-head">
    <h2>Behaviours</h2>
    <span id="drumbox-state">Select a part</span>
    <span class="spacer"></span>
    <div id="beats" aria-label="Beat"></div>
    <button id="play-btn"><svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg><span>Play</span></button>
  </div>
  <div id="grid"></div>
</div>`;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const stageWrap = document.getElementById('stage-wrap')!;
const textEditor = document.getElementById('text-editor') as HTMLTextAreaElement;
const liveState = document.getElementById('live-state')!;
const drumboxState = document.getElementById('drumbox-state')!;
const playBtn = document.getElementById('play-btn')!;
const beatsEl = document.getElementById('beats')!;
const gridEl = document.getElementById('grid')!;
const stagePicker = document.getElementById('stage-picker')!;

for (let b = 0; b < BEATS; b++) {
  const dot = document.createElement('span');
  beatsEl.appendChild(dot);
}

function renderStagePicker(): void {
  stagePicker.innerHTML = '';
  for (const s of STAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = stageId === s.id ? 'active' : '';
    b.textContent = s.label;
    b.setAttribute('aria-label', `Stage ${s.label}`);
    b.addEventListener('click', () => {
      stageId = s.id;
      renderStagePicker();
      resizeCanvas();
      save();
    });
    stagePicker.appendChild(b);
  }
}
renderStagePicker();

// ---------- toolbar ----------
const TOOLS: { id: ToolId; label: string; key: string; svg: string }[] = [
  { id: 'select', label: 'Select', key: 'V', svg: '<path d="M5 3l14 7-6 2-3 6z"/>' },
  { id: 'pen', label: 'Pen', key: 'P', svg: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M13 8l3 3"/>' },
  { id: 'eraser', label: 'Eraser', key: 'X', svg: '<path d="M7 20h10"/><path d="M5 15l8-8 4 4-5 5H9z"/>' },
  { id: 'shape', label: 'Shape', key: 'E', svg: '<rect x="4" y="4" width="16" height="16" rx="2"/>' },
  { id: 'text', label: 'Text', key: 'T', svg: '<path d="M5 6h14M12 6v13"/>' },
];
const toolbar = document.getElementById('toolbar')!;
function renderToolbar(): void {
  toolbar.innerHTML = '';
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool' + (tool === t.id ? ' active' : '');
    b.title = `${t.label} (${t.key})`;
    b.setAttribute('aria-label', t.label);
    b.innerHTML = `<svg viewBox="0 0 24 24">${t.svg}</svg>`;
    b.addEventListener('click', () => { tool = t.id; renderToolbar(); updateCursor(); });
    toolbar.appendChild(b);
  }
  const hr = document.createElement('hr');
  toolbar.appendChild(hr);
  const sw = document.createElement('div');
  sw.className = 'swatches';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (color === c.value ? ' active' : '');
    b.style.background = c.value;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', () => { color = c.value; renderToolbar(); });
    sw.appendChild(b);
  }
  toolbar.appendChild(sw);
  const hr2 = document.createElement('hr');
  toolbar.appendChild(hr2);
  const wdiv = document.createElement('div');
  wdiv.className = 'widths';
  for (const w of WIDTHS) {
    const b = document.createElement('button');
    b.className = penWidth === w ? 'active' : '';
    b.textContent = String(w);
    b.title = `Width ${w}`;
    b.addEventListener('click', () => { penWidth = w; renderToolbar(); });
    wdiv.appendChild(b);
  }
  toolbar.appendChild(wdiv);
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
  const aw = area.clientWidth - 32, ah = area.clientHeight - 32;
  const s = Math.min(1, aw / w, ah / h);
  if (s < 1) {
    canvas.style.width = `${Math.floor(w * s)}px`;
    canvas.style.height = `${Math.floor(h * s)}px`;
  }
  // The drumbox card matches the stage as it is actually shown,
  // never narrower than its own grid.
  const drumbox = document.getElementById('drumbox');
  if (drumbox) {
    const shown = canvas.getBoundingClientRect().width;
    drumbox.style.width = `${Math.max(640, Math.min(960, Math.round(shown)))}px`;
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
  target.fillStyle = '#ffffff';
  target.fillRect(0, 0, w, h);
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
  requestAnimationFrame(frame);
}

// ---------- drumbox ----------
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

function renderDrumbox(): void {
  const sel = selected();
  drumboxState.textContent = sel ? 'Selected part' : 'Select a part';
  gridEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'dhead';
  head.innerHTML = `<span class="dlabel"></span>${Array.from({ length: BEATS }, (_, i) => `<span>${i + 1}</span>`).join('')}<span class="sp sp-speed">Speed</span><span class="sp sp-amount">Amount</span>`;
  gridEl.appendChild(head);
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const row = document.createElement('div');
    row.className = 'drow';
    const label = document.createElement('span');
    label.className = 'dlabel';
    label.textContent = BEHAVIOURS[b];
    row.appendChild(label);
    for (let beat = 0; beat < BEATS; beat++) {
      const cell = document.createElement('button');
      cell.className = 'cell' + (sel && sel.pattern[b][beat] ? ' on' : '');
      cell.disabled = !sel;
      cell.setAttribute('aria-label', `${BEHAVIOURS[b]} beat ${beat + 1}`);
      cell.addEventListener('click', () => {
        const s = selected();
        if (!s) return;
        s.pattern[b][beat] = !s.pattern[b][beat];
        save();
        renderDrumbox();
      });
      row.appendChild(cell);
    }
    row.appendChild(segMini(
      [{ value: 0.5, label: '0.5×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }],
      sel ? sel.speeds[b] : 1,
      !sel,
      `${BEHAVIOURS[b]} speed`,
      (v) => {
        const s = selected(); if (!s) return;
        s.speeds[b] = v; save(); renderDrumbox();
      },
    ));
    row.appendChild(segMini(
      [{ value: 0.5, label: 'S' }, { value: 1, label: 'M' }, { value: 2, label: 'L' }],
      sel ? sel.amounts[b] : 1,
      !sel,
      `${BEHAVIOURS[b]} amount`,
      (v) => {
        const s = selected(); if (!s) return;
        s.amounts[b] = v; save(); renderDrumbox();
      },
    ));
    gridEl.appendChild(row);
  }
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
  undoBtn.disabled = history.length === 0;
  redoBtn.disabled = redoStack.length === 0;
  liveState.textContent = items.length === 0 ? 'Empty stage' : `${items.length} part${items.length === 1 ? '' : 's'}${sel ? ' · 1 selected' : ''}`;
}

// ---------- pointer ----------
function stagePoint(e: { clientX: number; clientY: number }): Pt {
  const rect = canvas.getBoundingClientRect();
  const { w, h } = stageSize();
  return { x: ((e.clientX - rect.left) / rect.width) * w, y: ((e.clientY - rect.top) / rect.height) * h };
}
let drag: {
  kind: 'pen' | 'shape' | 'select' | 'erase';
  start: Pt; last: Pt; item: Item | null; moved: boolean;
} | null = null;
let previewShape: ShapeItem | null = null;

canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  const p = stagePoint(e);
  if (tool === 'pen') {
    pushHistory();
    const stroke: StrokeItem = { ...baseItem(color, penWidth), type: 'stroke', points: [p] };
    items.push(stroke);
    drag = { kind: 'pen', start: p, last: p, item: stroke, moved: false };
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
      renderDrumbox();
      drag = { kind: 'select', start: p, last: p, item: hit, moved: false };
    } else {
      selectedId = null;
      renderDrumbox();
      drag = null;
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = stagePoint(e);
  if (drag.kind === 'pen' && drag.item?.type === 'stroke') {
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
  if (drag.kind === 'pen' || drag.kind === 'erase') save();
  previewShape = null;
  drag = null;
  renderDrumbox();
});
function eraseAt(p: Pt): void {
  const hit = hitTest(p);
  if (hit) {
    items = items.filter((i) => i.id !== hit.id);
    if (selectedId === hit.id) selectedId = null;
    smoothed.delete(hit.id);
    renderDrumbox();
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
      renderDrumbox();
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

// ---------- header ----------
(document.getElementById('undo-btn') as HTMLButtonElement).addEventListener('click', undo);
(document.getElementById('redo-btn') as HTMLButtonElement).addEventListener('click', redo);
(document.getElementById('clear-btn') as HTMLButtonElement).addEventListener('click', () => {
  if (items.length === 0) return;
  pushHistory();
  items = [];
  selectedId = null;
  smoothed.clear();
  save();
  renderDrumbox();
});
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
(document.getElementById('png-btn') as HTMLButtonElement).addEventListener('click', () => {
  const { w, h } = stageSize();
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d')!;
  renderFrame(playTime / LOOP_MS, currentBeat(), octx, 1);
  off.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, 'manakin.png');
  }, 'image/png');
});
(document.getElementById('video-btn') as HTMLButtonElement).addEventListener('click', async () => {
  const btn = document.getElementById('video-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.title = 'Recording…';
  liveState.textContent = 'Recording video…';
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
  btn.disabled = false;
  btn.classList.remove('busy');
  btn.title = 'Video';
});
function downloadBlob(blob: Blob, filename: string): void {
  liveState.textContent = `Downloading ${filename} (${blob.size} bytes)`;
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
    if (sel) { pushHistory(); items = items.filter((i) => i.id !== sel.id); selectedId = null; save(); renderDrumbox(); }
    return;
  }
  if (k === 'v') tool = 'select';
  else if (k === 'p') tool = 'pen';
  else if (k === 'x') tool = 'eraser';
  else if (k === 'e') { if (tool === 'shape') shapeKind = shapeKind === 'rect' ? 'ellipse' : 'rect'; tool = 'shape'; }
  else if (k === 't') tool = 'text';
  else return;
  renderToolbar();
  updateCursor();
});

// ---------- init ----------
// Drumbox first: resizeCanvas sizes the stage against the area left
// after the drumbox, and syncs the drumbox width to the shown stage.
load();
renderStagePicker();
renderDrumbox();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
requestAnimationFrame(frame);

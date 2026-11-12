import './styles.css';
import { initPlugins, listActions, isOverlayOpenFor, closeOverlays, clickInsideOverlay, anyOverlayOpen, refreshOverlays, domId, registerShellElements, emitPluginEvent, requestCanvasResize, renderFrameTo, renderFrameAtTo, getPanelView, closePanelTransients, type PluginHost, type PanelContext, type PanelViewDef } from './plugins';
import { plugin as canvasPlugin } from './core-plugins/canvas';
import { plugin as toolbarPlugin } from './core-plugins/toolbar';
import { plugin as playerPlugin } from './core-plugins/player';
import { plugin as framesPlugin } from './core-plugins/frames';
import { plugin as exportsPlugin } from './core-plugins/exports';
import { plugin as behavioursPlugin } from './core-plugins/behaviours';
import { plugin as helloPlugin } from './core-plugins/hello';
import {
  ALIGN_ICONS,
  ARRANGE_ICONS,
  DEFAULT_LOOP_LENGTH,
  FRAME_HOLD_MAX,
  FRAME_HOLD_MIN,
  GRID_OPTIONS,
  LOOP_LENGTHS,
  SAVE_KEY,
  STAGES,
  STAGE_BGS,
  TIMELINE_FPS,
  ZOOM_STOPS,
  clampAxis,
  clearSmoothed,
  frameIndexAtTime,
  frameStartMs,
  hexToHsv,
  hsvToHex,
  isLoopLength,
  itemBBox,
  loopMs as loopMsFor,
  migrateGridMode,
  migrateItem,
  migrateItemGroups,
  migrateTimeline,
  moveItem,
  newFrame,
  nid,
  normDeg,
  normHex,
  pruneSmoothed,
  sampleBird,
  stageBgValueFor,
  stageSizeFor,
  timelineDurationMs,
  totalTimelineFrames,
  workspaceLayoutFor,
} from "./model";
import type {
  GridMode,
  Item,
  ItemBase,
  ItemGroup,
  LoopLength,
  StageBgId,
  Timeline,
  ToolId,
} from "./model";

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


// ---------- state ----------
// `items` is the live binding: always the current frame's items.
// Everything reads it; a frame switch rebinds it.
let items: Item[] = [];
// The timeline: the frames, the fps, and which frame is being edited.
// A save without one migrates to a single frame holding its items.
let timeline: Timeline = { frames: [newFrame([])], fps: TIMELINE_FPS, current: 0 };
let onionSkin = true; // ghost the neighbouring frames on screen
// Item groups: containers of canvas items with their own behaviour
// layers — distinct from BehaviourGroup (v9, per-item collections of
// behaviour layers). Flat only, no nesting, no groups in groups.
let itemGroups: ItemGroup[] = [];
// Ordered selection; empty = nothing selected. A click on a group
// member selects the whole group; shift-click toggles one item.
let selectedIds: string[] = [];
function selectedItems(): Item[] {
  return selectedIds.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);
}
// The single selected item, or null for a multi-selection / none.
// Single-item call sites (delete, text edit) use this.
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
// Membership is tested against every frame's items: a group lives in
// the frame it was made in, and viewing another frame must not
// dissolve it.
function pruneItemGroups(): void {
  const all = timeline.frames.flatMap((f) => f.items);
  for (const g of itemGroups) g.memberIds = [...new Set(g.memberIds.filter((m) => all.some((i) => i.id === m)))];
  itemGroups = itemGroups.filter((g) => g.memberIds.length >= 2);
}

// ---------- frames ----------
// The frame switch itself: timeline.current, the live items binding,
// and the 'timeline' event the filmstrip follows. No history, no
// panel re-render — the player calls this up to fps times a second,
// and the panel rebuilds only on user action. The selection goes
// dormant on a switch (its ids are not in the other frame), and the
// outline returns when its frame comes back.
function switchFrame(i: number): void {
  timeline.current = i;
  items = timeline.frames[i].items;
  emitPluginEvent('timeline');
}

// A user-initiated frame switch (filmstrip click): the playhead jumps
// to the frame's start, the selection clears (its items are not in
// this frame), and the panel re-renders for the new frame.
function setCurrentFrame(index: number): void {
  const i = Math.max(0, Math.min(timeline.frames.length - 1, Math.floor(index)));
  if (i === timeline.current) return;
  switchFrame(i);
  playTime = frameStartMs(timeline, i);
  selectedIds = [];
  focusedId = null;
  renderPanel();
}

// `+` adds a copy of the current frame, so the drawing is there to
// change — the way a flipbook artist traces the previous drawing.
function addFrame(): void {
  pushHistory();
  const copy = timeline.frames[timeline.current].items.map((it) => cloneItemWithOffset(it, 0, 0));
  const frame = newFrame(copy);
  timeline.frames.splice(timeline.current + 1, 0, frame);
  timeline.current += 1;
  items = frame.items;
  playTime = frameStartMs(timeline, timeline.current);
  selectedIds = [];
  focusedId = null;
  save();
  emitPluginEvent('timeline');
  renderPanel();
}

// Duplicate inserts a copy after the frame and lands on it, so the
// copy is the one being edited.
function duplicateFrame(index: number): void {
  if (index < 0 || index >= timeline.frames.length) return;
  pushHistory();
  const copy = timeline.frames[index].items.map((it) => cloneItemWithOffset(it, 0, 0));
  const frame = newFrame(copy, timeline.frames[index].duration);
  timeline.frames.splice(index + 1, 0, frame);
  timeline.current = index + 1;
  items = frame.items;
  playTime = frameStartMs(timeline, timeline.current);
  selectedIds = [];
  focusedId = null;
  save();
  emitPluginEvent('timeline');
  renderPanel();
}

function deleteFrame(index: number): void {
  if (timeline.frames.length <= 1) return;
  if (index < 0 || index >= timeline.frames.length) return;
  pushHistory();
  timeline.frames.splice(index, 1);
  // Deleting the current frame moves to the frame that took its place;
  // deleting a frame before it shifts the index down.
  if (timeline.current >= timeline.frames.length) timeline.current = timeline.frames.length - 1;
  else if (timeline.current > index) timeline.current -= 1;
  items = timeline.frames[timeline.current].items;
  playTime = frameStartMs(timeline, timeline.current);
  selectedIds = [];
  focusedId = null;
  pruneItemGroups();
  save();
  emitPluginEvent('timeline');
  renderPanel();
}

// `to` is the insertion index (0..frames.length); the frame moves
// before it. Dropping a tile on its own position is a no-op.
function moveFrame(from: number, to: number): void {
  const n = timeline.frames.length;
  if (from < 0 || from >= n) return;
  const insert = Math.max(0, Math.min(n, Math.floor(to)));
  if (insert === from || insert === from + 1) return;
  pushHistory();
  const [frame] = timeline.frames.splice(from, 1);
  const at = insert > from ? insert - 1 : insert;
  timeline.frames.splice(at, 0, frame);
  if (timeline.current === from) timeline.current = at;
  else if (from < timeline.current && at >= timeline.current) timeline.current -= 1;
  else if (from > timeline.current && at <= timeline.current) timeline.current += 1;
  items = timeline.frames[timeline.current].items;
  playTime = frameStartMs(timeline, timeline.current);
  save();
  emitPluginEvent('timeline');
  renderPanel();
}

function setFrameHold(index: number, duration: number): void {
  const frame = timeline.frames[index];
  if (!frame) return;
  const d = Math.max(FRAME_HOLD_MIN, Math.min(FRAME_HOLD_MAX, Math.round(duration)));
  if (frame.duration === d) return;
  pushHistory();
  frame.duration = d;
  // A hold change before the playhead shifts the timings, so the
  // frame being edited is re-derived from the playhead.
  playTime = playTime % loopMs();
  const fi = frameIndexAtTime(timeline, playTime);
  if (fi !== timeline.current) {
    timeline.current = fi;
    items = timeline.frames[fi].items;
    selectedIds = [];
    focusedId = null;
  }
  save();
  emitPluginEvent('timeline');
  renderPanel();
}
// Double-click focus (view state only — never saved, never an undo entry):
// the focused part renders full, every other part at 0.1.
let focusedId: string | null = null;
// Double-click pair tracking: the second press of a pair must not fire
// paint or open the text editor a second time.
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
let panelView: 'auto' | 'colour' = 'auto';
// One-time migration seed for plugins: values the core used to own
// that now belong to a plugin (the Exports plugin's tab and format
// used to live in manakin-v1). Populated by load(), read by the
// plugin at activate, then forgotten.
let legacyExportPrefs: Record<string, unknown> = {};
// The live action buttons, rebuilt by renderCanvasPanel on every
// panel render: the plugin system looks an anchor button up here.
// Cleared at the top of renderPanelInner, populated by the Actions
// section; empty whenever the Canvas panel is not showing.
const actionButtons = new Map<string, HTMLButtonElement>();
let colourSlot: 'fg' | 'bg' = 'fg';
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
let zoom = 1;
// Pan is view state only, like zoom: not in the undo snapshot, not
// saved, resets to 0 on reload. It shifts the stage origin in
// workspace pixels, on top of the centred fit × zoom.
let panX = 0;
let panY = 0;
let spaceHeld = false;
// Rotation is view state only, like zoom and pan: not in the undo
// snapshot, not saved, resets to 0 on reload. It rotates the whole
// workspace view around the centre of the visible workspace —
// never the artwork, never exports.
let rotateDeg = 0; // degrees, kept normalised to [0, 360)
let rotateHeld = false;
function clampPan(): void {
  const cw = stageWrap.clientWidth, ch = stageWrap.clientHeight;
  const { w, h } = stageSize();
  const fit = Math.min(1, cw / w, ch / h) || 1;
  const s = fit * zoom;
  panX = clampAxis(panX, (cw - w * s) / 2, w * s, cw);
  panY = clampAxis(panY, (ch - h * s) / 2, h * s, ch);
}
function setZoom(z: number): void {
  zoom = z;
  clampPan(); // zoom keeps the current pan, clamped to the new zoom
  emitPluginEvent('view');
}
// Zoom reset also re-centres the view: 100%, no pan, no rotation.
function resetView(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
  rotateDeg = 0;
  emitPluginEvent('view');
}
// Zoom-only reset for the zoom label: 100%, no pan, rotation untouched.
// The zoom cluster must never modify the angle — rotation is reset
// only by the full view reset (Cmd/Ctrl+0).
function resetZoom(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
  emitPluginEvent('view');
}
function zoomStep(dir: 1 | -1): void {
  const i = ZOOM_STOPS.indexOf(zoom);
  if (i === -1) { setZoom(dir === 1 ? (ZOOM_STOPS.find((s) => s > zoom) ?? 4) : ([...ZOOM_STOPS].reverse().find((s) => s < zoom) ?? 0.25)); return; }
  setZoom(ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, i + dir))]);
}
let history: string[] = [];
let redoStack: string[] = [];

function slotColour(): string { return activeSlot === 'fg' ? color : bgColour; }
function setSlotColour(hex: string): void {
  if (activeSlot === 'fg') color = hex; else bgColour = hex;
}
function pushRecent(hex: string): void {
  const h = hex.toLowerCase();
  recentColours = [h, ...recentColours.filter((c) => c !== h)].slice(0, 8);
}
// Thin wrappers over the model: the model takes its inputs as
// arguments, the shell reads them from module state.
function loopMs(): number {
  // A single-frame timeline plays the behaviour loop (the Loop
  // setting); a multi-frame timeline plays the whole timeline at fps.
  return timeline.frames.length <= 1 ? loopMsFor(loopLength) : timelineDurationMs(timeline);
}
function stageSize(): { w: number; h: number } {
  return stageSizeFor(stageId);
}
function stageBgValue(): string {
  return stageBgValueFor(stageBgId, stageBgCustom);
}
// Tool and shape-kind changes go through here so the toolbar and the
// canvas hear about them (the "tool" / "pen" events).
function setTool(t: ToolId): void {
  tool = t;
  emitPluginEvent('tool');
}
function setShapeKind(k: 'rect' | 'ellipse'): void {
  shapeKind = k;
  emitPluginEvent('pen');
}
function save(): void {
  try {
    // The timeline is saved without `current`: reloading opens on
    // frame 0. The onion-skin toggle is a preference, saved alongside.
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      timeline: { frames: timeline.frames, fps: timeline.fps }, onionSkin,
      itemGroups, stageId, loopLength, projectName, stageBgId, stageBgCustom, gridMode, panelOpen,
      fg: color, bg: bgColour, penWidth, recent: recentColours, saved: savedColours,
    }));
  } catch { /* storage full or unavailable */ }
}
function snapshot(): string {
  // The whole document state: the timeline (including which frame was
  // being edited, so undoing a gesture restores that frame), item
  // groups, stage size, loop length, background and grid. Tool
  // settings (pen width, colours, project name) are not document
  // state and stay out of undo.
  return JSON.stringify({ timeline, itemGroups, stageId, loopLength, stageBgId, stageBgCustom, gridMode });
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
      // A bare items array: a pre-timeline snapshot shape.
      timeline = { frames: [newFrame(data as Item[])], fps: TIMELINE_FPS, current: 0 };
      itemGroups = [];
    } else if (data && typeof data === 'object') {
      const d = data as {
        timeline?: unknown; items?: Item[]; itemGroups?: unknown; stageId?: typeof stageId; stageBgId?: StageBgId;
        stageBgCustom?: string | null; gridMode?: unknown; loopLength?: unknown;
      };
      if (d.timeline !== undefined) {
        const migrated = migrateTimeline(d.timeline);
        if (migrated) timeline = migrated;
      }
      if (Array.isArray(d.items) && d.timeline === undefined) {
        // Pre-timeline snapshot: the items are the one frame.
        timeline = { frames: [newFrame(d.items)], fps: TIMELINE_FPS, current: 0 };
      }
      itemGroups = migrateItemGroups(d.itemGroups, timeline.frames.flatMap((f) => f.items));
      if (d.stageId === 'wide' || d.stageId === 'square' || d.stageId === 'portrait') stageId = d.stageId;
      if (isLoopLength(d.loopLength)) loopLength = d.loopLength;
      if (d.stageBgId) stageBgId = d.stageBgId;
      stageBgCustom = typeof d.stageBgCustom === 'string' ? d.stageBgCustom : null;
      const gm = migrateGridMode(d.gridMode);
      if (gm !== null) gridMode = gm;
    }
  } catch { /* corrupted history entry: keep current items */ }
  timeline.frames.forEach((f) => f.items.forEach(migrateItem)); // undo snapshots from older saves may lack the newer parameter fields
  items = timeline.frames[timeline.current].items;
  pruneItemGroups();
  selectedIds = selectedIds.filter((id) => items.some((i) => i.id === id));
  // Keep the eased amplitudes of layers that still exist: clearing them
  // restarts every behaviour from 0, so after an undo the pose visibly
  // snaps and re-eases over ~1s even while paused. Only entries whose
  // layer is gone are dropped — a layer id is never reused, so a
  // dropped entry is never read again.
  const liveLayerIds = new Set<string>();
  for (const it of timeline.frames.flatMap((f) => f.items)) for (const l of it.layers) liveLayerIds.add(l.id);
  for (const g of itemGroups) for (const l of g.layers) liveLayerIds.add(l.id);
  pruneSmoothed(liveLayerIds);
  // A restored snapshot may carry a shorter loop than the current
  // playhead (e.g. undoing a 10s → 4s change while paused at 9s);
  // keep the playhead inside the loop. And the playhead must sit
  // inside the restored frame: if it does not (the snapshot was taken
  // on another frame), jump to that frame's start.
  playTime = playTime % loopMs();
  const fi = frameIndexAtTime(timeline, playTime);
  if (fi !== timeline.current) playTime = frameStartMs(timeline, timeline.current);
  save();
  requestCanvasResize();
  renderPanel();
  // Undo/redo restores the timeline too: the filmstrip only re-renders
  // on the timeline event, so without this it keeps showing the
  // pre-undo frames while the model has already moved.
  emitPluginEvent('timeline');
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

// ---------- sample ----------

function load(): void {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as {
        timeline?: unknown; items?: Item[]; itemGroups?: unknown; stageId: typeof stageId; projectName?: string;
        stageBgId?: StageBgId; stageBgCustom?: string | null; gridMode?: unknown; panelOpen?: boolean;
        fg?: string; bg?: string; penWidth?: number; recent?: string[]; saved?: string[];
        videoFormat?: unknown; exportTab?: unknown; loopLength?: unknown; onionSkin?: boolean;
      };
      // The tab and video format used to live in this save; they
      // belong to the Exports plugin now. Keep them as the one-time
      // migration seed the plugin reads at activate. This is about
      // the save's preferences, not its items, so it runs for any
      // parseable save — including one with no items.
      if (data.videoFormat === 'gif' || data.videoFormat === 'webm' || data.videoFormat === 'mp4') legacyExportPrefs.videoFormat = data.videoFormat;
      if (data.exportTab === 'png' || data.exportTab === 'video') legacyExportPrefs.exportTab = data.exportTab;
      // Shared fields load the same way for both save shapes.
      if (data.stageId) stageId = data.stageId;
      if (isLoopLength(data.loopLength)) loopLength = data.loopLength;
      if (typeof data.projectName === 'string' && data.projectName.trim()) projectName = data.projectName;
      if (data.stageBgId && (STAGE_BGS.some((b) => b.id === data.stageBgId) || data.stageBgId === 'custom')) stageBgId = data.stageBgId;
      if (typeof data.stageBgCustom === 'string') stageBgCustom = data.stageBgCustom;
      const gm = migrateGridMode(data.gridMode);
      if (gm !== null) gridMode = gm;
      if (typeof data.panelOpen === 'boolean') panelOpen = data.panelOpen;
      if (typeof data.fg === 'string') color = data.fg;
      if (typeof data.bg === 'string') bgColour = data.bg;
      if (typeof data.penWidth === 'number' && data.penWidth >= 2 && data.penWidth <= 32) penWidth = data.penWidth;
      if (Array.isArray(data.recent)) recentColours = data.recent.filter((c) => typeof c === 'string').slice(0, 8);
      if (Array.isArray(data.saved)) savedColours = data.saved.filter((c) => typeof c === 'string');
      if (typeof data.onionSkin === 'boolean') onionSkin = data.onionSkin;
      // A save with a timeline loads it (reloading opens on frame 0);
      // a save without one — every save before the timeline — migrates
      // to a single frame holding its items. An empty save (0 items)
      // is a real document: it loads as an empty stage.
      const migrated = migrateTimeline(data.timeline);
      if (migrated) {
        timeline = migrated;
        timeline.current = 0;
        items = timeline.frames[0].items;
        itemGroups = migrateItemGroups(data.itemGroups, timeline.frames.flatMap((f) => f.items));
        return;
      }
      if (Array.isArray(data.items)) {
        items = data.items;
        items.forEach(migrateItem);
        itemGroups = migrateItemGroups(data.itemGroups, items);
        timeline = { frames: [newFrame(items)], fps: TIMELINE_FPS, current: 0 };
        items = timeline.frames[0].items;
        return;
      }
    }
  } catch { /* corrupted save: fall through to sample */ }
  items = sampleBird();
  // The sample bird already carries new-format layer instances; migrate
  // only validates them (and drops any legacy fields).
  items.forEach(migrateItem);
  timeline = { frames: [newFrame(items)], fps: TIMELINE_FPS, current: 0 };
  items = timeline.frames[0].items;
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
        <div id="stage-wrap"></div>
      </div>
    </div>
    <div id="filmstrip"></div>
    <footer id="player"></footer>
  </div>
  <aside id="panel" aria-label="Panel">
    <div id="panel-head">
      <h2 id="panel-title">Canvas</h2>
    </div>
    <div id="panel-body"></div>
  </aside>
</div>`;

const stageWrap = document.getElementById('stage-wrap')!;
const panelEl = document.getElementById('panel')!;
const panelTitle = document.getElementById('panel-title')!;
const panelBody = document.getElementById('panel-body')!;
const projectInput = document.getElementById('project-name') as HTMLInputElement;
const panelBtn = document.getElementById('panel-btn') as HTMLButtonElement;

function applyPanelOpen(): void {
  panelEl.style.display = panelOpen ? 'flex' : 'none';
  panelBtn.classList.toggle('active', panelOpen);
  requestAnimationFrame(() => requestCanvasResize());
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

// The toolbar shell element: the toolbar plugin builds inside it.
const toolbar = document.getElementById('toolbar')!;
function swapColors(): void {
  const t = color;
  color = bgColour;
  bgColour = t;
  save();
  emitPluginEvent('pen');
}
function openColour(slot: 'fg' | 'bg'): void {
  // A fresh panel open reads the hue from the colour (0 = left end);
  // the 360 state only lives within one open panel session.
  colourHue360 = false;
  // Clicking the open swatch again closes the Colour view.
  if (panelView === 'colour' && colourSlot === slot) {
    panelView = 'auto';
    emitPluginEvent('pen');
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
  emitPluginEvent('pen');
  renderPanel();
}



// ---------- panel helpers ----------
// Custom-styled continuous slider row: label + range input + live value text.
// onInput runs live (graph redraw); onCommit runs on release (save).
let lastPanelKey = '';
function renderPanel(): void {
  const grp = selectedItemGroup();
  const sel = selected();
  const key = panelView + '|' + (grp ? 'g:' + grp.id : sel ? 'i:' + sel.id : selectedIds.length >= 2 ? 'm:' + selectedIds.join(',') : 'canvas');
  const st = panelBody.scrollTop;
  // A plugin can claim the panel for a selection: the first matching
  // panel view wins (Behaviours, when that plugin is on). Nothing
  // matching falls back to the core panels below.
  const viewCtx: PanelContext = { selectedItems: selectedItems(), selectedGroup: grp };
  const view = panelView === 'auto' ? getPanelView(viewCtx) : null;
  renderPanelInner(view, viewCtx);
  // The panel rebuilds its DOM on every render, which drops the scroll
  // position: rebuilding while scrolled clamps scrollTop to 0. Keep the
  // scroll where it was when the same stack is still showing; a different
  // stack (another part, a group, the Canvas panel) starts at the top.
  panelBody.scrollTop = key === lastPanelKey ? st : 0;
  lastPanelKey = key;
  // A view's afterRender (scroll-into-view) runs after the scroll
  // restore, so the restore does not undo it.
  view?.afterRender?.(viewCtx, panelBody);
  // Open plugin overlays are rebuilt last, after the scroll restore:
  // their anchor button was rebuilt with the panel, so the overlay
  // must be re-anchored to it. An open overlay whose anchor is gone
  // (the panel switched away) is closed instead.
  refreshOverlays();
}
function renderPanelInner(view: PanelViewDef | null, viewCtx: PanelContext): void {
  syncUndoButtons();
  closeTooltipEl();
  actionButtons.clear();
  const grp = selectedItemGroup();
  const sel = selected();
  panelBody.innerHTML = '';
  if (panelView === 'colour') { renderColourPanel(); return; }
  if (view) {
    view.render(viewCtx, panelBody, (t) => { panelTitle.textContent = t; });
    return;
  }
  if (grp) { renderItemGroupFallback(grp); return; }
  if (sel) { renderSingleItemFallback(); return; }
  if (selectedIds.length >= 2) { renderMultiSelectPanel(selectedItems()); return; }
  renderCanvasPanel();
}

// A single selected item with the Behaviours plugin off: the panel is
// Arrange only — there is no behaviour stack to show.
function renderSingleItemFallback(): void {
  panelTitle.textContent = 'Selection';
  panelBody.appendChild(renderArrangeSection());
}

// A selected item group with the Behaviours plugin off: Arrange plus
// Ungroup objects — the group's behaviour stack is the plugin's.
function renderItemGroupFallback(group: ItemGroup): void {
  panelTitle.textContent = 'Selection';
  panelBody.appendChild(renderArrangeSection());
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
}

// Group the current multi-selection into an item group: the members
// move together and share the group's behaviours. Members are first
// pulled out of any old groups, and a group left with fewer than two
// members dissolves (its layers go with it).
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

// One shared tooltip for the Arrange/Align hints (and the zoom −/+
// cells): a small frosted pill centred above the hovered button, 6px
// gap, shown after a short hover delay; hidden on mouseleave, click,
// panel re-render, panel scroll and window resize. A click also
// suppresses any re-show while the mouse stays put: the action
// re-renders the panel, which recreates the button under a stationary
// cursor and would otherwise re-trigger the hover immediately.
// The pill may overlap the section label or other elements above the
// button while showing — that is accepted, per the user, not a defect.
// If there is no room above the viewport it falls back to below.
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
      const top = above >= 8 ? above : r.bottom + 6;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
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
      requestCanvasResize();
      renderPanel();
    });
    stageSeg.appendChild(b);
  }
  stageSec.appendChild(stageSeg);
  const loopSec = mkSection('Loop');
  if (timeline.frames.length > 1) {
    // A multi-frame timeline's length is the timeline itself: the
    // frames at fps. The Loop setting only drives the single-frame
    // behaviour loop, so it reads as a live readout instead of the seg.
    const total = totalTimelineFrames(timeline);
    const secs = timelineDurationMs(timeline) / 1000;
    const readout = document.createElement('div');
    readout.className = 'loop-readout';
    readout.textContent = `${secs.toFixed(1)}s · ${total} frames @ ${timeline.fps} fps`;
    loopSec.appendChild(readout);
  } else {
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
  }
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
      requestCanvasResize();
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
  // Plugin actions, in registration order, between Save and Clear.
  // The Export button comes from the Exports plugin; disabling that
  // plugin removes it and the rest of the Actions section is
  // untouched. A chevron action gets the Export-style treatment
  // (label centred, chevron at the right edge). An action's click
  // never reaches the document's outside-click handler, so an action
  // that opens an overlay does not immediately close it.
  for (const a of listActions()) {
    const b = document.createElement('button');
    b.type = 'button';
    // Copied from Bowerbird: a DOM id namespaced by plugin, so two
    // plugins' actions never collide in the document.
    b.id = domId(a.pluginId, 'action', a.id);
    b.className = 'pbtn' + (a.chevron ? ' export-btn' : '') + (isOverlayOpenFor(a.pluginId, a.id) ? ' open' : '');
    if (a.chevron) {
      b.setAttribute('aria-haspopup', 'true');
      b.setAttribute('aria-expanded', String(isOverlayOpenFor(a.pluginId, a.id)));
      b.innerHTML = `<span>${a.label}</span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;
    } else {
      b.textContent = a.label;
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      a.onClick(b);
    });
    actionsSec.appendChild(b);
    actionButtons.set(`${a.pluginId}:${a.id}`, b);
  }
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
      emitPluginEvent('pen');
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
    emitPluginEvent('pen');
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
        emitPluginEvent('pen');
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



// ---------- header / panel actions ----------
(document.getElementById('undo-btn') as HTMLButtonElement).addEventListener('click', undo);
(document.getElementById('redo-btn') as HTMLButtonElement).addEventListener('click', redo);
function clearStage(): void {
  // Clear clears the frame being edited, not the whole timeline: the
  // other frames keep their drawings.
  if (items.length === 0) return;
  pushHistory();
  timeline.frames[timeline.current].items = [];
  items = timeline.frames[timeline.current].items;
  selectedIds = [];
  pruneItemGroups();
  clearSmoothed();
  save();
  renderPanel();
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
  // turns to a grab hand (the canvas plugin updates it on the
  // view event) and the next drag pans
  // instead of starting a tool gesture. Repeat events are ignored;
  // the keyup below clears it.
  if (k === ' ' && !e.repeat) { e.preventDefault(); spaceHeld = true; emitPluginEvent('view'); return; }
  // R held is the rotate modifier, like Space is for pan: the cursor
  // turns to a grab hand and the next drag rotates the view around
  // the workspace centre. No Ctrl/Cmd/Alt — those belong to the
  // browser (Ctrl/Cmd+R reloads). Typing in an input is already
  // guarded by the check at the top of this handler.
  if (k === 'r' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); rotateHeld = true; emitPluginEvent('view'); return; }
  if (k === 'escape') {
    // A plugin's transient (the Add behavior list) closes first; the
    // core never names the plugin, it asks the registry. Then the
    // plugin overlays (the Export dropdown), then focus, selection,
    // and the colour panel.
    if (closePanelTransients()) { renderPanel(); return; }
    if (closeOverlays()) { renderPanel(); return; }
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
  if (k === 'v') setTool('select');
  else if (k === 'p') setTool('brush');
  else if (k === 'd') setTool('eraser');
  else if (k === 'b') setTool('paint');
  else if (k === 'x') { swapColors(); return; }
  else if (k === 'e') { if (tool === 'shape') setShapeKind(shapeKind === 'rect' ? 'ellipse' : 'rect'); setTool('shape'); }
  else if (k === 't') setTool('text');
  else return;
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceHeld = false; emitPluginEvent('view'); }
  if (e.key.toLowerCase() === 'r') { rotateHeld = false; emitPluginEvent('view'); }
});
// Losing the window while Space or R is held (or mid-pan, mid-rotate)
// must not leave the grab hand stuck on.
window.addEventListener('blur', () => {
  spaceHeld = false;
  rotateHeld = false;
  emitPluginEvent('view');
});

// A plugin's transient (the Add behavior list) closes on a click
// anywhere else, on Escape (handled above), or when the panel switches
// — it lives in the panel flow, so scrolling and resizing leave it
// alone. Plugin overlays close the same way.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement | null;
  if (closePanelTransients(t ?? undefined)) { renderPanel(); return; }
  if (anyOverlayOpen()) {
    if (t && clickInsideOverlay(t)) return;
    if (closeOverlays()) renderPanel();
    return;
  }
});
panelBody.addEventListener('scroll', () => {
  if (closeOverlays()) renderPanel();
}, { passive: true });
// A tooltip is anchored to a button rect that moves with the panel,
// so it hides on scroll or resize rather than going stale.
panelBody.addEventListener('scroll', () => { closeTooltipEl(); }, { passive: true });
window.addEventListener('resize', () => { closeTooltipEl(); });
window.addEventListener('resize', () => {
  if (closeOverlays()) renderPanel();
});

// ---------- init ----------
load();
projectInput.value = projectName;
// What the core provides to the plugin system: the document, the view,
// the transport, the animation reads, the panel re-render, the live
// action buttons (for overlay anchors), the one-time migration seed
// from the loaded save, and the Electron bridge for the folder-picking
// file surface. Bundled first-party plugins register their actions,
// overlays and UI here, before the first panel render, so the Actions
// section renders them from the start.
registerShellElements({
  toolbar: document.getElementById('toolbar')!,
  stageWrap,
  player: document.getElementById('player')!,
  filmstrip: document.getElementById('filmstrip')!,
});
const pluginHost: PluginHost = {
  getLoopMs: () => loopMs(),
  getLoopLength: () => loopLength,
  getStageSize: () => stageSize(),
  renderFrame: (t01, target, dprOverride) => renderFrameTo(t01, target, dprOverride),
  renderFrameAt: (frameIndex, t01, target, dprOverride) => renderFrameAtTo(frameIndex, t01, target, dprOverride),
  renderPanel: () => renderPanel(),
  getActionButton: (pluginId, id) => actionButtons.get(`${pluginId}:${id}`) ?? null,
  legacy: { exports: legacyExportPrefs },
  bridge: window.manakin,
  getItems: () => items,
  getItemGroups: () => itemGroups,
  getSelectedItems: () => selectedItems(),
  getItemGroupOf: (itemId) => itemGroupOf(itemId),
  getSelection: () => selectedIds,
  setSelection: (ids) => { selectedIds = ids; emitPluginEvent('selection'); },
  getFocusedId: () => focusedId,
  setFocusedId: (id) => { focusedId = id; emitPluginEvent('selection'); },
  getTool: () => tool,
  setTool: (t) => setTool(t),
  getColor: () => color,
  setColor: (hex) => { color = hex; emitPluginEvent('pen'); },
  getBgColor: () => bgColour,
  setBgColor: (hex) => { bgColour = hex; emitPluginEvent('pen'); },
  getActiveSlot: () => activeSlot,
  setActiveSlot: (slot) => { activeSlot = slot; emitPluginEvent('pen'); },
  swapColors: () => swapColors(),
  getPenWidth: () => penWidth,
  setPenWidth: (n) => { penWidth = n; emitPluginEvent('pen'); },
  getShapeKind: () => shapeKind,
  setShapeKind: (k) => setShapeKind(k),
  getStageBg: () => ({ id: stageBgId, custom: stageBgCustom }),
  setStageBg: (id, custom) => { stageBgId = id; stageBgCustom = custom; emitPluginEvent('document'); },
  pruneItemGroups: () => { pruneItemGroups(); emitPluginEvent('document'); },
  getGridMode: () => gridMode,
  getStageId: () => stageId,
  gestureStart: () => gestureStart(),
  gestureCommit: (before, changed) => { gestureCommit(before, changed); emitPluginEvent('document'); },
  pushHistory: () => pushHistory(),
  save: () => save(),
  getZoom: () => zoom,
  setZoom: (z) => setZoom(z),
  zoomStep: (dir) => zoomStep(dir),
  resetView: () => resetView(),
  resetZoom: () => resetZoom(),
  getPan: () => ({ x: panX, y: panY }),
  setPan: (x, y) => { panX = x; panY = y; clampPan(); emitPluginEvent('view'); },
  getRotate: () => rotateDeg,
  setRotate: (deg) => { rotateDeg = normDeg(deg); emitPluginEvent('view'); },
  getLayout: () => workspaceLayoutFor({ zoom, panX, panY, rotateDeg }, stageSize(), { w: stageWrap.clientWidth, h: stageWrap.clientHeight }),
  getViewState: () => ({ zoom, panX, panY, rotateDeg }),
  isSpaceHeld: () => spaceHeld,
  isRotateHeld: () => rotateHeld,
  isPlaying: () => playing,
  getPlayTime: () => playTime,
  setPlayTime: (ms) => { playTime = ms; emitPluginEvent('transport'); },
  play: () => { if (!playing) { playing = true; lastTs = 0; } emitPluginEvent('transport'); },
  pause: () => { playing = false; emitPluginEvent('transport'); },
  stop: () => { playing = false; playTime = 0; if (timeline.current !== 0) switchFrame(0); emitPluginEvent('transport'); },
  back: () => { playTime = 0; if (timeline.current !== 0) switchFrame(0); emitPluginEvent('transport'); },
  forward: () => { playTime = frameStartMs(timeline, timeline.frames.length - 1); if (timeline.current !== timeline.frames.length - 1) switchFrame(timeline.frames.length - 1); emitPluginEvent('transport'); },
  tick: (ts) => {
    if (playing) {
      if (lastTs) playTime = (playTime + (ts - lastTs)) % loopMs();
      lastTs = ts;
      // Playback advances through the frames at fps: the frame is
      // whatever the playhead is inside.
      const fi = frameIndexAtTime(timeline, playTime);
      if (fi !== timeline.current) switchFrame(fi);
    } else {
      lastTs = 0;
    }
    return playTime / loopMs();
  },
  getTimeline: () => timeline,
  getCurrentFrame: () => timeline.current,
  setCurrentFrame: (i) => setCurrentFrame(i),
  addFrame: () => addFrame(),
  duplicateFrame: (i) => duplicateFrame(i),
  deleteFrame: (i) => deleteFrame(i),
  moveFrame: (from, to) => moveFrame(from, to),
  setFrameHold: (i, d) => setFrameHold(i, d),
  getOnionSkin: () => onionSkin,
  setOnionSkin: (on) => { onionSkin = on; save(); emitPluginEvent('timeline'); },
  ungroupItemGroup: (g) => ungroupItemGroup(g),
  renderArrangeSection: () => renderArrangeSection(),
  renderPanelDivider: () => panelDivider(),
  openColour: (slot) => openColour(slot),
  attachTooltip: (btn, text) => attachTooltip(btn, text),
};
initPlugins(pluginHost, [canvasPlugin, toolbarPlugin, playerPlugin, framesPlugin, exportsPlugin, behavioursPlugin, helloPlugin]);
renderPanel();
applyPanelOpen();


// Manakin Plugin API v1 — see docs/plugins.md.
//
// A plugin is a module with a manifest, an activate(api) and an optional
// deactivate(). Bundled first-party plugins live in src/core-plugins/
// and are passed to initPlugins by the core; user plugins from a local
// folder come in a later phase. The shape is copied from Bowerbird's
// plugin system (src/plugins.ts, PLUGIN_API.md) — one plugin philosophy
// across both apps — sized to what Manakin actually builds: actions,
// overlays, the animation read surface, files, per-plugin storage, and
// (phase 2) the document, view, transport, canvas, shell and events
// domains the core plugins need. Where Bowerbird has more (user-folder
// loading, trial plugins, secure storage), that lands with the phase
// that needs it, copied from the same source, not reinvented.
//
// Trust model, stated honestly, as in Bowerbird: installing a plugin is
// trusting its code, like an Obsidian or VS Code extension. The API is
// the supported contract; reaching past it into core DOM or internals
// may break. A plugin never gets Node or the filesystem directly —
// privileged calls (folder picking, file writes) go through the core's
// bridge, and downloads go through files.download here.

import type { GridMode, Item, ItemGroup, StageBgId, Timeline, ToolId, ViewState, WorkspaceLayout } from "./model";

// ---------------------------------------------------------------------------
// API version
// ---------------------------------------------------------------------------

// The current API version. A plugin whose manifest declares another
// version does not load. Manakin's API is its own, starting at 1;
// Bowerbird's current API is 2 — the version number is per app, the
// rule (old versions do not load) is shared.
export const PLUGIN_API_VERSION = "1";

// ---------------------------------------------------------------------------
// Manifest and contributions
// ---------------------------------------------------------------------------

// Copied from Bowerbird: a manifest describes the plugin, its API
// version, its permissions and what it contributes. `contributions`
// is a summary for a future Settings UI; the code in activate() is
// what actually registers each contribution, and if the two disagree
// the registered contributions win. `main` / `styles` belong to the
// user-folder loader and are not part of a bundled plugin in v1.
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  description?: string;
  permissions?: string[];
  // Off by default when false; absent means on. The enabled map (see
  // below) wins over this when the user has toggled the plugin.
  enabled?: boolean;
  // Required plugins cannot be disabled: they are the foundation the
  // rest of the app stands on. A required plugin is always enabled,
  // whatever the enabled map says, so a stale "false" in the map
  // cannot lock the app out. Nothing uses this in phase 1.
  required?: boolean;
  contributions?: {
    actions?: Array<{ id: string; label: string }>;
    overlays?: Array<{ id: string }>;
  };
}

export interface PluginActionDef {
  id: string;
  label: string;
  // A chevron action, like Export: the button gets the chevron treatment
  // (label centred, chevron at the right edge) and aria-expanded.
  chevron?: boolean;
  onClick: (btn: HTMLButtonElement) => void;
}

export interface PluginOverlayDef {
  id: string;
  // The action button this overlay anchors to. The core looks the
  // button up live, so a rebuilt panel re-anchors the overlay.
  actionId: string;
  isOpen: () => boolean;
  // Rebuild the overlay DOM from scratch, anchored to the given
  // button (null only when there is no anchor yet — render must
  // still remove any stale DOM in that case). Called after every
  // panel render while the overlay is open.
  render: (anchor: HTMLButtonElement | null) => void;
  // Remove the overlay DOM and set the plugin's open state to false.
  close: () => void;
  // Is this click target inside the overlay or its anchor button?
  // The core's outside-click handler asks this before closing.
  // Check closest() as well as the live overlay element: a click
  // that rebuilt the panel (a tab click inside the dropdown)
  // leaves its target detached, and closest() still walks the
  // detached ancestors, while a live contains() would miss it.
  contains: (t: HTMLElement) => boolean;
}

// The canvas renderer: the canvas plugin registers it, the core calls
// it. Render one frame on screen (render) or offline into a given
// context (renderFrame, for exports); renderFrameAt renders one
// timeline frame offline (for timeline exports); resize re-fits the
// canvas to its wrap. When the canvas plugin is disabled the registry
// is empty and every call here is a no-op — exports degrade to a blank
// frame rather than a crash.
export interface CanvasRenderer {
  getElement: () => HTMLCanvasElement | null;
  render: (t01: number) => void;
  renderFrame: (t01: number, target: CanvasRenderingContext2D, dprOverride?: number) => void;
  renderFrameAt: (frameIndex: number, t01: number, target: CanvasRenderingContext2D, dprOverride?: number) => void;
  resize: () => void;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Copied from Bowerbird's events bus: plugins talk to each other and to
// the core through named events, not through direct imports of each
// other's internals. A plugin that needs to react to core state
// subscribes; it never polls and never reaches into core state.
//   tool — the active tool changed (the toolbar re-renders)
//   pen — pen width, colours, active slot or shape kind changed
//   selection — the selection or the focused item changed
//   view — zoom, pan or rotation changed
//   transport — play state changed (play / pause / stop / back / forward)
//   document — the document changed (items, groups, stage, loop, grid)
//   timeline — the timeline changed (frames, current frame, onion skin)
export type PluginEvent = "tool" | "pen" | "selection" | "view" | "transport" | "document" | "timeline";

export type PluginEventHandler = () => void;

const eventHandlers = new Map<PluginEvent, Set<PluginEventHandler>>();

export function onEvent(event: PluginEvent, handler: PluginEventHandler): void {
  let set = eventHandlers.get(event);
  if (!set) {
    set = new Set();
    eventHandlers.set(event, set);
  }
  set.add(handler);
}

export function offEvent(event: PluginEvent, handler: PluginEventHandler): void {
  eventHandlers.get(event)?.delete(handler);
}

export function emitPluginEvent(event: PluginEvent): void {
  for (const handler of Array.from(eventHandlers.get(event) ?? [])) {
    try {
      handler();
    } catch {
      // A failing listener must not break the emitter or the other listeners.
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PluginContext {
  version: string;
  plugin: { id: string; name: string; version: string };
  has: (capability: string) => boolean;
  app: {
    getLoopMs: () => number;
    getLoopLength: () => number;
    getStageSize: () => { w: number; h: number };
    // Whole frames in one loop at 30fps, at least 1.
    frameCount: () => number;
    // Render one frame offline, at the loop position t01 in [0, 1),
    // into the given canvas context. The on-screen canvas is never
    // the target for an export.
    renderFrame: (t01: number, target: CanvasRenderingContext2D, dprOverride?: number) => void;
    // Render one timeline frame offline, at the loop position t01 in
    // [0, 1), into the given canvas context. The frame's own items,
    // with behaviours superposed at t01 when the Behaviours plugin
    // is on, pure at rest when it is off.
    renderFrameAt: (frameIndex: number, t01: number, target: CanvasRenderingContext2D, dprOverride?: number) => void;
    renderPanel: () => void;
  };
  // The document: items, groups, selection, tools, colours, stage,
  // gestures and save. Mutations go through here so the core can emit
  // the matching event and the panel can re-render.
  doc: {
    getItems: () => Item[];
    getItemGroups: () => ItemGroup[];
    getSelectedItems: () => Item[];
    getItemGroupOf: (itemId: string) => ItemGroup | undefined;
    getSelection: () => string[];
    setSelection: (ids: string[]) => void;
    getFocusedId: () => string | null;
    setFocusedId: (id: string | null) => void;
    getTool: () => ToolId;
    setTool: (tool: ToolId) => void;
    getColor: () => string;
    setColor: (hex: string) => void;
    getBgColor: () => string;
    setBgColor: (hex: string) => void;
    getActiveSlot: () => "fg" | "bg";
    setActiveSlot: (slot: "fg" | "bg") => void;
    swapColors: () => void;
    getPenWidth: () => number;
    setPenWidth: (n: number) => void;
    getShapeKind: () => "rect" | "ellipse";
    setShapeKind: (k: "rect" | "ellipse") => void;
    getStageBg: () => { id: StageBgId; custom: string | null };
    setStageBg: (id: StageBgId, custom: string | null) => void;
    pruneItemGroups: () => void;
    getGridMode: () => GridMode;
    getStageId: () => "wide" | "square" | "portrait";
    // The timeline: the traditional animation layer's frames, the
    // frame being edited, and the frame operations. Frame switches
    // are view state, not undo entries; the operations push history.
    getTimeline: () => Timeline;
    getCurrentFrame: () => number;
    setCurrentFrame: (index: number) => void;
    addFrame: () => void;
    duplicateFrame: (index: number) => void;
    deleteFrame: (index: number) => void;
    moveFrame: (from: number, to: number) => void;
    setFrameHold: (index: number, duration: number) => void;
    getOnionSkin: () => boolean;
    setOnionSkin: (on: boolean) => void;
    ungroupItemGroup: (group: ItemGroup) => void;
    // A gesture is one undoable unit: snapshot before, commit after.
    // gestureStart returns the snapshot; gestureCommit pushes it onto
    // the undo stack when changed.
    gestureStart: () => string;
    gestureCommit: (before: string, changed: boolean) => void;
    pushHistory: () => void;
    save: () => void;
  };
  // The view: zoom, pan, rotation, and the layout they compute.
  // All view state — never saved, never in undo.
  view: {
    getZoom: () => number;
    setZoom: (z: number) => void;
    zoomStep: (dir: 1 | -1) => void;
    resetView: () => void;
    resetZoom: () => void;
    getPan: () => { x: number; y: number };
    setPan: (x: number, y: number) => void;
    getRotate: () => number;
    setRotate: (deg: number) => void;
    getLayout: () => WorkspaceLayout;
    getViewState: () => ViewState;
    isSpaceHeld: () => boolean;
    isRotateHeld: () => boolean;
  };
  // Transport: playback state and the clock. tick advances the clock
  // by one animation frame and returns the loop position t01 in [0, 1).
  transport: {
    isPlaying: () => boolean;
    getPlayTime: () => number;
    setPlayTime: (ms: number) => void;
    play: () => void;
    pause: () => void;
    stop: () => void;
    back: () => void;
    forward: () => void;
    tick: (ts: number) => number;
  };
  // The canvas: the element, the render requests, and the renderer
  // registration. Only the canvas plugin registers a renderer.
  canvas: {
    getElement: () => HTMLCanvasElement | null;
    requestRender: (t01?: number) => void;
    resize: () => void;
    registerRenderer: (renderer: CanvasRenderer | null) => void;
  };
  // The shell elements this plugin may own: the floating toolbar, the
  // stage wrap (the canvas plugin builds the canvas and the text
  // editor inside it), the filmstrip (the traditional layer builds
  // the frame strip inside it), the bottom bar. The core registers
  // them once at boot; a plugin builds its UI inside the element it owns.
  shell: {
    toolbar: HTMLElement;
    stageWrap: HTMLElement;
    filmstrip: HTMLElement;
    player: HTMLElement;
  };
  // The events bus: subscribe to core state changes, announce your own.
  events: {
    on: (event: PluginEvent, handler: PluginEventHandler) => void;
    off: (event: PluginEvent, handler: PluginEventHandler) => void;
    emit: (event: PluginEvent) => void;
  };
  // One-time migration seed: values the core used to own that now
  // belong to this plugin, keyed by plugin id. Read it at activate
  // if the plugin needs it, then forget it.
  legacy: Record<string, unknown>;
  files: {
    download: (blob: Blob, filename: string) => void;
    pickSequenceFolder: () => Promise<string | null>;
    writeSequenceFile: (dir: string, name: string, dataUrl: string) => Promise<boolean>;
  };
  ui: {
    registerAction: (def: PluginActionDef) => void;
    unregisterAction: (id: string) => void;
    // The calling plugin's own action button, by its short id.
    // The core looks it up by the namespaced key; a plugin only
    // ever sees its own buttons.
    getActionButton: (id: string) => HTMLButtonElement | null;
    registerOverlay: (def: PluginOverlayDef) => void;
    unregisterOverlay: (id: string) => void;
    // A whole-panel view for one selection state (the Behaviours
    // plugin's layer stack). The core asks the registry before its
    // own panels; with the plugin off, no view matches.
    registerPanelView: (def: PanelViewDef) => void;
    unregisterPanelView: (id: string) => void;
    // A panel transient: UI the plugin opened inside the panel flow
    // that Escape / an outside click should close first. The closer
    // gets the click target (undefined for Escape) and returns
    // whether it closed anything.
    registerPanelTransient: (close: (target?: HTMLElement) => boolean) => void;
    unregisterPanelTransient: () => void;
    // The core's shared panel builders, so a plugin's panel reads
    // exactly like the core's: the Arrange section and the hairline
    // divider between sections.
    arrangeSection: () => HTMLDivElement;
    panelDivider: () => HTMLDivElement;
    // Open the colour panel for a slot. The panel itself is still
    // core-owned; the toolbar asks for it, it does not build it.
    openColour: (slot: "fg" | "bg") => void;
    // The shared tooltip: a frosted pill above the button, 400ms
    // delay, 6px gap. One implementation, every button the same.
    attachTooltip: (btn: HTMLButtonElement, text: string) => void;
  };
  storage: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
  };
}

// A panel view: a plugin's whole-panel rendering for one selection
// state. The core asks the registry before its own panels; the first
// view whose `when` matches renders the panel (title + body). With
// the plugin off, no view matches and the core's fallback shows.
// afterRender runs after the core's scroll restore, for
// scroll-into-view work the view requested during render.
export interface PanelContext {
  selectedItems: Item[];
  selectedGroup: ItemGroup | null;
}

export interface PanelViewDef {
  id: string;
  when: (ctx: PanelContext) => boolean;
  render: (ctx: PanelContext, body: HTMLElement, setTitle: (t: string) => void) => void;
  afterRender?: (ctx: PanelContext, body: HTMLElement) => void;
}

// What the core provides to the plugin system. All animation reads and
// the panel re-render go through here, so plugins never touch core
// state directly.
export interface PluginHost {
  getLoopMs: () => number;
  getLoopLength: () => number;
  getStageSize: () => { w: number; h: number };
  renderFrame: (t01: number, target: CanvasRenderingContext2D, dprOverride?: number) => void;
  renderFrameAt: (frameIndex: number, t01: number, target: CanvasRenderingContext2D, dprOverride?: number) => void;
  renderPanel: () => void;
  // Look an action button up by plugin and short id. The core keys
  // its buttons by the namespaced key, so two plugins may register
  // the same short action id without colliding.
  getActionButton: (pluginId: string, id: string) => HTMLButtonElement | null;
  // One-time migration seeds, keyed by plugin id. Populated from the
  // loaded save before initPlugins runs.
  legacy: Record<string, Record<string, unknown>>;
  // The Electron bridge, or undefined outside Electron (e.g. vite
  // preview). Folder picking needs it; everything else does not.
  bridge: {
    pickSequenceFolder: () => Promise<string | null>;
    writeSequenceFile: (dir: string, name: string, dataUrl: string) => Promise<boolean>;
  } | undefined;
  // Document, view and transport — one closure each over core state.
  // The host setters emit the matching event (tool, pen, selection,
  // view, transport, document) so subscribed plugins stay in sync.
  getItems: () => Item[];
  getItemGroups: () => ItemGroup[];
  getSelectedItems: () => Item[];
  getItemGroupOf: (itemId: string) => ItemGroup | undefined;
  getSelection: () => string[];
  setSelection: (ids: string[]) => void;
  getFocusedId: () => string | null;
  setFocusedId: (id: string | null) => void;
  getTool: () => ToolId;
  setTool: (tool: ToolId) => void;
  getColor: () => string;
  setColor: (hex: string) => void;
  getBgColor: () => string;
  setBgColor: (hex: string) => void;
  getActiveSlot: () => "fg" | "bg";
  setActiveSlot: (slot: "fg" | "bg") => void;
  swapColors: () => void;
  getPenWidth: () => number;
  setPenWidth: (n: number) => void;
  getShapeKind: () => "rect" | "ellipse";
  setShapeKind: (k: "rect" | "ellipse") => void;
  getStageBg: () => { id: StageBgId; custom: string | null };
  setStageBg: (id: StageBgId, custom: string | null) => void;
  pruneItemGroups: () => void;
  getGridMode: () => GridMode;
  getStageId: () => "wide" | "square" | "portrait";
  getTimeline: () => Timeline;
  getCurrentFrame: () => number;
  setCurrentFrame: (index: number) => void;
  addFrame: () => void;
  duplicateFrame: (index: number) => void;
  deleteFrame: (index: number) => void;
  moveFrame: (from: number, to: number) => void;
  setFrameHold: (index: number, duration: number) => void;
  getOnionSkin: () => boolean;
  setOnionSkin: (on: boolean) => void;
  ungroupItemGroup: (group: ItemGroup) => void;
  renderArrangeSection: () => HTMLDivElement;
  renderPanelDivider: () => HTMLDivElement;
  gestureStart: () => string;
  gestureCommit: (before: string, changed: boolean) => void;
  pushHistory: () => void;
  save: () => void;
  getZoom: () => number;
  setZoom: (z: number) => void;
  zoomStep: (dir: 1 | -1) => void;
  resetView: () => void;
  resetZoom: () => void;
  getPan: () => { x: number; y: number };
  setPan: (x: number, y: number) => void;
  getRotate: () => number;
  setRotate: (deg: number) => void;
  getLayout: () => WorkspaceLayout;
  getViewState: () => ViewState;
  isSpaceHeld: () => boolean;
  isRotateHeld: () => boolean;
  isPlaying: () => boolean;
  getPlayTime: () => number;
  setPlayTime: (ms: number) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  back: () => void;
  forward: () => void;
  tick: (ts: number) => number;
  openColour: (slot: "fg" | "bg") => void;
  attachTooltip: (btn: HTMLButtonElement, text: string) => void;
}

export interface PluginModule {
  manifest: PluginManifest;
  activate: (api: PluginContext) => void;
  deactivate?: () => void;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  core: boolean;
  required: boolean;
  active: boolean;
  failed: boolean;
  error: string | null;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  // First-party (bundled) plugins are shipped with the app and build
  // the app's own UI; the rest will be user plugins. The flag is
  // exposed in list() so a future Settings UI can group them.
  firstParty: boolean;
  // A first-party plugin's module is a bundled import, not a file on
  // disk, so it cannot be re-loaded from anywhere. It is kept here
  // across deactivation so re-enabling the plugin re-activates the
  // same module instead of failing on a module that no longer exists.
  // Copied from Bowerbird, where this is what makes disabling and
  // re-enabling a core plugin work at runtime.
  firstPartyModule: PluginModule | null;
  active: boolean;
  failed: boolean;
  error: string | null;
  module: PluginModule | null;
}

interface ActionEntry extends PluginActionDef {
  pluginId: string;
}

interface OverlayEntry extends PluginOverlayDef {
  pluginId: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Registries, keyed by the namespaced key `${pluginId}:${id}` —
// copied from Bowerbird, where cards, commands and settings sections
// are keyed the same way. Two plugins may register the same short id
// without colliding; the core resolves a short id within one plugin.
const actions = new Map<string, ActionEntry>();
const overlays = new Map<string, OverlayEntry>();
const panelViews = new Map<string, PanelViewDef>();
// Panel transients are keyed by plugin id alone: a plugin has at
// most one transient UI open at a time.
const panelTransients = new Map<string, (target?: HTMLElement) => boolean>();
const loaded = new Map<string, LoadedPlugin>();

let host: PluginHost | null = null;

// The canvas renderer, with the plugin that registered it — so
// unregistering that plugin clears the renderer with it, and a
// disabled canvas plugin leaves no stale renderer behind.
let canvasRenderer: { pluginId: string; renderer: CanvasRenderer } | null = null;

// The shell elements, registered once by the core at boot, before
// initPlugins. Copied from Bowerbird's registerShellElements.
export interface ShellElements {
  toolbar: HTMLElement;
  stageWrap: HTMLElement;
  filmstrip: HTMLElement;
  player: HTMLElement;
}

let shellElements: ShellElements | null = null;

export function registerShellElements(els: ShellElements): void {
  shellElements = els;
}

export function getShellElements(): ShellElements | null {
  return shellElements;
}

// The enabled map lives in localStorage under this key:
// { [pluginId]: boolean }. Absent means enabled — bundled plugins
// are on by default — except a manifest with enabled: false. In
// Bowerbird the same map lives behind the bridge (plugins.json);
// here localStorage is the store, because phase 1 has no
// user-folder loader and no main-process plugin surface yet.
const ENABLED_KEY = "manakin-plugins";

function namespacedKey(pluginId: string, id: string): string {
  return `${pluginId}:${id}`;
}

function readEnabledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeEnabledMap(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify(map));
  } catch { /* storage full or unavailable */ }
}

function isEnabled(manifest: PluginManifest, map: Record<string, boolean>): boolean {
  // Copied from Bowerbird: a required plugin is always enabled,
  // whatever the enabled map says — a stale "false" in the map
  // must not lock the app out of its own foundation.
  if (manifest.required) return true;
  if (typeof map[manifest.id] === "boolean") return map[manifest.id];
  if (typeof manifest.enabled === "boolean") return manifest.enabled;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Copied verbatim from Bowerbird: a DOM id namespaced by plugin, so
// two plugins' contributions never collide in the document.
export function domId(pluginId: string, kind: string, id: string): string {
  return `${kind}-plugin-${pluginId}-${id}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

// Copied verbatim from Bowerbird: permissions gate the API object. A
// method that needs a permission the manifest did not declare throws.
function requirePerm(manifest: PluginManifest, perm: string): void {
  const perms = manifest.permissions ?? [];
  if (perms.includes(perm)) return;
  throw new Error(`Plugin ${manifest.id} lacks permission ${perm}`);
}

// ---------------------------------------------------------------------------
// Canvas renderer registry
// ---------------------------------------------------------------------------

export function registerCanvasRenderer(pluginId: string, renderer: CanvasRenderer | null): void {
  if (renderer === null) {
    if (canvasRenderer?.pluginId === pluginId) canvasRenderer = null;
    return;
  }
  canvasRenderer = { pluginId, renderer };
}

export function getCanvasElement(): HTMLCanvasElement | null {
  try {
    return canvasRenderer?.renderer.getElement() ?? null;
  } catch {
    return null;
  }
}

// Render one frame on screen through the registered renderer. A no-op
// with no renderer (canvas plugin disabled) — the callers keep running.
export function requestCanvasRender(t01: number): void {
  try {
    canvasRenderer?.renderer.render(t01);
  } catch {
    // A failing render must not break the caller (the player loop).
  }
}

// Render one frame offline, for exports. A no-op with no renderer.
export function renderFrameTo(t01: number, target: CanvasRenderingContext2D, dprOverride?: number): void {
  try {
    canvasRenderer?.renderer.renderFrame(t01, target, dprOverride);
  } catch {
    // A failing export render must not break the caller.
  }
}

// Render one timeline frame offline, for exports. A no-op with no renderer.
export function renderFrameAtTo(frameIndex: number, t01: number, target: CanvasRenderingContext2D, dprOverride?: number): void {
  try {
    canvasRenderer?.renderer.renderFrameAt(frameIndex, t01, target, dprOverride);
  } catch {
    // A failing export render must not break the caller.
  }
}

export function requestCanvasResize(): void {
  try {
    canvasRenderer?.renderer.resize();
  } catch {
    // A failing resize must not break the caller.
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function storageKey(pluginId: string, key: string): string {
  return `manakin-plugin:${pluginId}:${key}`;
}

// Copied from Bowerbird (createContext): one API object per plugin,
// filtered to the manifest's permissions. `has` answers whether the
// API offers a capability at all — the fixed list of domains and
// contribution kinds in this version — while the permission check
// decides whether this plugin may use it.
function createContext(manifest: PluginManifest): PluginContext {
  const pluginId = manifest.id;
  const require = (perm: string) => requirePerm(manifest, perm);
  return {
    version: PLUGIN_API_VERSION,
    plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
    has: (capability: string) => {
      // Capabilities in v1: every domain documented in docs/plugins.md,
      // plus the contribution kinds a plugin can register. A future
      // core may add more; a plugin should check before using a
      // capability that was added after v1.
      return ["app", "doc", "view", "transport", "canvas", "shell", "events", "legacy", "files", "ui", "storage", "actions", "overlays"].includes(capability);
    },
    app: {
      getLoopMs: () => host!.getLoopMs(),
      getLoopLength: () => host!.getLoopLength(),
      getStageSize: () => host!.getStageSize(),
      frameCount: () => Math.max(1, Math.round((host!.getLoopMs() / 1000) * 30)),
      renderFrame: (t01, target, dprOverride) => host!.renderFrame(t01, target, dprOverride),
      renderFrameAt: (frameIndex, t01, target, dprOverride) => host!.renderFrameAt(frameIndex, t01, target, dprOverride),
      renderPanel: () => host!.renderPanel(),
    },
    doc: {
      getItems: () => host!.getItems(),
      getItemGroups: () => host!.getItemGroups(),
      getSelectedItems: () => host!.getSelectedItems(),
      getItemGroupOf: (itemId) => host!.getItemGroupOf(itemId),
      getSelection: () => host!.getSelection(),
      setSelection: (ids) => { require("doc"); host!.setSelection(ids); },
      getFocusedId: () => host!.getFocusedId(),
      setFocusedId: (id) => { require("doc"); host!.setFocusedId(id); },
      getTool: () => host!.getTool(),
      setTool: (tool) => { require("doc"); host!.setTool(tool); },
      getColor: () => host!.getColor(),
      setColor: (hex) => { require("doc"); host!.setColor(hex); },
      getBgColor: () => host!.getBgColor(),
      setBgColor: (hex) => { require("doc"); host!.setBgColor(hex); },
      getActiveSlot: () => host!.getActiveSlot(),
      setActiveSlot: (slot) => { require("doc"); host!.setActiveSlot(slot); },
      swapColors: () => { require("doc"); host!.swapColors(); },
      getPenWidth: () => host!.getPenWidth(),
      setPenWidth: (n) => { require("doc"); host!.setPenWidth(n); },
      getShapeKind: () => host!.getShapeKind(),
      setShapeKind: (k) => { require("doc"); host!.setShapeKind(k); },
      getStageBg: () => host!.getStageBg(),
      setStageBg: (id, custom) => { require("doc"); host!.setStageBg(id, custom); },
      pruneItemGroups: () => { require("doc"); host!.pruneItemGroups(); },
      getGridMode: () => host!.getGridMode(),
      getStageId: () => host!.getStageId(),
      getTimeline: () => host!.getTimeline(),
      getCurrentFrame: () => host!.getCurrentFrame(),
      setCurrentFrame: (index) => { require("doc"); host!.setCurrentFrame(index); },
      addFrame: () => { require("doc"); host!.addFrame(); },
      duplicateFrame: (index) => { require("doc"); host!.duplicateFrame(index); },
      deleteFrame: (index) => { require("doc"); host!.deleteFrame(index); },
      moveFrame: (from, to) => { require("doc"); host!.moveFrame(from, to); },
      setFrameHold: (index, duration) => { require("doc"); host!.setFrameHold(index, duration); },
      getOnionSkin: () => host!.getOnionSkin(),
      setOnionSkin: (on) => { require("doc"); host!.setOnionSkin(on); },
      ungroupItemGroup: (group) => { require("doc"); host!.ungroupItemGroup(group); },
      gestureStart: () => { require("doc"); return host!.gestureStart(); },
      gestureCommit: (before, changed) => { require("doc"); host!.gestureCommit(before, changed); },
      pushHistory: () => { require("doc"); host!.pushHistory(); },
      save: () => { require("doc"); host!.save(); },
    },
    view: {
      getZoom: () => host!.getZoom(),
      setZoom: (z) => { require("view"); host!.setZoom(z); },
      zoomStep: (dir) => { require("view"); host!.zoomStep(dir); },
      resetView: () => { require("view"); host!.resetView(); },
      resetZoom: () => { require("view"); host!.resetZoom(); },
      getPan: () => host!.getPan(),
      setPan: (x, y) => { require("view"); host!.setPan(x, y); },
      getRotate: () => host!.getRotate(),
      setRotate: (deg) => { require("view"); host!.setRotate(deg); },
      getLayout: () => host!.getLayout(),
      getViewState: () => host!.getViewState(),
      isSpaceHeld: () => host!.isSpaceHeld(),
      isRotateHeld: () => host!.isRotateHeld(),
    },
    transport: {
      isPlaying: () => host!.isPlaying(),
      getPlayTime: () => host!.getPlayTime(),
      setPlayTime: (ms) => { require("transport"); host!.setPlayTime(ms); },
      play: () => { require("transport"); host!.play(); },
      pause: () => { require("transport"); host!.pause(); },
      stop: () => { require("transport"); host!.stop(); },
      back: () => { require("transport"); host!.back(); },
      forward: () => { require("transport"); host!.forward(); },
      tick: (ts) => host!.tick(ts),
    },
    canvas: {
      getElement: () => getCanvasElement(),
      requestRender: (t01) => {
        require("canvas");
        requestCanvasRender(t01 ?? host!.getPlayTime() / host!.getLoopMs());
      },
      resize: () => { require("canvas"); requestCanvasResize(); },
      registerRenderer: (renderer) => { require("canvas"); registerCanvasRenderer(pluginId, renderer); },
    },
    shell: {
      get toolbar(): HTMLElement {
        require("shell");
        if (!shellElements) throw new Error("Shell elements not registered yet");
        return shellElements.toolbar;
      },
      get stageWrap(): HTMLElement {
        require("shell");
        if (!shellElements) throw new Error("Shell elements not registered yet");
        return shellElements.stageWrap;
      },
      get filmstrip(): HTMLElement {
        require("shell");
        if (!shellElements) throw new Error("Shell elements not registered yet");
        return shellElements.filmstrip;
      },
      get player(): HTMLElement {
        require("shell");
        if (!shellElements) throw new Error("Shell elements not registered yet");
        return shellElements.player;
      },
    },
    events: {
      on: (event, handler) => { require("events"); onEvent(event, handler); },
      off: (event, handler) => { require("events"); offEvent(event, handler); },
      emit: (event) => { require("events"); emitPluginEvent(event); },
    },
    legacy: host?.legacy[manifest.id] ?? {},
    files: {
      download: (blob, filename) => {
        require("export");
        downloadBlob(blob, filename);
      },
      pickSequenceFolder: async () => {
        require("export");
        if (!host!.bridge) return null;
        return host!.bridge.pickSequenceFolder();
      },
      writeSequenceFile: async (dir, name, dataUrl) => {
        require("export");
        if (!host!.bridge) return false;
        return host!.bridge.writeSequenceFile(dir, name, dataUrl);
      },
    },
    ui: {
      registerAction: (def) => {
        require("ui");
        actions.set(namespacedKey(pluginId, def.id), { ...def, pluginId });
      },
      unregisterAction: (id) => {
        require("ui");
        actions.delete(namespacedKey(pluginId, id));
      },
      getActionButton: (id) => host!.getActionButton(pluginId, id),
      registerOverlay: (def) => {
        require("ui");
        overlays.set(namespacedKey(pluginId, def.id), { ...def, pluginId });
      },
      unregisterOverlay: (id) => {
        require("ui");
        overlays.delete(namespacedKey(pluginId, id));
      },
      registerPanelView: (def) => {
        require("ui");
        panelViews.set(namespacedKey(pluginId, def.id), def);
      },
      unregisterPanelView: (id) => {
        require("ui");
        panelViews.delete(namespacedKey(pluginId, id));
      },
      registerPanelTransient: (close) => {
        require("ui");
        panelTransients.set(pluginId, close);
      },
      unregisterPanelTransient: () => {
        require("ui");
        panelTransients.delete(pluginId);
      },
      arrangeSection: () => {
        require("ui");
        return host!.renderArrangeSection();
      },
      panelDivider: () => {
        require("ui");
        return host!.renderPanelDivider();
      },
      openColour: (slot) => { require("ui"); host!.openColour(slot); },
      attachTooltip: (btn, text) => { require("ui"); host!.attachTooltip(btn, text); },
    },
    storage: {
      get: (key) => {
        require("storage");
        try {
          const raw = localStorage.getItem(storageKey(pluginId, key));
          return raw === null ? undefined : JSON.parse(raw);
        } catch {
          return undefined;
        }
      },
      set: (key, value) => {
        require("storage");
        try {
          localStorage.setItem(storageKey(pluginId, key), JSON.stringify(value));
        } catch { /* storage full or unavailable */ }
      },
      delete: (key) => {
        require("storage");
        try {
          localStorage.removeItem(storageKey(pluginId, key));
        } catch { /* storage unavailable */ }
      },
    },
  };
}

// The anchor download: straight to Downloads, no dialog. The synthetic
// click must not bubble to the document: the outside-click handler
// would read it as a click outside an open overlay and close it
// mid-download.
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.addEventListener("click", (e) => e.stopPropagation());
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Copied from Bowerbird's unregisterPlugin: removing a plugin
// unregisters everything it contributed, by plugin id, and closes
// any open overlay it owned. The core re-renders after this, so a
// disabled plugin's UI is gone and the rest of the app is untouched.
function unregisterPlugin(id: string): void {
  for (const [key, entry] of Array.from(actions.entries())) {
    if (entry.pluginId === id) actions.delete(key);
  }
  for (const [key, entry] of Array.from(overlays.entries())) {
    if (entry.pluginId === id) {
      try {
        if (entry.isOpen()) entry.close();
      } catch { /* a failing close must not block the unregister */ }
      overlays.delete(key);
    }
  }
  if (canvasRenderer?.pluginId === id) canvasRenderer = null;
  for (const [key, entry] of Array.from(panelViews.entries())) {
    if (key.startsWith(`${id}:`)) panelViews.delete(key);
  }
  panelTransients.delete(id);
}

function activatePlugin(lp: LoadedPlugin): void {
  // Copied from Bowerbird: a first-party plugin's module is a bundled
  // import — re-activate the retained module, not a file that does
  // not exist. This is what makes disabling and re-enabling a bundled
  // plugin work at runtime.
  const mod = lp.firstPartyModule ?? lp.module;
  if (!mod || typeof mod.activate !== "function") {
    throw new Error(`Plugin ${lp.manifest.id} does not export activate(api)`);
  }
  const api = createContext(lp.manifest);
  mod.activate(api);
  lp.module = mod;
  lp.active = true;
  lp.failed = false;
  lp.error = null;
}

function deactivatePlugin(lp: LoadedPlugin): void {
  try {
    lp.module?.deactivate?.();
  } catch {
    // Deactivate failures must not trap the user with the plugin on.
  }
  unregisterPlugin(lp.manifest.id);
  lp.module = null;
  lp.active = false;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Load and activate the bundled first-party plugins, in the order
// given. A plugin with the wrong apiVersion, or whose activate throws,
// is recorded as failed with its error and never half-registers. The
// core calls this once at boot, after load(), before the first
// renderPanel() — synchronous in API v1: bundled modules are static
// imports and the enabled map is localStorage, so nothing here awaits.
// (The user-folder loader, when it lands, makes this async — copied
// from Bowerbird, where initPlugins is async for exactly that reason.)
export function initPlugins(h: PluginHost, firstParty: PluginModule[]): void {
  host = h;
  const enabledMap = readEnabledMap();
  for (const mod of firstParty) {
    const lp: LoadedPlugin = {
      manifest: mod.manifest,
      firstParty: true,
      firstPartyModule: mod,
      active: false,
      failed: false,
      error: null,
      module: null,
    };
    loaded.set(mod.manifest.id, lp);
    if (mod.manifest.apiVersion !== PLUGIN_API_VERSION) {
      lp.failed = true;
      lp.error = `Requires plugin API ${mod.manifest.apiVersion}, this app provides ${PLUGIN_API_VERSION}`;
      continue;
    }
    // A plugin skipped here still enters the loaded map, so it shows
    // in the plugin list and can be re-enabled there. A plugin that
    // never entered the map would vanish entirely, and the only way
    // back would be editing storage by hand. Copied from Bowerbird.
    if (!isEnabled(mod.manifest, enabledMap)) continue;
    try {
      activatePlugin(lp);
    } catch (e) {
      lp.failed = true;
      lp.error = String(e);
      lp.active = false;
      unregisterPlugin(mod.manifest.id);
    }
  }
  exposeWindowHook();
}

export function listPlugins(): PluginInfo[] {
  return Array.from(loaded.values()).map((lp) => ({
    id: lp.manifest.id,
    name: lp.manifest.name,
    version: lp.manifest.version,
    description: lp.manifest.description ?? "",
    core: lp.firstParty,
    required: lp.manifest.required ?? false,
    active: lp.active,
    failed: lp.failed,
    error: lp.error,
  }));
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  const lp = loaded.get(id);
  if (!lp || !host) return;
  if (!enabled && lp.manifest.required) {
    throw new Error(`${lp.manifest.name} is required and cannot be disabled`);
  }
  const map = readEnabledMap();
  map[id] = enabled;
  writeEnabledMap(map);
  if (enabled && !lp.active) {
    // A previously failed plugin gets one retry on re-enable; a
    // plugin that failed to load is not retried silently on every
    // toggle — the user re-enabling it is the retry. Copied from
    // Bowerbird.
    lp.failed = false;
    lp.error = null;
    try {
      activatePlugin(lp);
    } catch (e) {
      lp.failed = true;
      lp.error = String(e);
      lp.active = false;
      unregisterPlugin(id);
    }
  } else if (!enabled && lp.active) {
    deactivatePlugin(lp);
  }
  host.renderPanel();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function listActions(): Array<PluginActionDef & { pluginId: string }> {
  return Array.from(actions.values());
}

// ---------------------------------------------------------------------------
// Panel views and transients
// ---------------------------------------------------------------------------

// The first registered panel view whose `when` matches the current
// selection, in registration order. Null when none matches — the core
// renders its own panels then.
export function getPanelView(ctx: PanelContext): PanelViewDef | null {
  for (const view of panelViews.values()) {
    try {
      if (view.when(ctx)) return view;
    } catch {
      // A failing `when` is treated as no match.
    }
  }
  return null;
}

// Ask every registered panel transient to close, first match wins.
// The core calls this on Escape (no target) and on a document click
// (the click target), before its own overlay handling.
export function closePanelTransients(target?: HTMLElement): boolean {
  for (const close of panelTransients.values()) {
    try {
      if (close(target)) return true;
    } catch {
      // A failing closer is treated as closed nothing.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

// Close every open overlay. Returns whether anything was open. The
// caller re-renders the panel afterwards; close() itself only removes
// the overlay DOM and clears the plugin's open state.
export function closeOverlays(): boolean {
  let closed = false;
  for (const entry of overlays.values()) {
    if (!entry.isOpen()) continue;
    try {
      entry.close();
    } catch { /* a failing close must not block the others */ }
    closed = true;
  }
  return closed;
}

// Is this click target inside an open overlay or its anchor button?
// The core's outside-click handler asks this before closing.
export function clickInsideOverlay(t: HTMLElement): boolean {
  for (const entry of overlays.values()) {
    if (!entry.isOpen()) continue;
    try {
      if (entry.contains(t)) return true;
    } catch { /* a failing contains is treated as outside */ }
  }
  return false;
}

export function anyOverlayOpen(): boolean {
  for (const entry of overlays.values()) {
    if (entry.isOpen()) return true;
  }
  return false;
}

// Re-render open overlays after a panel render. The anchor button is
// rebuilt every time, so an open overlay must be rebuilt with it. An
// open overlay whose anchor is gone (the panel switched away from the
// Canvas panel) is closed instead. Called by the core at the end of
// renderPanel(); a closed overlay is a no-op.
export function refreshOverlays(): void {
  if (!host) return;
  for (const entry of overlays.values()) {
    if (!entry.isOpen()) continue;
    const anchor = host.getActionButton(entry.pluginId, entry.actionId);
    if (!anchor) {
      try {
        entry.close();
      } catch { /* a failing close must not block the others */ }
      continue;
    }
    try {
      entry.render(anchor);
    } catch { /* a failing render leaves the old DOM in place */ }
  }
}

// Is the overlay for this plugin's action open? The core reads this to
// paint the action button's open state (the Export chevron's `open` class).
export function isOverlayOpenFor(pluginId: string, actionId: string): boolean {
  for (const entry of overlays.values()) {
    if (entry.pluginId === pluginId && entry.actionId === actionId && entry.isOpen()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Window hook
// ---------------------------------------------------------------------------

// Phase-1 management surface, until a Settings → Plugins UI exists:
// list plugins and toggle them. A later phase's Settings UI uses the
// same listPlugins / setPluginEnabled calls.
function exposeWindowHook(): void {
  window.manakinPlugins = {
    list: () => listPlugins(),
    setEnabled: (id: string, enabled: boolean) => setPluginEnabled(id, enabled),
  };
}

declare global {
  interface Window {
    manakinPlugins?: {
      list: () => PluginInfo[];
      setEnabled: (id: string, enabled: boolean) => void;
    };
  }
}

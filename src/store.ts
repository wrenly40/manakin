// Store: the app state. The document, the tool, the view, the selection,
// the playhead — and the undo stacks and the autosave. No DOM; the views
// subscribe through onChange and re-render.
import type { Document, Frame, Item, Layer, ViewState } from "./model";
import {
  SAVE_KEY,
  UNDO_LIMIT,
  frameAt,
  frameStartPos,
  nid,
  parseSave,
  sampleDocument,
  timelineLength,
} from "./model";

export type ToolId = "select" | "pen" | "eraser" | "shape" | "text" | "paint";

export type SelectionRef = { layerId: string; frameId: string; itemId: string };

export type ResolvedSelection = { layer: Layer; frame: Frame; item: Item };

type Snapshot = { doc: Document; name: string };

export type Store = {
  doc: Document;
  name: string;
  tool: ToolId;
  shapeKind: "rect" | "ellipse";
  color: string;
  color2: string;
  brushSize: number;
  view: ViewState;
  currentLayerId: string;
  currentByLayer: Map<string, number>;
  pos: number;
  playing: boolean;
  loop: boolean;
  selection: SelectionRef[];
  onChange(cb: () => void): () => void;
  emit(): void;
  setTool(t: ToolId): void;
  setShapeKind(k: "rect" | "ellipse"): void;
  setColor(c: string): void;
  setColor2(c: string): void;
  swapColors(): void;
  setBrushSize(n: number): void;
  setView(v: Partial<ViewState>): void;
  resetView(): void;
  resetZoom(): void;
  setCurrentLayer(id: string): void;
  setCurrentFrame(layerId: string, index: number): void;
  currentFrame(): { layer: Layer; frame: Frame; index: number };
  displayPos(): number;
  setPos(p: number): void;
  setPlaying(b: boolean): void;
  toggleLoop(): void;
  playToggle(): void;
  stop(): void;
  back(): void;
  forward(): void;
  setName(n: string): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  pushUndo(): void;
  popUndo(): void;
  mutate(fn: (doc: Document) => void): void;
  select(refs: SelectionRef[]): void;
  clearSelection(): void;
  resolveSelection(): ResolvedSelection[];
  moveSelection(dx: number, dy: number): void;
  duplicateSelection(): void;
  deleteSelection(): void;
  addLayer(): void;
  renameLayer(id: string, name: string): void;
  deleteLayer(id: string): void;
  moveLayer(id: string, dir: -1 | 1): void;
  toggleLayerVisible(id: string): void;
  addFrame(layerId: string): void;
  deleteFrame(layerId: string, index: number): void;
  beginHoldDrag(layerId: string, index: number): void;
  previewHold(hold: number): void;
  endHoldDrag(): void;
  save(): void;
};

function cloneDoc(doc: Document): Document {
  return structuredClone(doc);
}

export function createStore(): Store {
  // The save payload is { name, doc }; a bad save falls back to the sample.
  let initial: Document;
  let initialName = "Untitled";
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object" && "doc" in parsed && "name" in parsed) {
      const doc = parseSave((parsed as { doc: unknown }).doc);
      if (doc) {
        initial = doc;
        initialName = typeof (parsed as { name: unknown }).name === "string" ? (parsed as { name: string }).name : "Untitled";
      } else {
        initial = sampleDocument();
      }
    } else {
      initial = sampleDocument();
    }
  } catch {
    initial = sampleDocument();
  }

  const listeners = new Set<() => void>();
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // A hold drag in progress: the frame being dragged and its hold at
  // drag start, so the drag commits as one undo step.
  let holdDragState: { layerId: string; index: number; startHold: number } | null = null;

  const store: Store = {
    doc: initial,
    name: initialName,
    tool: "select",
    shapeKind: "rect",
    color: "#1d1d1f",
    color2: "#007aff",
    brushSize: 4,
    view: { zoom: 1, panX: 0, panY: 0, rotateDeg: 0 },
    currentLayerId: initial.layers[0].id,
    currentByLayer: new Map(initial.layers.map((l) => [l.id, 0])),
    pos: 0,
    playing: false,
    loop: false,
    selection: [],

    onChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    emit(): void {
      for (const cb of listeners) cb();
    },

    setTool(t: ToolId): void {
      store.tool = t;
      store.clearSelection();
      store.emit();
    },

    setShapeKind(k: "rect" | "ellipse"): void {
      store.shapeKind = k;
      store.emit();
    },

    setColor(c: string): void {
      store.color = c;
      store.emit();
    },

    setColor2(c: string): void {
      store.color2 = c;
      store.emit();
    },

    swapColors(): void {
      const c = store.color;
      store.color = store.color2;
      store.color2 = c;
      store.emit();
    },

    setBrushSize(n: number): void {
      store.brushSize = Math.min(64, Math.max(1, Math.round(n)));
      store.emit();
    },

    setView(v: Partial<ViewState>): void {
      store.view = { ...store.view, ...v };
      store.emit();
    },

    resetView(): void {
      store.view = { zoom: 1, panX: 0, panY: 0, rotateDeg: 0 };
      store.emit();
    },

    resetZoom(): void {
      store.view = { ...store.view, zoom: 1, panX: 0, panY: 0 };
      store.emit();
    },

    setCurrentLayer(id: string): void {
      if (!store.doc.layers.some((l) => l.id === id)) return;
      store.currentLayerId = id;
      if (!store.currentByLayer.has(id)) store.currentByLayer.set(id, 0);
      store.pos = frameStartPos(store.doc.layers.find((l) => l.id === id) as Layer, store.currentByLayer.get(id) ?? 0);
      store.clearSelection();
      store.emit();
    },

    setCurrentFrame(layerId: string, index: number): void {
      const layer = store.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      const clamped = Math.min(layer.frames.length - 1, Math.max(0, index));
      store.currentLayerId = layerId;
      store.currentByLayer.set(layerId, clamped);
      store.pos = frameStartPos(layer, clamped);
      store.clearSelection();
      store.emit();
    },

    currentFrame(): { layer: Layer; frame: Frame; index: number } {
      const layer = store.doc.layers.find((l) => l.id === store.currentLayerId) ?? store.doc.layers[0];
      const index = Math.min(layer.frames.length - 1, store.currentByLayer.get(layer.id) ?? 0);
      return { layer, frame: layer.frames[index], index };
    },

    displayPos(): number {
      if (store.playing) return store.pos;
      const { layer, index } = store.currentFrame();
      return frameStartPos(layer, index);
    },

    setPos(p: number): void {
      store.pos = Math.min(timelineLength(store.doc) - 1, Math.max(0, Math.round(p)));
      store.emit();
    },

    setPlaying(b: boolean): void {
      store.playing = b;
      store.emit();
    },

    toggleLoop(): void {
      store.loop = !store.loop;
      store.emit();
    },

    playToggle(): void {
      if (!store.playing && store.pos >= timelineLength(store.doc) - 1) store.pos = 0;
      store.playing = !store.playing;
      store.emit();
    },

    // Stop returns to the start: the playhead AND the displayed frame.
    // displayPos shows the selected frame while paused, so leaving the
    // selection where it was would show frame 3 while the clock says 1/6.
    stop(): void {
      store.playing = false;
      store.pos = 0;
      const layer = store.doc.layers.find((l) => l.id === store.currentLayerId) ?? store.doc.layers[0];
      store.currentByLayer.set(layer.id, 0);
      store.clearSelection();
      store.emit();
    },

    // Back / Forward step ONE timeline frame at a time, clamped at the
    // ends — no wrapping (wrapping is the Loop button's job, during
    // playback). Stepping also moves the current layer's selected frame
    // to the frame at the new playhead, so the canvas follows while
    // paused: displayPos shows the selected frame, not the raw pos.
    back(): void {
      store.playing = false;
      const next = Math.max(0, store.pos - 1);
      store.pos = next;
      const layer = store.doc.layers.find((l) => l.id === store.currentLayerId) ?? store.doc.layers[0];
      store.currentByLayer.set(layer.id, frameAt(layer, next).index);
      store.emit();
    },

    forward(): void {
      store.playing = false;
      const next = Math.min(timelineLength(store.doc) - 1, store.pos + 1);
      store.pos = next;
      const layer = store.doc.layers.find((l) => l.id === store.currentLayerId) ?? store.doc.layers[0];
      store.currentByLayer.set(layer.id, frameAt(layer, next).index);
      store.emit();
    },

    setName(n: string): void {
      store.name = n;
      store.save();
      store.emit();
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    undo(): void {
      const s = undoStack.pop();
      if (!s) return;
      redoStack.push({ doc: cloneDoc(store.doc), name: store.name });
      store.doc = s.doc;
      store.name = s.name;
      store.selection = [];
      if (!store.doc.layers.some((l) => l.id === store.currentLayerId)) {
        store.currentLayerId = store.doc.layers[0].id;
      }
      store.save();
      store.emit();
    },

    redo(): void {
      const s = redoStack.pop();
      if (!s) return;
      undoStack.push({ doc: cloneDoc(store.doc), name: store.name });
      store.doc = s.doc;
      store.name = s.name;
      store.selection = [];
      if (!store.doc.layers.some((l) => l.id === store.currentLayerId)) {
        store.currentLayerId = store.doc.layers[0].id;
      }
      store.save();
      store.emit();
    },

    pushUndo(): void {
      undoStack.push({ doc: cloneDoc(store.doc), name: store.name });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    },

    // Drop the last undo entry — for a gesture that turned out to be a
    // no-op (a shape dragged 2px, a stroke that never started).
    popUndo(): void {
      undoStack.pop();
    },

    mutate(fn: (doc: Document) => void): void {
      store.pushUndo();
      fn(store.doc);
      store.save();
      store.emit();
    },

    select(refs: SelectionRef[]): void {
      store.selection = refs;
      store.emit();
    },

    clearSelection(): void {
      if (store.selection.length === 0) return;
      store.selection = [];
      store.emit();
    },

    resolveSelection(): ResolvedSelection[] {
      const out: ResolvedSelection[] = [];
      for (const ref of store.selection) {
        const layer = store.doc.layers.find((l) => l.id === ref.layerId);
        if (!layer || !layer.visible) continue;
        const frame = layer.frames.find((f) => f.id === ref.frameId);
        if (!frame) continue;
        const item = frame.items.find((it) => it.id === ref.itemId);
        if (item) out.push({ layer, frame, item });
      }
      return out;
    },

    moveSelection(dx: number, dy: number): void {
      for (const { item } of store.resolveSelection()) {
        if (item.type === "stroke") {
          for (const p of item.points) {
            p.x += dx;
            p.y += dy;
          }
        } else if (item.type === "shape") {
          item.x += dx;
          item.y += dy;
        } else {
          item.x += dx;
          item.y += dy;
        }
      }
      store.emit();
    },

    duplicateSelection(): void {
      const sel = store.resolveSelection();
      if (sel.length === 0) return;
      store.pushUndo();
      const refs: SelectionRef[] = [];
      for (const { layer, frame, item } of sel) {
        const copy = structuredClone(item);
        copy.id = nid();
        if (copy.type === "stroke") {
          for (const p of copy.points) {
            p.x += 16;
            p.y += 16;
          }
        } else if (copy.type === "shape") {
          copy.x += 16;
          copy.y += 16;
        } else {
          copy.x += 16;
          copy.y += 16;
        }
        frame.items.push(copy);
        refs.push({ layerId: layer.id, frameId: frame.id, itemId: copy.id });
      }
      store.selection = refs;
      store.save();
      store.emit();
    },

    deleteSelection(): void {
      const sel = store.resolveSelection();
      if (sel.length === 0) return;
      store.pushUndo();
      const ids = new Set(sel.map((s) => s.item.id));
      for (const layer of store.doc.layers) {
        for (const frame of layer.frames) {
          frame.items = frame.items.filter((it) => !ids.has(it.id));
        }
      }
      store.selection = [];
      store.save();
      store.emit();
    },

    addLayer(): void {
      store.pushUndo();
      const n = store.doc.layers.length + 1;
      const layer: Layer = {
        id: nid(), name: `Layer ${n}`, visible: true,
        frames: [{ id: nid(), items: [], hold: 1 }],
      };
      // Layers[0] is the top layer; a new layer goes on top.
      store.doc.layers.unshift(layer);
      store.currentLayerId = layer.id;
      store.currentByLayer.set(layer.id, 0);
      store.pos = 0;
      store.save();
      store.emit();
    },

    renameLayer(id: string, name: string): void {
      const layer = store.doc.layers.find((l) => l.id === id);
      if (!layer || name.trim().length === 0) return;
      store.pushUndo();
      layer.name = name.trim();
      store.save();
      store.emit();
    },

    deleteLayer(id: string): void {
      if (store.doc.layers.length <= 1) return;
      store.pushUndo();
      store.doc.layers = store.doc.layers.filter((l) => l.id !== id);
      if (store.currentLayerId === id) store.currentLayerId = store.doc.layers[0].id;
      store.currentByLayer.delete(id);
      store.selection = [];
      store.save();
      store.emit();
    },

    moveLayer(id: string, dir: -1 | 1): void {
      const i = store.doc.layers.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= store.doc.layers.length) return;
      store.pushUndo();
      const [layer] = store.doc.layers.splice(i, 1);
      store.doc.layers.splice(j, 0, layer);
      store.save();
      store.emit();
    },

    toggleLayerVisible(id: string): void {
      const layer = store.doc.layers.find((l) => l.id === id);
      if (!layer) return;
      store.pushUndo();
      layer.visible = !layer.visible;
      store.save();
      store.emit();
    },

    // The + button creates an EMPTY frame — no items — not a copy of
    // the current frame. (Duplicate stays removed; this is not it.)
    addFrame(layerId: string): void {
      const layer = store.doc.layers.find((l) => l.id === layerId);
      if (!layer) return;
      store.pushUndo();
      const frame: Frame = { id: nid(), items: [], hold: 1 };
      layer.frames.push(frame);
      store.setCurrentFrame(layerId, layer.frames.length - 1);
      store.save();
    },

    // A layer keeps at least one frame — deleting the only frame is a no-op.
    deleteFrame(layerId: string, index: number): void {
      const layer = store.doc.layers.find((l) => l.id === layerId);
      if (!layer || layer.frames.length <= 1) return;
      const clamped = Math.min(layer.frames.length - 1, Math.max(0, index));
      store.pushUndo();
      layer.frames.splice(clamped, 1);
      const cur = store.currentByLayer.get(layerId) ?? 0;
      if (cur >= layer.frames.length) store.currentByLayer.set(layerId, layer.frames.length - 1);
      else if (cur > clamped) store.currentByLayer.set(layerId, cur - 1);
      if (store.currentLayerId === layerId) {
        store.pos = frameStartPos(layer, store.currentByLayer.get(layerId) ?? 0);
      }
      store.pos = Math.min(store.pos, timelineLength(store.doc) - 1);
      store.selection = [];
      store.save();
      store.emit();
    },

    // A hold drag is one undo step: the snapshot is taken on drag
    // start, the hold is previewed live without further snapshots,
    // and if the drag ends unchanged the snapshot is dropped.
    beginHoldDrag(layerId: string, index: number): void {
      const layer = store.doc.layers.find((l) => l.id === layerId);
      const frame = layer?.frames[index];
      if (!frame) return;
      store.pushUndo();
      holdDragState = { layerId, index, startHold: frame.hold };
    },

    previewHold(hold: number): void {
      const drag = holdDragState;
      if (!drag) return;
      const layer = store.doc.layers.find((l) => l.id === drag.layerId);
      const frame = layer?.frames[drag.index];
      if (!frame) return;
      const h = Math.min(24, Math.max(1, Math.round(hold)));
      if (h === frame.hold) return;
      frame.hold = h;
      store.save();
      store.emit();
    },

    endHoldDrag(): void {
      const drag = holdDragState;
      if (!drag) return;
      const layer = store.doc.layers.find((l) => l.id === drag.layerId);
      const frame = layer?.frames[drag.index];
      const changed = frame ? frame.hold !== drag.startHold : false;
      if (!changed) store.popUndo();
      holdDragState = null;
      if (changed) store.emit();
    },

    save(): void {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(SAVE_KEY, JSON.stringify({ name: store.name, doc: store.doc }));
        } catch {
          // Storage full or unavailable — the session keeps working.
        }
      }, 300);
    },
  };

  return store;
}

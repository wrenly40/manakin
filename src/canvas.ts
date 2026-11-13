// Canvas view: the pasteboard workspace, the stage, and all pointer input
// (draw, erase, drag, marquee, text, pan, zoom, rotate). The store owns
// the document; this view owns the canvas element and the drag state.
import type { Item, Pt, ShapeItem, StrokeItem, WorkspaceLayout } from "./model";
import {
  ZOOM_STOPS,
  clampAxis,
  eraseFromItems,
  frameAt,
  hitTestItems,
  itemBBox,
  nid,
  normDeg,
  stagePointFor,
  stageSizeFor,
  stageToScreenFor,
  workspaceLayoutFor,
} from "./model";
import { renderStage } from "./render";
import type { Store } from "./store";

type Drag =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "rotate"; startX: number; startY: number; deg: number }
  | { kind: "move"; start: Pt; moved: boolean }
  | { kind: "marquee"; start: Pt; current: Pt }
  | { kind: "pen"; item: StrokeItem }
  | { kind: "shape"; start: Pt; current: Pt }
  | { kind: "erase"; erased: boolean }
  | { kind: "none" };

export type CanvasView = {
  render(): void;
  layout(): WorkspaceLayout;
  closeTextEditor(commit: boolean): void;
};

export function createCanvasView(wrapEl: HTMLElement, store: Store): CanvasView {
  const canvas = document.createElement("canvas");
  canvas.id = "stage";
  wrapEl.appendChild(canvas);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

  const ring = document.createElement("div");
  ring.id = "eraser-ring";
  ring.style.display = "none";
  wrapEl.appendChild(ring);

  const editor = document.createElement("textarea");
  editor.id = "text-editor";
  editor.style.display = "none";
  wrapEl.appendChild(editor);

  let drag: Drag = { kind: "none" };
  let previewShape: ShapeItem | null = null;
  let previewStroke: StrokeItem | null = null;
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let spaceDown = false;
  let rDown = false;
  let editingText: { itemId: string | null; layerId: string; frameId: string; x: number; y: number } | null = null;

  function layout(): WorkspaceLayout {
    const stage = stageSizeFor(store.doc.stageId);
    return workspaceLayoutFor(store.view, stage, { w: wrapEl.clientWidth, h: wrapEl.clientHeight });
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = wrapEl.clientWidth;
    const h = wrapEl.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    render();
  }

  function render(): void {
    const dpr = window.devicePixelRatio || 1;
    const L = layout();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const previewItems: Item[] = [];
    if (previewStroke) previewItems.push(previewStroke);
    if (previewShape) previewItems.push(previewShape);
    renderStage(ctx, L, store.doc, {
      pos: store.displayPos(),
      currentLayerId: store.currentLayerId,
      previewItems: previewItems.length > 0 ? previewItems : undefined,
    });
    // Selection outlines, in stage coordinates (rotated with the stage).
    for (const { item } of store.resolveSelection()) {
      const b = itemBBox(item);
      ctx.save();
      ctx.translate(L.cw / 2, L.ch / 2);
      ctx.rotate(L.r);
      ctx.translate(-L.cw / 2, -L.ch / 2);
      ctx.translate(L.ox, L.oy);
      ctx.scale(L.s, L.s);
      ctx.strokeStyle = "#007aff";
      ctx.lineWidth = 1.5 / L.s;
      ctx.setLineDash([6 / L.s, 4 / L.s]);
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      ctx.restore();
    }
    // Marquee, in screen coordinates.
    if (marquee) {
      ctx.save();
      ctx.strokeStyle = "#007aff";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(marquee.x0, marquee.x1),
        Math.min(marquee.y0, marquee.y1),
        Math.abs(marquee.x1 - marquee.x0),
        Math.abs(marquee.y1 - marquee.y0),
      );
      ctx.fillStyle = "rgba(0, 122, 255, 0.06)";
      ctx.fillRect(
        Math.min(marquee.x0, marquee.x1),
        Math.min(marquee.y0, marquee.y1),
        Math.abs(marquee.x1 - marquee.x0),
        Math.abs(marquee.y1 - marquee.y0),
      );
      ctx.restore();
    }
  }

  // ---- Editing helpers ------------------------------------------------------

  function displayedItems(): { layerId: string; frameId: string; items: Item[] }[] {
    const pos = store.displayPos();
    const out: { layerId: string; frameId: string; items: Item[] }[] = [];
    for (const layer of store.doc.layers) {
      // A locked layer's items are skipped by hit-testing: they cannot
      // be selected, moved, or edited on canvas. Marquee uses this too.
      if (!layer.visible || layer.locked) continue;
      const { frame } = frameAt(layer, pos);
      out.push({ layerId: layer.id, frameId: frame.id, items: frame.items });
    }
    return out;
  }

  function hitAt(p: Pt): { layerId: string; frameId: string; item: Item } | null {
    // Layers[0] is the top layer, so the first hit wins.
    for (const { layerId, frameId, items } of displayedItems()) {
      const hit = hitTestItems(items, p);
      if (hit) return { layerId, frameId, item: hit };
    }
    return null;
  }

  function stagePoint(e: PointerEvent): Pt {
    const rect = canvas.getBoundingClientRect();
    return stagePointFor(layout(), e.clientX, e.clientY, rect.left, rect.top);
  }

  function isTypingTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  }

  // ---- Text editor ----------------------------------------------------------

  function openTextEditor(item: { layerId: string; frameId: string; item: Item } | null, p: Pt): void {
    const L = layout();
    const screen = stageToScreenFor(L, p);
    const isText = !!item && item.item.type === "text";
    editingText = {
      itemId: isText && item ? item.item.id : null,
      layerId: isText && item ? item.layerId : store.currentLayerId,
      frameId: isText && item ? item.frameId : store.currentFrame().frame.id,
      x: p.x,
      y: p.y,
    };
    editor.value = item && item.item.type === "text" ? item.item.text : "";
    editor.style.display = "block";
    editor.style.left = `${screen.x}px`;
    editor.style.top = `${screen.y - 32 * L.s}px`;
    editor.style.fontSize = `${Math.max(12, 32 * L.s)}px`;
    editor.focus();
  }

  function closeTextEditor(commit: boolean): void {
    if (!editingText) return;
    const text = editor.value;
    const target = editingText;
    editingText = null;
    editor.style.display = "none";
    if (!commit || text.trim().length === 0) {
      render();
      return;
    }
    // The layer may have been locked while the editor was open — a
    // locked layer takes no edits, so the text is dropped, not saved.
    const targetLayer = store.doc.layers.find((l) => l.id === target.layerId);
    if (!targetLayer || targetLayer.locked) {
      render();
      return;
    }
    store.pushUndo();
    if (target.itemId) {
      for (const layer of store.doc.layers) {
        for (const frame of layer.frames) {
          const it = frame.items.find((i) => i.id === target.itemId);
          if (it && it.type === "text") it.text = text;
        }
      }
    } else {
      const layer = store.doc.layers.find((l) => l.id === target.layerId);
      const frame = layer?.frames.find((f) => f.id === target.frameId) ?? store.currentFrame().frame;
      frame.items.push({
        id: nid(), type: "text", x: target.x, y: target.y, text, size: 32, color: store.color,
      });
    }
    store.save();
    store.emit();
    render();
  }

  // ---- Pointer input ----------------------------------------------------------

  function updateCursor(): void {
    const cursors: Record<string, string> = {
      select: "default",
      pen: "crosshair",
      eraser: "none",
      shape: "crosshair",
      text: "text",
      paint: "pointer",
    };
    canvas.style.cursor = spaceDown ? "grab" : cursors[store.tool];
  }

  function updateRing(e: PointerEvent): void {
    if (store.tool !== "eraser") {
      ring.style.display = "none";
      return;
    }
    const L = layout();
    const d = Math.max(6, store.brushSize * 2 * L.s);
    ring.style.display = "block";
    ring.style.width = `${d}px`;
    ring.style.height = `${d}px`;
    const rect = wrapEl.getBoundingClientRect();
    ring.style.left = `${e.clientX - rect.left - d / 2}px`;
    ring.style.top = `${e.clientY - rect.top - d / 2}px`;
  }

  canvas.addEventListener("pointerdown", (e) => {
    // Prevent the default focus change and text selection: without this,
    // opening the text editor on mousedown is immediately undone when the
    // browser moves focus to the body and the editor blurs shut.
    e.preventDefault();
    if (e.button === 1 || spaceDown) {
      drag = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: store.view.panX, panY: store.view.panY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (rDown) {
      drag = { kind: "rotate", startX: e.clientX, startY: e.clientY, deg: store.view.rotateDeg };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const p = stagePoint(e);
    canvas.setPointerCapture(e.pointerId);
    if (store.playing) store.setPlaying(false);
    // A locked active layer takes no canvas edits at all — pen, shape,
    // text, paint, eraser all stop here. The select tool still works
    // (hit-testing skips the locked layer's items but can select items
    // on other layers), and pan/rotate already returned above.
    if (store.tool !== "select" && store.currentFrame().layer.locked) return;

    if (store.tool === "pen") {
      const { frame } = store.currentFrame();
      store.pushUndo();
      const item: StrokeItem = { id: nid(), type: "stroke", points: [p], color: store.color, width: store.brushSize };
      previewStroke = item;
      frame.items.push(item);
      drag = { kind: "pen", item };
      render();
      return;
    }
    if (store.tool === "shape") {
      drag = { kind: "shape", start: p, current: p };
      return;
    }
    if (store.tool === "text") {
      openTextEditor(hitAt(p), p);
      return;
    }
    if (store.tool === "eraser") {
      store.pushUndo();
      drag = { kind: "erase", erased: false };
      eraseAt(p);
      return;
    }
    if (store.tool === "paint") {
      const hit = hitAt(p);
      store.pushUndo();
      if (hit && hit.item.type === "shape") {
        hit.item.fill = true;
        hit.item.color = store.color;
      } else if (!hit) {
        store.doc.stageBg = store.color;
      } else {
        store.popUndo();
        return;
      }
      store.save();
      store.emit();
      render();
      return;
    }
    // Select tool.
    const hit = hitAt(p);
    if (hit) {
      const ref = { layerId: hit.layerId, frameId: hit.frameId, itemId: hit.item.id };
      const already = store.selection.some((s) => s.itemId === ref.itemId);
      if (e.shiftKey) {
        store.select(already ? store.selection.filter((s) => s.itemId !== ref.itemId) : [...store.selection, ref]);
      } else if (!already) {
        store.select([ref]);
      }
      drag = { kind: "move", start: p, moved: false };
    } else {
      if (!e.shiftKey) store.clearSelection();
      drag = { kind: "marquee", start: p, current: p };
    }
    render();
  });

  function eraseAt(p: Pt): void {
    if (drag.kind !== "erase") return;
    let any = false;
    for (const layer of store.doc.layers) {
      if (!layer.visible || layer.locked) continue;
      const { frame } = frameAt(layer, store.displayPos());
      const r = eraseFromItems(frame.items, p, store.brushSize);
      if (r.changed) {
        frame.items = r.items;
        any = true;
      }
    }
    if (any) {
      drag.erased = true;
      // Erasing may have removed a selected item.
      store.selection = store.selection.filter((s) => {
        const layer = store.doc.layers.find((l) => l.id === s.layerId);
        const frame = layer?.frames.find((f) => f.id === s.frameId);
        return !!frame?.items.some((it) => it.id === s.itemId);
      });
      store.emit();
    }
    render();
  }

  canvas.addEventListener("pointermove", (e) => {
    updateRing(e);
    if (drag.kind === "none") return;
    const p = stagePoint(e);
    const L = layout();
    if (drag.kind === "pan") {
      const stage = stageSizeFor(store.doc.stageId);
      const baseX = (L.cw - stage.w * L.s) / 2;
      const baseY = (L.ch - stage.h * L.s) / 2;
      store.setView({
        panX: clampAxis(drag.panX + (e.clientX - drag.startX), baseX, stage.w * L.s, L.cw),
        panY: clampAxis(drag.panY + (e.clientY - drag.startY), baseY, stage.h * L.s, L.ch),
      });
      return;
    }
    if (drag.kind === "rotate") {
      const dx = e.clientX - drag.startX;
      store.setView({ rotateDeg: normDeg(drag.deg + dx * 0.4) });
      return;
    }
    if (drag.kind === "move") {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        if (!drag.moved) {
          store.pushUndo();
          drag.moved = true;
        }
        store.moveSelection(dx, dy);
        drag.start = p;
      }
      render();
      return;
    }
    if (drag.kind === "marquee") {
      drag.current = p;
      const a = stageToScreenFor(L, drag.start);
      const b = stageToScreenFor(L, drag.current);
      // Marquee is drawn in canvas pixels; stageToScreen already returns
      // canvas-relative coordinates.
      marquee = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      render();
      return;
    }
    if (drag.kind === "pen") {
      const last = drag.item.points[drag.item.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5) {
        drag.item.points.push(p);
        previewStroke = drag.item;
        render();
      }
      return;
    }
    if (drag.kind === "shape") {
      drag.current = p;
      previewShape = {
        id: "preview", type: "shape", kind: store.shapeKind,
        x: drag.start.x, y: drag.start.y,
        w: p.x - drag.start.x, h: p.y - drag.start.y,
        color: store.color, width: store.brushSize, fill: false,
      };
      render();
      return;
    }
    if (drag.kind === "erase") {
      eraseAt(p);
      return;
    }
  });

  function finishPointerDrag(): void {
    if (drag.kind === "pen") {
      const item = drag.item;
      if (item.points.length === 1) item.points.push({ ...item.points[0] });
      previewStroke = null;
      store.save();
      store.emit();
    }
    if (drag.kind === "shape") {
      if (previewShape && Math.abs(previewShape.w) > 4 && Math.abs(previewShape.h) > 4) {
        const { frame } = store.currentFrame();
        store.pushUndo();
        frame.items.push({ ...previewShape, id: nid() });
        store.save();
        store.emit();
      }
      previewShape = null;
    }
    if (drag.kind === "move") {
      if (drag.moved) {
        store.save();
        store.emit();
      }
    }
    if (drag.kind === "marquee") {
      if (marquee) {
        const x0 = Math.min(drag.start.x, drag.current.x);
        const x1 = Math.max(drag.start.x, drag.current.x);
        const y0 = Math.min(drag.start.y, drag.current.y);
        const y1 = Math.max(drag.start.y, drag.current.y);
        const refs: { layerId: string; frameId: string; itemId: string }[] = [];
        for (const { layerId, frameId, items } of displayedItems()) {
          for (const it of items) {
            const b = itemBBox(it);
            if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) {
              refs.push({ layerId, frameId, itemId: it.id });
            }
          }
        }
        store.select(refs);
      }
      marquee = null;
    }
    if (drag.kind === "erase") {
      if (!drag.erased) store.popUndo();
      else {
        store.save();
        store.emit();
      }
    }
    drag = { kind: "none" };
    render();
  }

  canvas.addEventListener("pointerup", finishPointerDrag);
  canvas.addEventListener("pointercancel", finishPointerDrag);

  canvas.addEventListener("pointerleave", () => {
    ring.style.display = "none";
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const dir = e.deltaY > 0 ? -1 : 1;
      const i = ZOOM_STOPS.indexOf(store.view.zoom);
      const next = ZOOM_STOPS[Math.min(ZOOM_STOPS.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))];
      zoomAt(next, e.clientX, e.clientY);
      return;
    }
    const stage = stageSizeFor(store.doc.stageId);
    const L = layout();
    const baseX = (L.cw - stage.w * L.s) / 2;
    const baseY = (L.ch - stage.h * L.s) / 2;
    store.setView({
      panX: clampAxis(store.view.panX - e.deltaX, baseX, stage.w * L.s, L.cw),
      panY: clampAxis(store.view.panY - e.deltaY, baseY, stage.h * L.s, L.ch),
    });
  }, { passive: false });

  function zoomAt(zoom: number, clientX: number, clientY: number): void {
    const before = stagePoint({ clientX, clientY } as PointerEvent);
    const stage = stageSizeFor(store.doc.stageId);
    const L0 = layout();
    const rect = canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    store.setView({ zoom });
    // Correct the pan so the point under the cursor stays put.
    const L1 = workspaceLayoutFor({ ...store.view, zoom }, stage, { w: L0.cw, h: L0.ch });
    const after = stageToScreenFor(L1, before);
    store.setView({
      panX: store.view.panX + (cx - after.x),
      panY: store.view.panY + (cy - after.y),
    });
  }

  // Space pans, R rotates; typing in an input never triggers either.
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e)) return;
    if (e.code === "Space") {
      spaceDown = true;
      updateCursor();
      e.preventDefault();
    }
    if (e.key === "r" || e.key === "R") {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) rDown = true;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceDown = false;
      updateCursor();
    }
    if (e.key === "r" || e.key === "R") rDown = false;
  });

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      closeTextEditor(true);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeTextEditor(false);
    }
    e.stopPropagation();
  });
  editor.addEventListener("blur", () => closeTextEditor(true));

  new ResizeObserver(() => resize()).observe(wrapEl);
  store.onChange(() => render());
  updateCursor();
  resize();

  return {
    render,
    layout,
    closeTextEditor,
  };
}

// Canvas — the drawing surface (Manakin Plugin API v1).
//
// Owns the stage surface: the canvas and the text editor inside the
// shell's stage wrap, all rendering (the stage card, the grid, the
// items, the selection outlines, the shape preview and the marquee),
// and all pointer input (drawing, erasing, selecting, moving, pan,
// rotate, the text tool, the paint bucket). The core never names it:
// it renders through the canvas-renderer registry, and the player
// drives the frame loop through api.canvas.requestRender.
//
// State the plugin owns: the canvas and its context, the text editor,
// the in-progress drag, the shape preview, the marquee, the
// double-click bookkeeping, the open text session, the eraser ring.
// Document state (items, selection, tool, colours) stays in the core
// and is reached through api.doc; view state (zoom, pan, rotation)
// through api.view; the clock through api.transport.
//
// The module keeps its state at module scope, like plugins.ts keeps
// `host`: `api` is set in activate() and is valid while the plugin is
// active. deactivate() removes every entry point (the renderer, the
// listeners, the subscriptions), so nothing reads it afterwards.

import type { CanvasRenderer, PluginContext, PluginModule } from "../plugins";
import {
  baseItem,
  densify,
  hexToRgba,
  hitDistance,
  hitTest,
  itemBBox,
  motionAdjustedPoint,
  motionForItem,
  moveItem,
  nid,
  renderedBBox,
  setTextMeasurer,
  shapeOutline,
  stageBgValueFor,
  stagePointFor,
  stageToScreenFor,
} from "../model";
import type { Item, ItemBase, Pt, ShapeItem, StrokeItem, TextItem, WorkspaceLayout } from "../model";

export const manifest = {
  id: "core-canvas",
  name: "Canvas",
  version: "1.0.0",
  apiVersion: "1",
  description: "The drawing surface: stage rendering, pointer input, text editing.",
  permissions: ["doc", "view", "transport", "canvas", "shell", "events"],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let api!: PluginContext;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let stageWrap!: HTMLElement;
let textEditor!: HTMLTextAreaElement;

// Pan and rotate drags: view state in progress, never a document
// change, so they live here with the pointer handlers that own them.
let panDrag: { x: number; y: number; panX: number; panY: number } | null = null;
let rotateDrag: { startAngle: number; startDeg: number } | null = null;
// Double-click bookkeeping: the second press of a pair (<400ms, same
// spot) is a repeat, not a new action.
let lastDown: { t: number; x: number; y: number } | null = null;
let lastPressRepeat = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The stage background, from the document's background setting.
function stageBg(): string {
  const bg = api.doc.getStageBg();
  return stageBgValueFor(bg.id, bg.custom);
}

// A click tested against what the user sees: the items at their
// animated pose, at the loop position right now.
function hitTestAt(p: Pt): Item | null {
  return hitTest(api.doc.getItems(), p, api.transport.getPlayTime() / api.app.getLoopMs(), api.doc.getItemGroups());
}

// Stage point from a pointer event, through the current view.
function stagePoint(e: { clientX: number; clientY: number }): Pt {
  const rect = canvas.getBoundingClientRect();
  return stagePointFor(api.view.getLayout(), e.clientX, e.clientY, rect.left, rect.top);
}

// Stage to screen coordinates, for DOM overlays (the text editor):
// the inverse of stagePoint — origin and scale, then the view
// rotation around the workspace centre.
function stageToScreen(p: Pt): Pt {
  return stageToScreenFor(api.view.getLayout(), p);
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
  const pan = api.view.getPan();
  api.view.setPan(pan.x, pan.y); // a smaller window re-clamps the same pan
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { cw, ch } = api.view.getLayout();
  canvas.width = Math.max(1, Math.round(cw * dpr));
  canvas.height = Math.max(1, Math.round(ch * dpr));
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
}
// Focus alpha: the focused part renders full, everything else at 0.1
// (faintly visible, not hidden). A dangling id (item deleted/undone away)
// clears itself. Focus is view state, so it never applies to exports.
function validFocus(): string | null {
  const f = api.doc.getFocusedId();
  if (f !== null && !api.doc.getItems().some((i) => i.id === f)) {
    api.doc.setFocusedId(null);
    return null;
  }
  return f;
}
function focusAlpha(it: Item): number {
  const f = validFocus();
  if (f === null) return 1;
  return it.id === f ? 1 : 0.1;
}
function drawItem(c: CanvasRenderingContext2D, it: Item, t01: number, applyFocus: boolean, opts?: { noMotion?: boolean; colour?: string; alpha?: number }): void {
  const b = itemBBox(it);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  // Onion skin draws a neighbouring frame's items at rest, in a flat
  // ghost colour: no motion (the ghost is the drawing, not the pose)
  // and no focus dimming.
  const m = opts?.noMotion
    ? { dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1, sx: 1, sy: 1 }
    : motionForItem(it, t01, api.doc.getItemGroups());
  c.save();
  c.translate(cx + m.dx, cy + m.dy);
  c.rotate(m.rot);
  c.scale(m.scale * m.sx, m.scale * m.sy);
  c.translate(-cx, -cy);
  // Focus dims the part; it multiplies the animated opacity (e.g. Blink)
  // rather than replacing it. The onion alpha multiplies on top.
  c.globalAlpha = m.opacity * (applyFocus ? focusAlpha(it) : 1) * (opts?.alpha ?? 1);
  const colour = opts?.colour ?? it.color;
  c.strokeStyle = colour;
  c.fillStyle = colour;
  c.lineWidth = it.width;
  c.lineCap = "round";
  c.lineJoin = "round";
  if (it.type === "stroke") {
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
  } else if (it.type === "shape") {
    c.beginPath();
    if (it.kind === "rect") c.rect(it.x, it.y, it.w, it.h);
    else c.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.abs(it.w) / 2, Math.abs(it.h) / 2, 0, 0, Math.PI * 2);
    if (it.fillSolid) c.fill();
    else {
      // Opaque paper base, then the tint: a shape occludes what is
      // beneath it, so Arrange visibly reorders — the body brought to
      // front really covers the head and wing. An isolated shape looks
      // exactly as before: the tint over the stage colour.
      c.fillStyle = stageBg(); c.fill();
      c.fillStyle = hexToRgba(colour, 0.12); c.fill();
    }
    c.stroke();
  } else {
    c.font = `${it.size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    c.textBaseline = "alphabetic";
    c.fillText(it.text, it.x, it.y);
  }
  c.restore();
}
function renderFrame(t01: number, target: CanvasRenderingContext2D = ctx, dprOverride?: number, itemsOverride?: Item[]): void {
  const { w, h } = api.app.getStageSize();
  const dpr = dprOverride ?? Math.min(2, window.devicePixelRatio || 1);
  const onScreen = target === ctx;
  // On screen the stage is a card inside the workspace (origin ox/oy,
  // scale s); offscreen targets are exactly stage-sized, so the stage
  // sits at the origin at full scale — that is the export crop:
  // anything outside the stage rect simply falls off the canvas.
  const L = onScreen ? api.view.getLayout() : { s: 1, ox: 0, oy: 0, cw: w, ch: h, r: 0 };
  target.save();
  target.setTransform(dpr, 0, 0, dpr, 0, 0);
  target.clearRect(0, 0, L.cw, L.ch);
  if (onScreen) {
    // The workspace itself is painted on the canvas (not left to the
    // CSS behind it), so the bitmap is self-contained: the grey
    // workspace, the stage card on it, and items anywhere in it.
    target.fillStyle = "#f5f5f7";
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
    target.shadowColor = "rgba(0,0,0,0.08)";
    target.shadowBlur = 16;
    target.shadowOffsetY = 4;
    target.fillStyle = stageBg();
    roundRectPath(target, L.ox, L.oy, w * L.s, h * L.s, 14);
    target.fill();
    target.restore();
    target.strokeStyle = "rgba(0,0,0,0.08)";
    target.lineWidth = 1;
    roundRectPath(target, L.ox, L.oy, w * L.s, h * L.s, 14);
    target.stroke();
  } else {
    target.fillStyle = stageBg();
    target.fillRect(0, 0, w, h);
  }
  // From here on, stage coordinates: items, grid and selection all
  // live in stage space, on screen and off.
  target.translate(L.ox, L.oy);
  target.scale(L.s, L.s);
  // The grid is a drawing/composition overlay: it renders on the
  // on-screen canvas only, never in exports (offscreen targets), and
  // only inside the stage rect — its lines are stage coordinates.
  if (onScreen && api.doc.getGridMode() !== "empty") {
    const gridCol = api.doc.getStageBg().id === "ink" ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.08)";
    if (api.doc.getGridMode() === "grid") {
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
      if (api.doc.getGridMode() === "thirds") { vlines.push(w / 3, (2 * w) / 3); hlines.push(h / 3, (2 * h) / 3); }
      if (api.doc.getGridMode() === "horizon") { hlines.push(h / 3, (2 * h) / 3); }
      if (api.doc.getGridMode() === "centre") { vlines.push(w / 2); hlines.push(h / 2); }
      if (api.doc.getGridMode() === "golden") { vlines.push(w * g1, w * g2); hlines.push(h * g1, h * g2); }
      target.strokeStyle = gridCol;
      target.lineWidth = 1;
      target.beginPath();
      for (const x of vlines) { target.moveTo(x, 0); target.lineTo(x, h); }
      for (const y of hlines) { target.moveTo(0, y); target.lineTo(w, y); }
      target.stroke();
    }
  }
  // Onion skin: the neighbouring frames ghosted behind the current
  // one, so the next pose can be traced from the last. Previous at
  // ~30% in ink, next at ~15% in accent. On screen only, current
  // frame only — never in exports, never hit-tested, never selectable.
  if (onScreen && !itemsOverride && api.doc.getOnionSkin()) {
    const tl = api.doc.getTimeline();
    const cur = api.doc.getCurrentFrame();
    const next = cur < tl.frames.length - 1 ? tl.frames[cur + 1] : null;
    const prev = cur > 0 ? tl.frames[cur - 1] : null;
    if (next) for (const it of next.items) drawItem(target, it, t01, false, { noMotion: true, colour: "#007aff", alpha: 0.15 });
    if (prev) for (const it of prev.items) drawItem(target, it, t01, false, { noMotion: true, colour: "#1d1d1f", alpha: 0.30 });
  }
  for (const it of itemsOverride ?? api.doc.getItems()) drawItem(target, it, t01, target === ctx);
  const f = validFocus();
  // Every selected item gets its outline (all of them when nothing is
  // focused; only the focused one while focus is on). The outline
  // follows the item's full motion, group layers included.
  if (target === ctx) {
    for (const it of api.doc.getSelectedItems()) {
      if (f !== null && it.id !== f) continue;
      const b = itemBBox(it);
      const m = motionForItem(it, t01, api.doc.getItemGroups());
      target.save();
      target.setLineDash([5, 4]);
      target.strokeStyle = "#007aff";
      target.lineWidth = 1.5;
      target.strokeRect(b.x + m.dx - 5, b.y + m.dy - 5, b.w + 10, b.h + 10);
      target.restore();
    }
  }
  target.restore();
}

let drag: {
  kind: "brush" | "shape" | "select" | "erase" | "marquee";
  start: Pt; last: Pt; item: Item | null; moved: boolean;
  before: string | null; // pre-gesture snapshot, for lazy history (move / erase)
  erased: boolean; // the eraser actually removed ink during this sweep
} | null = null;
let previewShape: ShapeItem | null = null;
let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

// Ending a pointer drag — release or cancellation — runs the same
// finish: commit the gesture, save, clear the drag state. A cancelled
// pointer used to leave `drag` set (only pan/rotate were cleared),
// so the next pointerdown started from a stale drag.
function finishPointerDrag(): void {
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
  if (drag.kind === "shape" && previewShape && previewShape.w > 4 && previewShape.h > 4) {
    api.doc.pushHistory();
    api.doc.getItems().push(previewShape);
  }
  // A move is one undo entry, committed on release — a click without
  // moving adds nothing. Same for an erase sweep over empty space.
  if (drag.kind === "select" && drag.moved) {
    if (drag.before) api.doc.gestureCommit(drag.before, true);
    api.doc.save();
  }
  if (drag.kind === "marquee") {
    if (drag.moved && marquee) {
      // Select every item the rectangle touches, individually —
      // regardless of groups. The rectangle is drawn over what the
      // user sees, so items are tested by their rendered (animated)
      // bbox, not their stored one.
      const t01 = api.transport.getPlayTime() / api.app.getLoopMs();
      const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
      api.doc.setSelection(api.doc.getItems().filter((it) => {
        const b = renderedBBox(it, t01, api.doc.getItemGroups());
        return b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0;
      }).map((it) => it.id));
    } else {
      // A click on empty workspace deselects and exits focus, as before.
      api.doc.setSelection([]);
      if (api.doc.getFocusedId() !== null) api.doc.setFocusedId(null);
    }
    marquee = null;
  }
  if (drag.kind === "erase") {
    if (drag.before) api.doc.gestureCommit(drag.before, drag.erased);
  }
  if (drag.kind === "brush" || drag.kind === "erase" || drag.kind === "shape") api.doc.save(); // shapes were lost on reload until the next save — they never saved on creation
  previewShape = null;
  drag = null;
  api.app.renderPanel();
}
// Wheel over the workspace pans the view — trackpad two-finger
// scroll included, like scrolling a document (content moves against
// the scroll direction). Zoom stays on the buttons and Cmd/Ctrl+=/-/0.
// Paint bucket: a shape fills solid with the foreground colour;
// a stroke or text is recoloured; empty stage fills the stage
// background with the foreground colour. Clicking empty workspace
// outside the stage does nothing — the bucket fills the stage, not
// the pasteboard. Undo restores it.
function paintAt(p: Pt): void {
  const hit = hitTestAt(p);
  if (!hit) {
    const { w, h } = api.app.getStageSize();
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) return;
  }
  api.doc.pushHistory();
  if (!hit) {
    api.doc.setStageBg("custom", api.doc.getColor());
    api.doc.save();
    resizeCanvas();
    api.app.renderPanel();
    return;
  }
  hit.color = api.doc.getColor();
  if (hit.type === "shape") hit.fillSolid = true;
  api.doc.save();
  api.app.renderPanel();
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
  const radius = api.doc.getPenWidth();
  // Like hitTest, the eraser tests what the user SEES: items render at
  // their animated pose (motion offset, scale and rotation about their
  // own centre), so the point is tested against the motion-adjusted
  // geometry, not the stored one — at rest the bird sits ~19px from
  // its stored position, and the old stored-geometry test missed a
  // visibly displaced part. Text is tested by its rendered bbox.
  const t01 = api.transport.getPlayTime() / api.app.getLoopMs();
  let changed = false;
  for (let i = api.doc.getItems().length - 1; i >= 0; i--) {
    const it = api.doc.getItems()[i];
    if (it.type === "text") {
      const b = renderedBBox(it, t01, api.doc.getItemGroups());
      if (p.x >= b.x - radius && p.x <= b.x + b.w + radius && p.y >= b.y - radius && p.y <= b.y + b.h + radius) {
        api.doc.getItems().splice(i, 1);
        if (api.doc.getSelection().includes(it.id)) api.doc.setSelection(api.doc.getSelection().filter((id) => id !== it.id));
        // The erased layers' eased amplitudes stay in `smoothed`: undo
        // restores this item, and its pose must come back exactly
        // instead of re-easing from 0.
        changed = true;
      }
      continue;
    }
    const rawPts: Pt[] = it.type === "stroke" ? it.points : shapeOutline(it);
    // Densify first, so a sparse polyline (a two-point leg, a rectangle
    // edge) can be erased in the middle, not only at stored points.
    const pts = densify(rawPts, Math.max(3, radius / 2));
    const runs: Pt[][] = [];
    let cur: Pt[] = [];
    let removed = 0;
    // The eraser point in this item's stored space: the inverse of
    // its rendered motion, exactly as hitTest tests a click.
    const q = motionAdjustedPoint(it, p, t01, api.doc.getItemGroups());
    for (const pt of pts) {
      if (Math.hypot(pt.x - q.x, pt.y - q.y) > radius) cur.push(pt);
      else {
        removed++;
        if (cur.length) { runs.push(cur); cur = []; }
      }
    }
    if (cur.length) runs.push(cur);
    if (removed === 0) continue;
    changed = true;
    const survivors = runs.filter((r) => r.length >= 2 || (it.type === "stroke" && it.points.length === 1));
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
        members: g.members.map((m) => layerIdMap.get(m)).filter((m): m is string => typeof m === "string"),
      })).filter((g) => g.members.length > 0);
      base.stash = JSON.parse(JSON.stringify(it.stash)) as ItemBase["stash"];
      return { ...base, type: "stroke", points: run };
    });
    // The old layers' eased amplitudes stay (see above): split pieces
    // get fresh layer ids, and undo of the erase restores the original
    // item at its exact pose.
    api.doc.getItems().splice(i, 1, ...replacements);
    if (api.doc.getSelection().includes(it.id)) {
      api.doc.setSelection(api.doc.getSelection().filter((id) => id !== it.id).concat(replacements.map((r) => r.id)));
    }
  }
  api.doc.pruneItemGroups();
  if (changed) api.app.renderPanel();
  return changed;
}
// A dragged selection stays inside the visible workspace: clamp the
// move so the UNION bounding box of all selected items never crosses
// the workspace edge (under the toolbar, panel or player). The stage
// itself is inside the workspace, so parts can still straddle the
// stage edge freely. One clamp for the union keeps the items' relative
// positions; clamping each item separately would squash them together
// at the edge.
function clampMoveUnion(sel: Item[], dx: number, dy: number): { dx: number; dy: number } {
  const { s, ox, oy, cw, ch } = api.view.getLayout();
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
    const L = api.view.getLayout();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rotateView(ctx, L);
    ctx.translate(L.ox, L.oy);
    ctx.scale(L.s, L.s);
    ctx.strokeStyle = previewShape.color;
    ctx.lineWidth = previewShape.width;
    ctx.setLineDash([5, 4]);
    if (previewShape.kind === "rect") ctx.strokeRect(previewShape.x, previewShape.y, previewShape.w, previewShape.h);
    else ctx.beginPath(), ctx.ellipse(previewShape.x + previewShape.w / 2, previewShape.y + previewShape.h / 2, previewShape.w / 2, previewShape.h / 2, 0, 0, Math.PI * 2), ctx.stroke();
    ctx.restore();
  }
  if (marquee) {
    const L = api.view.getLayout();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rotateView(ctx, L);
    ctx.translate(L.ox, L.oy);
    ctx.scale(L.s, L.s);
    ctx.fillStyle = "rgba(0, 122, 255, 0.06)";
    ctx.strokeStyle = "#007aff";
    ctx.lineWidth = 1 / L.s;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

// ---- Text editor ----
// One editor session at a time, tracked at module level. Opening a new
// one finishes the open one first: without this, a second open while
// one is pending leaves two finish closures, and the next blur/Enter
// creates the text twice.
let textSession: { it: TextItem | null; p: Pt } | null = null;
function closeTextEditor(commit: boolean): void {
  const s = textSession;
  if (!s) return;
  textSession = null; // first, so a re-entrant close cannot run twice
  textEditor.style.display = "none";
  const value = textEditor.value.trim();
  if (commit && value) {
    if (s.it) {
      if (value !== s.it.text) { api.doc.pushHistory(); s.it.text = value; }
    } else {
      api.doc.pushHistory();
      const item: TextItem = { ...baseItem(api.doc.getColor(), api.doc.getPenWidth()), type: "text", x: s.p.x, y: s.p.y, text: value, size: 20 };
      api.doc.getItems().push(item);
      api.doc.setSelection([item.id]);
    }
    api.doc.save();
    api.app.renderPanel();
  }
}
function openTextEditor(it: TextItem | null, p: Pt): void {
  if (textSession) closeTextEditor(true);
  // The editor sits in the stage-wrap (the workspace), so position it
  // by the stage origin and scale — like the text it edits.
  const L = api.view.getLayout();
  textEditor.style.display = "block";
  // Positioned in stage space, so it follows zoom, pan and rotation
  // like everything else on the canvas.
  const sp = stageToScreen({ x: it ? it.x : p.x, y: it ? it.y - it.size : p.y - 20 });
  textEditor.style.left = `${sp.x}px`;
  textEditor.style.top = `${sp.y}px`;
  textEditor.style.fontSize = `${20 * L.s}px`;
  textEditor.style.width = "220px";
  textEditor.value = it ? it.text : "";
  textSession = { it, p };
  textEditor.focus();
  textEditor.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); closeTextEditor(true); }
    if (ev.key === "Escape") closeTextEditor(false);
    ev.stopPropagation();
  };
}
// Clicking away commits the text.
// The browser's mousedown default moves focus to the clicked element:
// on the canvas (not focusable) that blurs the text editor the
// pointerdown handler just opened and focused, closing it at once.
// Prevent it while the text tool is active.

// The eraser's reach, drawn at the cursor while the eraser tool is
// active — a body-level div like Bowerbird's #eraser-ring, so panel
// re-renders never wipe it mid-drag. Diameter is the eraser radius
// (the brush size) times two, scaled from stage units to screen pixels.
let eraserRingEl: HTMLDivElement | null = null;
function updateCursor(): void {
  canvas.classList.toggle("select-cursor", api.doc.getTool() === "select");
  canvas.classList.toggle("eraser-cursor", api.doc.getTool() === "eraser");
  // Space held over the workspace offers a pan (grab), R held offers
  // a rotation; a drag of either kind in progress shows the grabbing
  // hand. View gestures win over the tool cursor.
  canvas.classList.toggle("pan-cursor", (api.view.isSpaceHeld() || api.view.isRotateHeld()) && panDrag === null && rotateDrag === null);
  canvas.classList.toggle("panning-cursor", panDrag !== null || rotateDrag !== null);
  if (api.doc.getTool() !== "eraser") updateEraserRing(0, 0, false);
}
function updateEraserRing(clientX: number, clientY: number, show: boolean): void {
  if (!eraserRingEl) {
    eraserRingEl = document.createElement("div");
    eraserRingEl.id = "eraser-ring";
    document.body.appendChild(eraserRingEl);
  }
  if (!show || api.doc.getTool() !== "eraser") {
    eraserRingEl.style.display = "none";
    return;
  }
  const scale = api.view.getLayout().s;
  const d = api.doc.getPenWidth() * 2 * scale;
  eraserRingEl.style.display = "block";
  eraserRingEl.style.width = `${d}px`;
  eraserRingEl.style.height = `${d}px`;
  eraserRingEl.style.left = `${clientX - d / 2}px`;
  eraserRingEl.style.top = `${clientY - d / 2}px`;
}
// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireListeners(): void {
  canvas.addEventListener("pointerdown", (e) => {
    // Clear any lingering text selection first: if a selection exists
    // (from a drag that started on chrome before user-select was
    // disabled, or any other path), the browser treats a press inside
    // it as the start of a native drag — firing dragstart and
    // cancelling this pointer drag after the first move. The text
    // editor is a <textarea>, so its own selection is unaffected.
    window.getSelection()?.removeAllRanges();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    // Pan: middle-button drag, or Space+left-drag. It is never a tool
    // gesture — no selection change, no item, no undo entry — so it is
    // intercepted before the pointer is mapped to stage coordinates
    // and before the double-click bookkeeping below.
    if (e.button === 1 || (api.view.isSpaceHeld() && e.button === 0)) {
      e.preventDefault();
      panDrag = { x: e.clientX, y: e.clientY, panX: api.view.getPan().x, panY: api.view.getPan().y };
      updateCursor();
      return;
    }
    // Rotate: R+left-drag turns the view around the workspace centre.
    // Same interception as pan — never a tool gesture, no selection
    // change, no item, no undo entry. The drag angle is measured from
    // the centre, so the stage turns under the pointer like paper on
    // a desk. Space wins if both modifiers are held.
    if (api.view.isRotateHeld() && e.button === 0) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      rotateDrag = { startAngle: Math.atan2(e.clientY - cy, e.clientX - cx), startDeg: api.view.getRotate() };
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
    if (api.doc.getTool() === "brush") {
      api.doc.pushHistory();
      const stroke: StrokeItem = { ...baseItem(api.doc.getColor(), api.doc.getPenWidth()), type: "stroke", points: [p] };
      api.doc.getItems().push(stroke);
      drag = { kind: "brush", start: p, last: p, item: stroke, moved: false, before: null, erased: false };
    } else if (api.doc.getTool() === "paint") {
      if (!lastPressRepeat) paintAt(p);
      drag = null;
    } else if (api.doc.getTool() === "shape") {
      drag = { kind: "shape", start: p, last: p, item: null, moved: false, before: null, erased: false };
    } else if (api.doc.getTool() === "eraser") {
      // Lazy history: capture the pre-state now, commit it on pointerup
      // only if the sweep actually erased ink.
      const before = api.doc.gestureStart();
      const erased = eraseAt(p);
      drag = { kind: "erase", start: p, last: p, item: null, moved: false, before, erased };
    } else if (api.doc.getTool() === "select") {
      const hit = hitTestAt(p);
      if (hit) {
        if (e.shiftKey) {
          // Shift-click toggles that single item in/out of the
          // selection, even when it belongs to a group — this is how a
          // single member is picked out of a group to edit its own
          // behaviours.
          api.doc.setSelection(api.doc.getSelection().includes(hit.id)
            ? api.doc.getSelection().filter((id) => id !== hit.id)
            : [...api.doc.getSelection(), hit.id]);
          if (api.doc.getFocusedId() === hit.id && !api.doc.getSelection().includes(hit.id)) api.doc.setFocusedId(null);
          api.app.renderPanel();
          drag = null;
        } else {
          // Plain click: a group member selects its whole group — even
          // when the member was picked out alone before (shift-click or
          // double-click). Only when the group itself is already the
          // selection, or the item is already selected alone, does the
          // click keep the selection, so the drag below can move it.
          const g = api.doc.getItemGroupOf(hit.id);
          const groupSelected = !!g && g.memberIds.length === api.doc.getSelection().length &&
            g.memberIds.every((m) => api.doc.getSelection().includes(m));
          if (g && !groupSelected) {
            api.doc.setSelection([...g.memberIds]);
            api.app.renderPanel();
          } else if (!api.doc.getSelection().includes(hit.id)) {
            api.doc.setSelection([hit.id]);
            api.app.renderPanel();
          }
          drag = { kind: "select", start: p, last: p, item: hit, moved: false, before: api.doc.gestureStart(), erased: false };
        }
      } else {
        // Empty workspace: start a marquee. A click without moving
        // deselects on release; a drag selects what the rectangle
        // touches (see pointerup).
        drag = { kind: "marquee", start: p, last: p, item: null, moved: false, before: null, erased: false };
        marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (panDrag) {
      // Pan moves in screen pixels, not stage coordinates — the drag
      // delta is added to the pan directly, then clamped.
      api.view.setPan(panDrag.panX + (e.clientX - panDrag.x), panDrag.panY + (e.clientY - panDrag.y));
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
      api.view.setRotate(rotateDrag.startDeg + (a - rotateDrag.startAngle) * 180 / Math.PI);
      return;
    }
    if (!drag) return;
    const p = stagePoint(e);
    if (drag.kind === "brush" && drag.item?.type === "stroke") {
      // The stored path keeps the raw pointer samples — deliberately NOT
      // interpolated. The midpoint-quadratic render below rounds each
      // joint by an amount that follows the segment length, so sparse
      // fast samples smooth out; filling the gaps first makes the path
      // dense and shrinks that rounding to ~2px, leaving the corners
      // sharp (measured: a 5-sample arc stored as 129 interpolated
      // points still rendered with visible corners at 3x).
      drag.item.points.push(p);
      drag.moved = true;
    } else if (drag.kind === "shape") {
      const x = Math.min(drag.start.x, p.x), y = Math.min(drag.start.y, p.y);
      previewShape = {
        ...baseItem(api.doc.getColor(), api.doc.getPenWidth()), type: "shape", kind: api.doc.getShapeKind(),
        x, y, w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y), fillSolid: false,
      };
      drag.moved = true;
    } else if (drag.kind === "erase") {
      // Erase continuously along the sweep, not only at sampled points:
      // a fast sweep jumps 20px+ between pointermove events, and without
      // interpolation it would leave stripes of unerased ink behind.
      const step = Math.max(2, api.doc.getPenWidth() / 2);
      const d = Math.hypot(p.x - drag.last.x, p.y - drag.last.y);
      const n = Math.max(1, Math.ceil(d / step));
      for (let s = 1; s <= n; s++) {
        if (eraseAt({ x: drag.last.x + (p.x - drag.last.x) * (s / n), y: drag.last.y + (p.y - drag.last.y) * (s / n) })) drag.erased = true;
      }
      drag.last = p;
    } else if (drag.kind === "select" && drag.item) {
      const dx = p.x - drag.last.x, dy = p.y - drag.last.y;
      if (dx !== 0 || dy !== 0) drag.moved = true;
      // Move the whole selection together: one clamp for the union box,
      // so the items keep their relative positions. One undo entry per
      // drag (committed on release).
      const sel = api.doc.getSelectedItems();
      const c = clampMoveUnion(sel, dx, dy);
      for (const it of sel) moveItem(it, c.dx, c.dy);
      drag.last = p;
    } else if (drag.kind === "marquee") {
      marquee = { x0: drag.start.x, y0: drag.start.y, x1: p.x, y1: p.y };
      if (Math.abs(p.x - drag.start.x) > 4 || Math.abs(p.y - drag.start.y) > 4) drag.moved = true;
    }
  });

  canvas.addEventListener("pointerup", () => finishPointerDrag());

  canvas.addEventListener("pointercancel", () => finishPointerDrag());

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = e.deltaMode === 1 ? 16 : 1; // line mode: ~16px a line
    const pan = api.view.getPan();
    api.view.setPan(pan.x - e.deltaX * f, pan.y - e.deltaY * f);
  }, { passive: false });

  textEditor.addEventListener("blur", () => closeTextEditor(true));

  canvas.addEventListener("mousedown", (e) => {
    if (api.doc.getTool() === "text") e.preventDefault();
  });

  canvas.addEventListener("dblclick", (e) => {
    const p = stagePoint(e);
    const hit = hitTestAt(p);
    // Double-click focuses a part: it stays full opacity, everything else
    // dims to 0.1. Double-clicking the focused part again, or empty stage,
    // exits focus. The text and paint tools keep their click meanings, so
    // focus only applies with the other tools. A double-click never opens
    // the text editor — text is created only by a single click with the
    // Text tool.
    if (api.doc.getTool() === "text" || api.doc.getTool() === "paint") return;
    if (hit) {
      if (api.doc.getFocusedId() === hit.id) api.doc.setFocusedId(null);
      else api.doc.setFocusedId(hit.id);
      api.doc.setSelection([hit.id]);
      api.app.renderPanel();
      return;
    }
    if (api.doc.getFocusedId() !== null) {
      api.doc.setFocusedId(null);
      api.doc.setSelection([]);
      api.app.renderPanel();
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (api.doc.getTool() === "text") {
      if (lastPressRepeat) return; // second press of a double-click pair
      const p = stagePoint(e);
      const hit = hitTestAt(p);
      if (hit?.type === "text") { api.doc.setSelection([hit.id]); openTextEditor(hit, p); }
      else openTextEditor(null, p);
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    updateEraserRing(e.clientX, e.clientY, true);
  });

  canvas.addEventListener("pointerleave", () => {
    updateEraserRing(0, 0, false);
  });
}

// Losing the window mid-pan or mid-rotate must not leave the drag
// state stuck: the next pointerdown would inherit a stale drag.
function onBlur(): void {
  panDrag = null;
  rotateDrag = null;
  updateCursor();
}

export function activate(a: PluginContext): void {
  api = a;
  stageWrap = api.shell.stageWrap;
  stageWrap.innerHTML = "";
  canvas = document.createElement("canvas");
  canvas.id = "stage";
  stageWrap.appendChild(canvas);
  ctx = canvas.getContext("2d")!;
  textEditor = document.createElement("textarea");
  textEditor.id = "text-editor";
  textEditor.rows = 1;
  textEditor.setAttribute("aria-label", "Text");
  stageWrap.appendChild(textEditor);
  // Text measurement reads this canvas's context — the same context
  // itemBBox always read — so text widths measure exactly as before.
  setTextMeasurer((text) => ctx.measureText(text).width);
  wireListeners();
  api.events.on("tool", updateCursor);
  api.events.on("view", updateCursor);
  api.canvas.registerRenderer(renderer);
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("blur", onBlur);
  resizeCanvas();
  updateCursor();
}

export function deactivate(): void {
  api.events.off("tool", updateCursor);
  api.events.off("view", updateCursor);
  window.removeEventListener("resize", resizeCanvas);
  window.removeEventListener("blur", onBlur);
  api.canvas.registerRenderer(null);
  if (eraserRingEl) {
    eraserRingEl.remove();
    eraserRingEl = null;
  }
  drag = null;
  panDrag = null;
  rotateDrag = null;
  previewShape = null;
  marquee = null;
  textSession = null;
  stageWrap.innerHTML = "";
}

const renderer: CanvasRenderer = {
  getElement: () => canvas,
  render: (t01) => {
    renderWithPreview(t01);
  },
  renderFrame: (t01, target, dprOverride) => {
    renderFrame(t01, target, dprOverride);
  },
  renderFrameAt: (frameIndex, t01, target, dprOverride) => {
    const frame = api.doc.getTimeline().frames[frameIndex];
    if (!frame) return;
    renderFrame(t01, target, dprOverride, frame.items);
  },
  resize: () => {
    resizeCanvas();
  },
};

export const plugin: PluginModule = { manifest, activate, deactivate };

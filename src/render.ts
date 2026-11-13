// Drawing: items, frames, the stage card. All coordinates are
// stage coordinates unless stated; the caller sets the canvas transform
// (DPR) and passes the workspace layout.
import type { Document, Frame, Item, WorkspaceLayout } from "./model";
import { frameAt, stageSizeFor } from "./model";

function roundRectPath(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x, y, x + r, y, r);
  c.closePath();
}

export function drawItem(c: CanvasRenderingContext2D, it: Item, alpha = 1): void {
  c.save();
  c.globalAlpha = alpha;
  if (it.type === "stroke") {
    const pts = it.points;
    if (pts.length === 0) {
      c.restore();
      return;
    }
    c.strokeStyle = it.color;
    c.lineWidth = it.width;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      c.lineTo(pts[1].x, pts[1].y);
    } else {
      // The stored path is never interpolated; only the render smooths,
      // with the standard midpoint-quadratic technique.
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
    c.stroke();
  } else if (it.type === "shape") {
    const x = Math.min(it.x, it.x + it.w);
    const y = Math.min(it.y, it.y + it.h);
    const w = Math.abs(it.w);
    const h = Math.abs(it.h);
    c.beginPath();
    if (it.kind === "ellipse") c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else c.rect(x, y, w, h);
    if (it.fill) {
      c.fillStyle = it.color;
      c.fill();
    }
    c.strokeStyle = it.color;
    c.lineWidth = it.width;
    c.lineJoin = "round";
    c.stroke();
  } else {
    c.fillStyle = it.color;
    c.font = `${it.size}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;
    c.textBaseline = "alphabetic";
    c.fillText(it.text, it.x, it.y);
  }
  c.restore();
}

export function drawFrameItems(c: CanvasRenderingContext2D, items: Item[], alpha = 1): void {
  for (const it of items) drawItem(c, it, alpha);
}

// ---------------------------------------------------------------------------
// Stage — the workspace, the stage card, the composited layers.
// Layers[0] is the top layer; rendering runs bottom to top.
// ---------------------------------------------------------------------------

export type RenderOpts = {
  pos: number;
  currentLayerId: string;
  previewItems?: Item[];
  // Onion skin: the neighbours of the frame at pos, tinted under the
  // live frame. False (or absent) draws the frame on its own — the
  // eyedropper samples through this path, so it never reads a
  // neighbour tint.
  onionSkin?: boolean;
};

// Onion skin: previous frame red, next frame green (the classic
// before/after convention), at 30% so the live frame stays crisp on
// top. The neighbour is rendered to a stage-sized offscreen canvas
// and tinted with source-atop, so the tint is a flat silhouette —
// the neighbour's own colours never leak through. The layer's
// opacity multiplies the neighbour alpha, so a 50% layer's
// neighbours are fainter still.
const ONION_ALPHA = 0.3;
const PREV_TINT = "#ff3b30";
const NEXT_TINT = "#34c759";

let onionCanvas: HTMLCanvasElement | null = null;

function drawTintedOnion(
  c: CanvasRenderingContext2D,
  stage: { w: number; h: number },
  items: Item[],
  tint: string,
  alpha: number,
): void {
  if (!onionCanvas) onionCanvas = document.createElement("canvas");
  if (onionCanvas.width !== stage.w || onionCanvas.height !== stage.h) {
    onionCanvas.width = stage.w;
    onionCanvas.height = stage.h;
  }
  const g = onionCanvas.getContext("2d");
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, stage.w, stage.h);
  drawFrameItems(g, items, 1);
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = tint;
  g.fillRect(0, 0, stage.w, stage.h);
  g.globalCompositeOperation = "source-over";
  c.save();
  c.globalAlpha = alpha;
  c.drawImage(onionCanvas, 0, 0);
  c.restore();
}

export function renderStage(
  c: CanvasRenderingContext2D,
  layout: WorkspaceLayout,
  doc: Document,
  opts: RenderOpts,
): void {
  const stage = stageSizeFor(doc.stageId);
  c.clearRect(0, 0, layout.cw, layout.ch);
  c.fillStyle = "#f5f5f7";
  c.fillRect(0, 0, layout.cw, layout.ch);
  c.save();
  // Rotation is around the workspace centre; the workspace background
  // stays put and only the stage card turns.
  c.translate(layout.cw / 2, layout.ch / 2);
  c.rotate(layout.r);
  c.translate(-layout.cw / 2, -layout.ch / 2);
  c.save();
  c.shadowColor = "rgba(0, 0, 0, 0.12)";
  c.shadowBlur = 16;
  c.shadowOffsetY = 2;
  roundRectPath(c, layout.ox, layout.oy, stage.w * layout.s, stage.h * layout.s, 4);
  c.fillStyle = "#ffffff";
  c.fill();
  c.restore();
  c.save();
  roundRectPath(c, layout.ox, layout.oy, stage.w * layout.s, stage.h * layout.s, 4);
  c.clip();
  c.fillStyle = doc.stageBg;
  c.fillRect(layout.ox, layout.oy, stage.w * layout.s, stage.h * layout.s);
  c.restore();
  // Items are NOT clipped to the card: drawings outside the stage show on
  // the pasteboard around it.
  c.save();
  c.translate(layout.ox, layout.oy);
  c.scale(layout.s, layout.s);
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const layer = doc.layers[li];
    if (!layer.visible) continue;
    const { frame, index } = frameAt(layer, opts.pos);
    const layerAlpha = (layer.opacity ?? 100) / 100;
    // Onion skin draws UNDER the live frame, per layer — and only
    // when that layer's own toggle is on: the previous frame red,
    // the next frame green. A layer with no neighbour on a side
    // shows only the existing one (first frame: next only; last
    // frame: previous only). Hidden layers contribute no neighbours.
    if (opts.onionSkin && layer.onionSkin !== false) {
      if (index > 0) {
        drawTintedOnion(c, stage, layer.frames[index - 1].items, PREV_TINT, ONION_ALPHA * layerAlpha);
      }
      if (index < layer.frames.length - 1) {
        drawTintedOnion(c, stage, layer.frames[index + 1].items, NEXT_TINT, ONION_ALPHA * layerAlpha);
      }
    }
    // A layer draws at its own opacity, so lower layers show through.
    // The opacity is the draw alpha: drawItem resets globalAlpha per
    // item, so setting it on the context here would be overwritten.
    drawFrameItems(c, frame.items, layerAlpha);
  }
  // The live preview belongs to the current layer, so it draws at that
  // layer's opacity too.
  if (opts.previewItems) {
    const cur = doc.layers.find((l) => l.id === opts.currentLayerId);
    drawFrameItems(c, opts.previewItems, (cur?.opacity ?? 100) / 100);
  }
  c.restore();
  c.restore();
}

// ---------------------------------------------------------------------------
// Thumbnails — one small canvas per frame cell, drawn on demand.
// ---------------------------------------------------------------------------

export function renderThumbnail(canvas: HTMLCanvasElement, frame: Frame, stage: { w: number; h: number }, opacity = 1): void {
  // 92px wide, so 92×52 at the stage's 16:9 — it fills the 96×54
  // cell (1px inset each side, inside the cell's 1px border) with no
  // letterbox space and no distortion.
  const w = 92;
  const h = Math.max(24, Math.round((92 * stage.h) / stage.w));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, w, h);
  c.save();
  c.scale(w / stage.w, h / stage.h);
  // The thumbnail is drawn at the layer's opacity, like the stage, so
  // the preview is truthful about what the frame looks like.
  drawFrameItems(c, frame.items, opacity);
  c.restore();
}

// Drawing: items, frames, the stage card, onion skin. All coordinates are
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
  onion: boolean;
  previewItems?: Item[];
};

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
  c.translate(layout.ox, layout.oy);
  c.scale(layout.s, layout.s);
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const layer = doc.layers[li];
    if (!layer.visible) continue;
    const { frame, index } = frameAt(layer, opts.pos);
    if (layer.id === opts.currentLayerId && opts.onion) {
      // Adjacent frames ghost under the displayed one, display only.
      const prev = layer.frames[index - 1];
      const next = layer.frames[index + 1];
      if (prev) drawFrameItems(c, prev.items, 0.3);
      if (next) drawFrameItems(c, next.items, 0.15);
    }
    drawFrameItems(c, frame.items);
  }
  if (opts.previewItems) drawFrameItems(c, opts.previewItems);
  c.restore();
  c.restore();
}

// ---------------------------------------------------------------------------
// Thumbnails — one small canvas per frame cell, drawn on demand.
// ---------------------------------------------------------------------------

export function renderThumbnail(canvas: HTMLCanvasElement, frame: Frame, stage: { w: number; h: number }): void {
  const w = 64;
  const h = Math.max(24, Math.round((64 * stage.h) / stage.w));
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
  drawFrameItems(c, frame.items);
  c.restore();
}

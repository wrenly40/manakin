// Toolbar — the floating tool palette (Manakin Plugin API v1).
//
// Owns the floating toolbar: the six tools, the brush-size preview
// and input, and the front/back colour swatches with their swap
// button. Clicking a tool sets it through api.doc (which emits
// "tool", so this plugin re-renders and the canvas updates its
// cursor); clicking a swatch asks the core for the colour panel
// through api.ui.openColour — the panel itself is still core-owned.
// The toolbar re-renders on the "tool" and "pen" events, never on a
// direct call from elsewhere.

import type { PluginContext, PluginModule } from "../plugins";
import type { ToolId } from "../model";

export const manifest = {
  id: "core-toolbar",
  name: "Toolbar",
  version: "1.0.0",
  apiVersion: "1",
  description: "The floating toolbar: tools, brush size, front/back colours.",
  permissions: ["doc", "shell", "events", "ui"],
};

let api!: PluginContext;
let toolbar!: HTMLElement;

const TOOLS: { id: ToolId; label: string; key: string; svg: string }[] = [
  { id: "select", label: "Select", key: "V", svg: "<path d=\"M5 3l14 7-6 2-3 6z\"/>" },
  { id: "brush", label: "Brush", key: "P", svg: "<path d=\"M4 20l1-4L16 5l3 3L8 19z\"/><path d=\"M13 8l3 3\"/>" },
  // Eraser is D, not E: E is Geometry (and toggles rect/ellipse on a
  // second press), so the nearest free key to it is the one below it.
  { id: "eraser", label: "Eraser", key: "D", svg: "<path d=\"m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21\"/><path d=\"M22 21H7\"/><path d=\"m5 11 9 9\"/>" },
  { id: "shape", label: "Geometry", key: "E", svg: "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/>" },
  { id: "text", label: "Text", key: "T", svg: "<path d=\"M5 6h14M12 6v13\"/>" },
  // Paint bucket: the Lucide paint-bucket icon (user's pick from
  // three candidates), rendered at 1.8 stroke like the other tools.
  { id: "paint", label: "Paint", key: "B", svg: "<path d=\"m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z\"/><path d=\"m5 2 5 5\"/><path d=\"M2 13h15\"/><path d=\"M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z\"/>" },
];

function clampSize(n: number): number {
  return Math.max(2, Math.min(32, Math.round(n)));
}
function renderToolbar(): void {
  toolbar.innerHTML = "";
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.className = "tool" + (api.doc.getTool() === t.id ? " active" : "");
    b.title = t.key ? `${t.label} (${t.key})` : t.label;
    b.setAttribute("aria-label", t.label);
    b.innerHTML = `<svg viewBox="0 0 24 24">${t.svg}</svg>`;
    b.addEventListener("click", () => { api.doc.setTool(t.id); });
    toolbar.appendChild(b);
  }
  toolbar.appendChild(document.createElement("hr"));
  // Brush size: no slider. A size preview circle (drag it to resize)
  // with a text input below to type the size, kept in sync both ways.
  const sizeWrap = document.createElement("div");
  sizeWrap.className = "size-wrap";
  const preview = document.createElement("div");
  preview.className = "brush-preview";
  preview.title = "Brush size — drag to resize";
  preview.setAttribute("aria-label", "Brush size preview, drag to resize");
  const dot = document.createElement("span");
  dot.className = "brush-dot";
  const paintPreview = (): void => {
    dot.style.width = `${api.doc.getPenWidth()}px`;
    dot.style.height = `${api.doc.getPenWidth()}px`;
  };
  paintPreview();
  let dragStartX = 0;
  let dragStartSize = api.doc.getPenWidth();
  preview.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartSize = api.doc.getPenWidth();
    try { preview.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const onMove = (ev: PointerEvent): void => {
      api.doc.setPenWidth(clampSize(dragStartSize + (ev.clientX - dragStartX) / 3));
      paintPreview();
      sizeInput.value = String(api.doc.getPenWidth());
    };
    const onUp = (): void => {
      preview.removeEventListener("pointermove", onMove);
      preview.removeEventListener("pointerup", onUp);
      preview.removeEventListener("pointercancel", onUp);
      api.doc.save();
    };
    preview.addEventListener("pointermove", onMove);
    preview.addEventListener("pointerup", onUp);
    preview.addEventListener("pointercancel", onUp);
  });
  preview.appendChild(dot);
  const sizeInput = document.createElement("input");
  sizeInput.className = "brush-size-input";
  sizeInput.type = "text";
  sizeInput.inputMode = "numeric";
  sizeInput.value = String(api.doc.getPenWidth());
  sizeInput.setAttribute("aria-label", "Brush size in pixels");
  const commitSize = (): void => {
    const n = parseInt(sizeInput.value, 10);
    api.doc.setPenWidth(Number.isFinite(n) ? clampSize(n) : api.doc.getPenWidth());
    sizeInput.value = String(api.doc.getPenWidth());
    paintPreview();
    api.doc.save();
  };
  sizeInput.addEventListener("change", commitSize);
  sizeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitSize(); sizeInput.blur(); }
    e.stopPropagation();
  });
  sizeInput.addEventListener("blur", commitSize);
  sizeWrap.appendChild(preview);
  sizeWrap.appendChild(sizeInput);
  toolbar.appendChild(sizeWrap);
  toolbar.appendChild(document.createElement("hr"));
  // Double swatches: front = foreground, back = background.
  // Clicking one opens the Colour panel for that slot.
  const dbl = document.createElement("div");
  dbl.className = "double-swatches";
  const pair = document.createElement("div");
  pair.className = "pair";
  const back = document.createElement("button");
  back.className = "dswatch back" + (api.doc.getActiveSlot() === "bg" ? " active" : "");
  back.style.background = api.doc.getBgColor();
  back.title = "Back colour";
  back.setAttribute("aria-label", "Back colour");
  back.addEventListener("click", () => api.ui.openColour("bg"));
  const front = document.createElement("button");
  front.className = "dswatch front" + (api.doc.getActiveSlot() === "fg" ? " active" : "");
  front.style.background = api.doc.getColor();
  front.title = "Front colour";
  front.setAttribute("aria-label", "Front colour");
  front.addEventListener("click", () => api.ui.openColour("fg"));
  const swap = document.createElement("button");
  swap.className = "swap-btn";
  swap.title = "Swap colours (X)";
  swap.setAttribute("aria-label", "Swap colours");
  swap.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M7 8h11l-3-3M17 16H6l3 3\"/></svg>";
  swap.addEventListener("click", () => api.doc.swapColors());
  pair.appendChild(back);
  pair.appendChild(front);
  dbl.appendChild(pair);
  dbl.appendChild(swap);
  toolbar.appendChild(dbl);
}
export function activate(a: PluginContext): void {
  api = a;
  toolbar = api.shell.toolbar;
  renderToolbar();
  api.events.on("tool", renderToolbar);
  api.events.on("pen", renderToolbar);
}

export function deactivate(): void {
  api.events.off("tool", renderToolbar);
  api.events.off("pen", renderToolbar);
  toolbar.innerHTML = "";
}

export const plugin: PluginModule = { manifest, activate, deactivate };

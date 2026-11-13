// Toolbar: the floating frosted pill (Bowerbird's shape), the tools, the
// brush size, the colours and the colour panel flyout.
import { PALETTE, hexToHsv, hsvToHex, normHex } from "./model";
import type { Store, ToolId } from "./store";

const ICONS: Record<string, string> = {
  select: `<svg viewBox="0 0 24 24"><path d="m4 4 7.07 16.97 2.51-7.39 7.39-2.51L4 4z"/><path d="m13 13 6 6"/></svg>`,
  pen: `<svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  eraser: `<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
  rect: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
  ellipse: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>`,
  text: `<svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  paint: `<svg viewBox="0 0 24 24"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z"/></svg>`,
};

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: "select", label: "Select (V)", key: "v" },
  { id: "pen", label: "Pen (P)", key: "p" },
  { id: "eraser", label: "Eraser (D)", key: "d" },
  { id: "shape", label: "Geometry (E)", key: "e" },
  { id: "text", label: "Text (T)", key: "t" },
  { id: "paint", label: "Paint bucket (B)", key: "b" },
];

const COLOURS_KEY = "manakin-v2-colours";

type SavedColours = { recent: string[]; saved: string[] };

function loadColours(): SavedColours {
  try {
    const raw = JSON.parse(localStorage.getItem(COLOURS_KEY) ?? "null") as SavedColours | null;
    if (raw && Array.isArray(raw.recent) && Array.isArray(raw.saved)) return raw;
  } catch {
    // Bad save — start fresh.
  }
  return { recent: [], saved: [] };
}

export function createToolbar(wrapEl: HTMLElement, store: Store): void {
  const colours = loadColours();
  const saveColours = (): void => {
    try {
      localStorage.setItem(COLOURS_KEY, JSON.stringify(colours));
    } catch {
      // Storage unavailable — the session keeps working.
    }
  };

  const bar = document.createElement("div");
  bar.id = "toolbar";
  wrapEl.appendChild(bar);

  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = document.createElement("button");
    b.className = "tbtn";
    b.title = t.label;
    b.setAttribute("aria-label", t.label);
    b.innerHTML = t.id === "shape" ? ICONS.rect : ICONS[t.id];
    b.addEventListener("click", () => {
      if (t.id === "shape" && store.tool === "shape") {
        store.setShapeKind(store.shapeKind === "rect" ? "ellipse" : "rect");
      } else {
        store.setTool(t.id);
      }
    });
    bar.appendChild(b);
    toolButtons.set(t.id, b);
  }

  const div = document.createElement("div");
  div.className = "tdiv";
  bar.appendChild(div);

  // Brush size: a draggable preview circle plus a typed input.
  const sizeWrap = document.createElement("div");
  sizeWrap.className = "size-wrap";
  const preview = document.createElement("div");
  preview.className = "size-preview";
  preview.title = "Brush size — drag up or down";
  sizeWrap.appendChild(preview);
  const sizeInput = document.createElement("input");
  sizeInput.className = "size-input";
  sizeInput.type = "number";
  sizeInput.min = "1";
  sizeInput.max = "64";
  sizeInput.title = "Brush size";
  sizeInput.setAttribute("aria-label", "Brush size");
  sizeInput.addEventListener("change", () => {
    const n = parseInt(sizeInput.value, 10);
    if (Number.isFinite(n)) store.setBrushSize(n);
  });
  sizeWrap.appendChild(sizeInput);
  bar.appendChild(sizeWrap);

  let dragStartY = 0;
  let dragStartSize = 0;
  preview.addEventListener("pointerdown", (e) => {
    dragStartY = e.clientY;
    dragStartSize = store.brushSize;
    preview.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      store.setBrushSize(dragStartSize + Math.round((dragStartY - ev.clientY) / 4));
    };
    const up = (): void => {
      preview.removeEventListener("pointermove", move);
      preview.removeEventListener("pointerup", up);
    };
    preview.addEventListener("pointermove", move);
    preview.addEventListener("pointerup", up);
  });

  const div2 = document.createElement("div");
  div2.className = "tdiv";
  bar.appendChild(div2);

  // Colours: primary + secondary, then the palette row.
  const swatchWrap = document.createElement("div");
  swatchWrap.className = "swatch-wrap";
  const primary = document.createElement("button");
  primary.className = "swatch primary";
  primary.title = "Colour — click for the colour panel";
  primary.setAttribute("aria-label", "Colour");
  primary.addEventListener("click", () => {
    panel.style.display = panel.style.display === "block" ? "none" : "block";
  });
  const secondary = document.createElement("button");
  secondary.className = "swatch secondary";
  secondary.title = "Swap colours (X)";
  secondary.setAttribute("aria-label", "Swap colours");
  secondary.addEventListener("click", () => store.swapColors());
  swatchWrap.appendChild(secondary);
  swatchWrap.appendChild(primary);
  bar.appendChild(swatchWrap);

  const paletteRow = document.createElement("div");
  paletteRow.className = "palette-row";
  for (const c of PALETTE) {
    const b = document.createElement("button");
    b.className = "palette-dot";
    b.style.background = c;
    b.title = c;
    b.setAttribute("aria-label", `Colour ${c}`);
    b.addEventListener("click", () => {
      store.setColor(c);
      noteRecent(c);
    });
    paletteRow.appendChild(b);
  }
  bar.appendChild(paletteRow);

  // ---- Colour panel ----------------------------------------------------------
  // Hue bar style: a square colour field with a horizontal hue bar under it,
  // then hex, recent and saved colours.
  const panel = document.createElement("div");
  panel.id = "colour-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <canvas id="sv-field" width="180" height="140"></canvas>
    <input id="hue-bar" type="range" min="0" max="360" step="1" aria-label="Hue" />
    <div class="colour-row">
      <input id="hex-input" type="text" spellcheck="false" aria-label="Hex colour" />
      <button id="save-colour">Save</button>
    </div>
    <div class="colour-label">Recent</div>
    <div id="recent-row" class="colour-row"></div>
    <div class="colour-label">Saved</div>
    <div id="saved-row" class="colour-row"></div>`;
  wrapEl.appendChild(panel);

  const sv = panel.querySelector("#sv-field") as HTMLCanvasElement;
  const svCtx = sv.getContext("2d") as CanvasRenderingContext2D;
  const hueBar = panel.querySelector("#hue-bar") as HTMLInputElement;
  const hexInput = panel.querySelector("#hex-input") as HTMLInputElement;
  const saveBtn = panel.querySelector("#save-colour") as HTMLButtonElement;
  const recentRow = panel.querySelector("#recent-row") as HTMLDivElement;
  const savedRow = panel.querySelector("#saved-row") as HTMLDivElement;

  let hue = 0;
  let sat = 1;
  let val = 1;

  function drawSv(): void {
    const gradH = svCtx.createLinearGradient(0, 0, 180, 0);
    gradH.addColorStop(0, "#ffffff");
    gradH.addColorStop(1, hsvToHex(hue, 1, 1));
    svCtx.fillStyle = gradH;
    svCtx.fillRect(0, 0, 180, 140);
    const gradV = svCtx.createLinearGradient(0, 0, 0, 140);
    gradV.addColorStop(0, "rgba(0, 0, 0, 0)");
    gradV.addColorStop(1, "rgba(0, 0, 0, 1)");
    svCtx.fillStyle = gradV;
    svCtx.fillRect(0, 0, 180, 140);
    svCtx.strokeStyle = "#ffffff";
    svCtx.lineWidth = 2;
    svCtx.beginPath();
    svCtx.arc(sat * 180, (1 - val) * 140, 6, 0, Math.PI * 2);
    svCtx.stroke();
  }

  function applyColour(fromPanel: boolean): void {
    const hex = hsvToHex(hue, sat, val);
    store.setColor(hex);
    hexInput.value = hex;
    drawSv();
    if (fromPanel) noteRecent(hex);
  }

  function noteRecent(hex: string): void {
    colours.recent = [hex, ...colours.recent.filter((c) => c !== hex)].slice(0, 8);
    saveColours();
    renderRows();
  }

  function renderRows(): void {
    const fillRow = (row: HTMLDivElement, list: string[]): void => {
      row.innerHTML = "";
      for (const c of list) {
        const b = document.createElement("button");
        b.className = "palette-dot";
        b.style.background = c;
        b.title = c;
        b.addEventListener("click", () => {
          store.setColor(c);
          const hsv = hexToHsv(c);
          if (hsv) {
            hue = hsv.h;
            sat = hsv.s;
            val = hsv.v;
            hexInput.value = c;
            drawSv();
          }
        });
        row.appendChild(b);
      }
    };
    fillRow(recentRow, colours.recent);
    fillRow(savedRow, colours.saved);
  }

  let svDrag = false;
  const svFromEvent = (e: PointerEvent): void => {
    const rect = sv.getBoundingClientRect();
    sat = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    val = 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    applyColour(true);
  };
  sv.addEventListener("pointerdown", (e) => {
    svDrag = true;
    sv.setPointerCapture(e.pointerId);
    svFromEvent(e);
  });
  sv.addEventListener("pointermove", (e) => {
    if (svDrag) svFromEvent(e);
  });
  sv.addEventListener("pointerup", () => {
    svDrag = false;
  });
  hueBar.addEventListener("input", () => {
    hue = parseInt(hueBar.value, 10);
    applyColour(true);
  });
  hexInput.addEventListener("change", () => {
    const n = normHex(hexInput.value);
    if (!n) {
      hexInput.value = store.color;
      return;
    }
    const hsv = hexToHsv(n);
    if (hsv) {
      hue = hsv.h;
      sat = hsv.s;
      val = hsv.v;
    }
    store.setColor(n);
    noteRecent(n);
    drawSv();
  });
  saveBtn.addEventListener("click", () => {
    const hex = store.color;
    if (!colours.saved.includes(hex)) {
      colours.saved.push(hex);
      saveColours();
      renderRows();
    }
  });

  // Clicking outside the panel or the primary swatch closes it.
  document.addEventListener("pointerdown", (e) => {
    if (panel.style.display !== "block") return;
    const t = e.target as Node | null;
    if (t && !panel.contains(t) && t !== primary) panel.style.display = "none";
  });

  function sync(): void {
    for (const [id, b] of toolButtons) {
      b.classList.toggle("active", store.tool === id);
    }
    const shapeBtn = toolButtons.get("shape");
    if (shapeBtn) shapeBtn.innerHTML = store.shapeKind === "rect" ? ICONS.rect : ICONS.ellipse;
    const d = Math.max(4, store.brushSize * 1.5);
    preview.style.width = `${d}px`;
    preview.style.height = `${d}px`;
    sizeInput.value = String(store.brushSize);
    primary.style.background = store.color;
    secondary.style.background = store.color2;
    const hsv = hexToHsv(store.color);
    if (hsv && document.activeElement !== hexInput) {
      hue = hsv.h;
      sat = hsv.s;
      val = hsv.v;
      hueBar.value = String(Math.round(hue));
      hexInput.value = store.color;
      drawSv();
    }
  }

  store.onChange(sync);
  renderRows();
  sync();
}

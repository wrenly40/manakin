// Toolbar: the floating frosted pill (Bowerbird's shape), the tools, the
// brush size, the colours and the colour panel flyout.
import { hexToHsv, hsvToHex, normHex } from "./model";
import type { Store, ToolId } from "./store";

const ICONS: Record<string, string> = {
  select: `<svg viewBox="0 0 24 24"><path d="M5 3l14 7-6 2-3 6z"/></svg>`,
  pen: `<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M13 8l3 3"/></svg>`,
  eraser: `<svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`,
  rect: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`,
  text: `<svg viewBox="0 0 24 24"><path d="M5 6h14M12 6v13"/></svg>`,
  paint: `<svg viewBox="0 0 24 24"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z"/></svg>`,
  // The eyedropper glyph lives here even though the tool has no
  // toolbar button any more — the colour panel's pick button reuses it.
  eyedropper: `<svg viewBox="0 0 24 24"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>`,
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
    b.className = "tool";
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

  // Brush size: no slider. A size preview dot (drag it to resize)
  // with a text input below to type the size, kept in sync both ways.
  const sizeWrap = document.createElement("div");
  sizeWrap.className = "size-wrap";
  const preview = document.createElement("div");
  preview.className = "brush-preview";
  preview.title = "Brush size — drag to resize";
  preview.setAttribute("aria-label", "Brush size preview, drag to resize");
  const dot = document.createElement("span");
  dot.className = "brush-dot";
  preview.appendChild(dot);
  const paintPreview = (): void => {
    dot.style.width = `${store.brushSize}px`;
    dot.style.height = `${store.brushSize}px`;
  };
  paintPreview();
  sizeWrap.appendChild(preview);
  const sizeInput = document.createElement("input");
  sizeInput.className = "brush-size-input";
  sizeInput.type = "text";
  sizeInput.inputMode = "numeric";
  sizeInput.value = String(store.brushSize);
  sizeInput.title = "Brush size";
  sizeInput.setAttribute("aria-label", "Brush size in pixels");
  const commitSize = (): void => {
    const n = parseInt(sizeInput.value, 10);
    if (Number.isFinite(n)) store.setBrushSize(n);
    sizeInput.value = String(store.brushSize);
    paintPreview();
  };
  sizeInput.addEventListener("change", commitSize);
  sizeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitSize();
      sizeInput.blur();
    }
    e.stopPropagation();
  });
  sizeInput.addEventListener("blur", commitSize);
  sizeWrap.appendChild(sizeInput);
  bar.appendChild(sizeWrap);

  let dragStartX = 0;
  let dragStartSize = 0;
  preview.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragStartX = e.clientX;
    dragStartSize = store.brushSize;
    preview.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      store.setBrushSize(dragStartSize + Math.round((ev.clientX - dragStartX) / 3));
      paintPreview();
    };
    const up = (): void => {
      preview.removeEventListener("pointermove", move);
      preview.removeEventListener("pointerup", up);
      preview.removeEventListener("pointercancel", up);
    };
    preview.addEventListener("pointermove", move);
    preview.addEventListener("pointerup", up);
    preview.addEventListener("pointercancel", up);
  });

  const div2 = document.createElement("div");
  div2.className = "tdiv";
  bar.appendChild(div2);

  // Double swatches: front = foreground, back = background. Clicking
  // one opens the Colour panel for that slot; clicking the open swatch
  // again closes it.
  let panelSlot: "fg" | "bg" = "fg";
  function slotColor(): string {
    return panelSlot === "fg" ? store.color : store.color2;
  }
  function setSlotColor(hex: string): void {
    if (panelSlot === "fg") store.setColor(hex);
    else store.setColor2(hex);
  }
  function openColourSlot(slot: "fg" | "bg"): void {
    if (panel.style.display === "block" && panelSlot === slot) {
      panel.style.display = "none";
      return;
    }
    panelSlot = slot;
    panel.style.display = "block";
  }
  const dbl = document.createElement("div");
  dbl.className = "double-swatches";
  const pair = document.createElement("div");
  pair.className = "pair";
  const back = document.createElement("button");
  back.className = "dswatch back";
  back.title = "Back colour";
  back.setAttribute("aria-label", "Back colour");
  back.addEventListener("click", () => openColourSlot("bg"));
  const front = document.createElement("button");
  front.className = "dswatch front";
  front.title = "Front colour";
  front.setAttribute("aria-label", "Front colour");
  front.addEventListener("click", () => openColourSlot("fg"));
  const swap = document.createElement("button");
  swap.className = "swap-btn";
  swap.title = "Swap colours (X)";
  swap.setAttribute("aria-label", "Swap colours");
  swap.innerHTML = `<svg viewBox="0 0 24 24"><path d="M7 8h11l-3-3M17 16H6l3 3"/></svg>`;
  swap.addEventListener("click", () => store.swapColors());
  pair.appendChild(back);
  pair.appendChild(front);
  dbl.appendChild(pair);
  dbl.appendChild(swap);
  bar.appendChild(dbl);

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
      <button id="pick-colour" title="Eyedropper (I)" aria-label="Eyedropper">${ICONS.eyedropper}</button>
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
  const pickBtn = panel.querySelector("#pick-colour") as HTMLButtonElement;
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
    setSlotColor(hex);
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
          setSlotColor(c);
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
    setSlotColor(n);
    noteRecent(n);
    drawSv();
  });
  saveBtn.addEventListener("click", () => {
    const hex = slotColor();
    if (!colours.saved.includes(hex)) {
      colours.saved.push(hex);
      saveColours();
      renderRows();
    }
  });

  // The eyedropper lives in the colour panel, not the toolbar: it
  // picks a colour for the panel's current slot (fg or bg). Clicking
  // it closes the panel and arms the one-shot tool; the pick is
  // applied to the slot on the next change, the tool returns to the
  // previous one, and the panel does not reopen. The I shortcut
  // arms the same tool — a keyboard shortcut is not a second
  // visible control.
  pickBtn.addEventListener("click", () => {
    panel.style.display = "none";
    store.setTool("eyedropper");
  });

  // Clicking outside the panel or the swatches closes it.
  document.addEventListener("pointerdown", (e) => {
    if (panel.style.display !== "block") return;
    const t = e.target as Node | null;
    if (t && !panel.contains(t) && !dbl.contains(t)) panel.style.display = "none";
  });

  function sync(): void {
    // An eyedropper pick lands here: the canvas only recorded the
    // sampled hex on the store, and the colour UI applies it to the
    // panel's current slot (fg or bg — whichever swatch opened the
    // panel) and notes it in Recent, like any colour chosen through
    // the colour UI. Cleared before applying, so the re-entrant
    // sync from setSlotColor sees nothing left to consume.
    if (store.pickedColor) {
      const hex = store.pickedColor;
      store.pickedColor = null;
      setSlotColor(hex);
      noteRecent(hex);
    }
    for (const [id, b] of toolButtons) {
      b.classList.toggle("active", store.tool === id);
    }
    paintPreview();
    if (document.activeElement !== sizeInput) sizeInput.value = String(store.brushSize);
    front.style.background = store.color;
    back.style.background = store.color2;
    const panelOpen = panel.style.display === "block";
    front.classList.toggle("active", panelOpen && panelSlot === "fg");
    back.classList.toggle("active", panelOpen && panelSlot === "bg");
    const hsv = hexToHsv(slotColor());
    if (hsv && document.activeElement !== hexInput) {
      hue = hsv.h;
      sat = hsv.s;
      val = hsv.v;
      hueBar.value = String(Math.round(hue));
      hexInput.value = slotColor();
      drawSv();
    }
  }

  store.onChange(sync);
  renderRows();
  sync();
}

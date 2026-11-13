// Timeline: the layers list and the frame cells. Layers[0] is the top
// layer. A cell is a thumbnail of its frame; clicking a cell edits it.
import { STAGES, frameAt } from "./model";
import type { Frame } from "./model";
import { renderThumbnail } from "./render";
import type { Store } from "./store";

export function createTimeline(panelEl: HTMLElement, store: Store): void {
  panelEl.innerHTML = `
    <div id="timeline-body">
      <div id="layer-col">
        <div id="layer-list"></div>
        <button id="add-layer" class="pbtn" title="Add layer"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Layer</span></button>
      </div>
      <div id="frames-scroll"><div id="frames-rows"></div></div>
    </div>`;

  const layerList = panelEl.querySelector("#layer-list") as HTMLDivElement;
  const framesRows = panelEl.querySelector("#frames-rows") as HTMLDivElement;
  const addLayerBtn = panelEl.querySelector("#add-layer") as HTMLButtonElement;

  addLayerBtn.addEventListener("click", () => store.addLayer());

  let lastStructural = "";
  // A hold drag in progress: the frame being dragged. While it is
  // set, sync updates the gap in place instead of rebuilding — a
  // rebuild would destroy the handle mid-drag (pointer capture lost).
  let holdDrag: { frameId: string } | null = null;
  // The frame pitch: a 66px cell plus the 6px between cells. A hold
  // gap is (hold − 1) pitches plus the 6px inter-cell space, so the
  // line spans exactly from one cell's right edge to the next cell's
  // left edge.
  const PITCH = 72;
  const gapWidth = (hold: number): number => (hold > 1 ? (hold - 1) * PITCH + 6 : 6);
  const thumbSigs = new Map<string, string>();

  function structuralSig(): string {
    return store.doc.layers
      .map((l) => `${l.id}:${l.name}:${l.visible ? 1 : 0}:${l.frames.map((f) => `${f.id}x${f.hold}`).join(",")}`)
      .join("|");
  }

  // The thumbnail signature is the frame's full content — every item's
  // geometry, colour and size — plus the layer's visibility. The old
  // signature only listed item ids and types, so moving a stroke,
  // resizing a shape, editing text, or undoing a change left the
  // thumbnail stale: the signature never changed, so it never redrew.
  function thumbSig(frame: Frame, visible: boolean): string {
    return `${visible ? 1 : 0}:${JSON.stringify(frame.items)}`;
  }

  function rebuild(): void {
    layerList.innerHTML = "";
    framesRows.innerHTML = "";
    thumbSigs.clear();
    for (const layer of store.doc.layers) {
      // ---- Layer row: an old .blayer card. ----
      const row = document.createElement("div");
      row.className = "layer-row" + (layer.visible ? "" : " hidden");
      row.dataset.layerId = layer.id;
      // Visibility is the old pill toggle, not an eye icon.
      const eye = document.createElement("button");
      eye.className = "layer-toggle" + (layer.visible ? " on" : "");
      eye.title = layer.visible ? "Hide layer" : "Show layer";
      eye.setAttribute("aria-label", layer.visible ? "Hide layer" : "Show layer");
      eye.innerHTML = `<span class="knob"></span>`;
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        store.toggleLayerVisible(layer.id);
      });
      row.appendChild(eye);
      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = layer.name;
      name.title = "Double-click to rename";
      name.addEventListener("dblclick", () => {
        const input = document.createElement("input");
        input.className = "layer-rename";
        input.value = layer.name;
        input.setAttribute("aria-label", "Layer name");
        name.replaceWith(input);
        input.focus();
        input.select();
        const commit = (): void => {
          store.renameLayer(layer.id, input.value);
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") input.blur();
          if (e.key === "Escape") {
            input.value = layer.name;
            input.blur();
          }
          e.stopPropagation();
        });
      });
      row.appendChild(name);
      const up = document.createElement("button");
      up.className = "layer-chev";
      up.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>`;
      up.title = "Move layer up";
      up.addEventListener("click", (e) => {
        e.stopPropagation();
        store.moveLayer(layer.id, -1);
      });
      const down = document.createElement("button");
      down.className = "layer-chev";
      down.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 10l6 6 6-6"/></svg>`;
      down.title = "Move layer down";
      down.addEventListener("click", (e) => {
        e.stopPropagation();
        store.moveLayer(layer.id, 1);
      });
      const del = document.createElement("button");
      del.className = "layer-remove";
      del.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
      del.title = "Delete layer";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        store.deleteLayer(layer.id);
      });
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(del);
      row.addEventListener("click", () => store.setCurrentLayer(layer.id));
      layerList.appendChild(row);

      // ---- Frame row ----
      const frow = document.createElement("div");
      frow.className = "frame-row";
      frow.dataset.layerId = layer.id;
      layer.frames.forEach((frame, index) => {
        // A cell is a div, not a button, so it can hold its own delete
        // button — a button inside a button is invalid HTML.
        const cell = document.createElement("div");
        cell.className = "frame-cell";
        cell.dataset.frameId = frame.id;
        // Every cell is the same size — the hold is shown by the line
        // in the gap after the cell, not by the cell's width.
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.title = `Frame ${index + 1}`;
        const thumb = document.createElement("canvas");
        cell.appendChild(thumb);
        // Delete is the layer row's hover-revealed ×, same size and
        // treatment. A layer keeps at least one frame, so the × only
        // appears when the layer has more than one.
        if (layer.frames.length > 1) {
          const del = document.createElement("button");
          del.className = "frame-remove";
          del.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
          del.title = "Delete frame";
          del.setAttribute("aria-label", "Delete frame");
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            store.deleteFrame(layer.id, index);
          });
          cell.appendChild(del);
        }
        cell.addEventListener("click", () => store.setCurrentFrame(layer.id, index));
        cell.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            store.setCurrentFrame(layer.id, index);
          }
        });
        frow.appendChild(cell);
        // The gap after the cell: 6px of plain space for a hold-1
        // frame, or (hold − 1) cell-widths holding a thin line for a
        // held frame — the line runs from this cell's right edge to
        // the next cell's left edge, showing the frame is held until
        // the next one. The last frame's gap extends the same
        // distance into empty space.
        const gap = document.createElement("div");
        gap.className = "hold-gap";
        gap.dataset.frameId = frame.id;
        gap.style.width = `${gapWidth(frame.hold)}px`;
        if (frame.hold > 1) {
          const line = document.createElement("div");
          line.className = "hold-line";
          gap.appendChild(line);
        }
        // Double-clicking the hold line splits the frame at the
        // clicked tick: the original keeps the hold up to the click,
        // a new EMPTY frame takes the rest. The tick comes from the
        // click's x within the gap — one 72px pitch per tick, the
        // cell itself being tick 0, so the first 72px of the gap is
        // tick 1. The trailing 6px of inter-cell space maps to the
        // last tick. A hold-1 frame has no line, so there is nothing
        // to double-click there; the handle is excluded (below) — it
        // is for dragging, and a double-click on it must not split.
        gap.addEventListener("dblclick", (e) => {
          if (frame.hold <= 1) return;
          const rect = gap.getBoundingClientRect();
          const at = Math.min(frame.hold - 1, Math.max(1, Math.floor((e.clientX - rect.left) / PITCH) + 1));
          store.splitFrame(layer.id, index, at);
        });
        // The hold handle: a vertical solid-ink bar on the hold
        // line, OUTSIDE the cell. It sits at the gap's right end —
        // the hold's endpoint — centred on the line, its visible box
        // entirely outside the cell's border, so the cell interior
        // is back to just the thumbnail and the hover-revealed ×.
        // The bar spans the FULL HEIGHT of the frame cell (38px:
        // 36px thumbnail + 2px border). It is 4px wide: in the 6px
        // gap of a hold-1 frame it sits at the gap's right end with
        // a 2px sliver of line between it and the cell. Solid ink,
        // no border, no shadow — direction A, picked by the user.
        // It has the form of the frame's right side: flat on the
        // left, right corners rounded at the cell's 9px radius
        // language (clamped to the bar's 4px width), so it reads as
        // the frame's own right edge, pulled out to the hold's
        // endpoint. Visible only while its cell (or the gap) is
        // hovered, or while dragging — nothing shows at rest.
        // Dragging it sets the hold — the only hold control. It is
        // its own pointer interaction and never selects the cell.
        const handle = document.createElement("div");
        handle.className = "frame-handle";
        handle.title = "Drag to change hold";
        handle.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          handle.setPointerCapture(e.pointerId);
          handle.classList.add("dragging");
          const startX = e.clientX;
          const startHold = frame.hold;
          let curHold = startHold;
          holdDrag = { frameId: frame.id };
          store.beginHoldDrag(layer.id, index);
          const move = (ev: PointerEvent) => {
            const delta = Math.round((ev.clientX - startX) / PITCH);
            const next = Math.min(24, Math.max(1, startHold + delta));
            if (next !== curHold) {
              curHold = next;
              store.previewHold(next);
            }
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            holdDrag = null;
            handle.classList.remove("dragging");
            store.endHoldDrag();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
        });
        handle.addEventListener("click", (e) => e.stopPropagation());
        // A double-click on the handle must not split the frame —
        // the handle is for dragging only.
        handle.addEventListener("dblclick", (e) => e.stopPropagation());
        gap.appendChild(handle);
        frow.appendChild(gap);
      });
      const add = document.createElement("button");
      add.className = "icon-btn";
      add.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`;
      add.title = "Add frame";
      add.addEventListener("click", () => store.addFrame(layer.id));
      frow.appendChild(add);
      framesRows.appendChild(frow);
    }
    lastStructural = structuralSig();
  }

  function sync(): void {
    if (holdDrag) {
      // A hold drag updates the gap in place: the line grows or
      // shrinks live and the next cells shift by flex reflow, while
      // the clock updates live on the store emit. The full rebuild
      // happens on release (endHoldDrag emits with holdDrag clear).
      const layer = store.doc.layers.find((l) => l.frames.some((f) => f.id === holdDrag!.frameId));
      const frame = layer?.frames.find((f) => f.id === holdDrag!.frameId);
      if (frame) {
        const gap = framesRows.querySelector(`.hold-gap[data-frame-id="${frame.id}"]`) as HTMLElement | null;
        if (gap) {
          gap.style.width = `${gapWidth(frame.hold)}px`;
          const hasLine = !!gap.querySelector(".hold-line");
          if (frame.hold > 1 && !hasLine) {
            const line = document.createElement("div");
            line.className = "hold-line";
            gap.appendChild(line);
          } else if (frame.hold <= 1 && hasLine) {
            gap.querySelector(".hold-line")?.remove();
          }
        }
      }
      return;
    }
    if (structuralSig() !== lastStructural) rebuild();
    const { layer: curLayer, index: curIndex } = store.currentFrame();
    // Active states.
    for (const row of layerList.querySelectorAll(".layer-row")) {
      const el = row as HTMLElement;
      el.classList.toggle(
        "active",
        el.dataset.layerId === store.currentLayerId,
      );
      const layer = store.doc.layers.find((l) => l.id === el.dataset.layerId);
      if (layer) el.classList.toggle("hidden", !layer.visible);
    }
    // The highlighted cell follows the playhead while playing — each
    // layer's frame at the playing position — and returns to the
    // selected frame when playback stops or pauses.
    for (const cell of framesRows.querySelectorAll(".frame-cell")) {
      const el = cell as HTMLElement;
      const row = el.closest(".frame-row") as HTMLElement | null;
      const layer = store.doc.layers.find((l) => l.id === row?.dataset.layerId);
      const activeId = store.playing && layer
        ? frameAt(layer, store.pos).frame.id
        : curLayer.frames[curIndex].id;
      el.classList.toggle("active", el.dataset.frameId === activeId);
    }
    // Thumbnails, redrawn when a frame's content changes.
    for (const layer of store.doc.layers) {
      for (const frame of layer.frames) {
        const sig = thumbSig(frame, layer.visible);
        if (thumbSigs.get(frame.id) === sig) continue;
        thumbSigs.set(frame.id, sig);
        const cell = framesRows.querySelector(`.frame-cell[data-frame-id="${frame.id}"] canvas`) as HTMLCanvasElement | null;
        if (cell) {
          const stage = STAGES.find((s) => s.id === store.doc.stageId) ?? STAGES[0];
          renderThumbnail(cell, frame, { w: stage.w, h: stage.h });
        }
      }
    }
  }

  store.onChange(sync);
  rebuild();
  sync();
}

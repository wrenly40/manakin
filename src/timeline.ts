// Timeline: the layers list and the frame cells. Layers[0] is the top
// layer. A cell is a thumbnail of its frame; clicking a cell edits it.
import { STAGES, frameAt, timelineLength } from "./model";
import type { Frame } from "./model";
import { renderThumbnail } from "./render";
import type { Store } from "./store";

export function createTimeline(panelEl: HTMLElement, store: Store): void {
  // The + Layer button lives in a header row spanning BOTH columns,
  // above the body — not inside the layer column. When it sat in the
  // column it shifted every card down by its 44px block (32px button
  // + 8px top + 4px bottom margin) while the frame rows started at
  // the panel top, so every row sat 44px higher than its card. With
  // the button in the header, both columns start below it and their
  // tops match by construction.
  panelEl.innerHTML = `
    <div id="timeline-header">
      <div id="timeline-header-left">
        <button id="add-layer" class="pbtn" title="Add layer"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Layer</span></button>
      </div>
      <div id="frame-ruler"><div id="frame-ruler-inner"></div></div>
    </div>
    <div id="timeline-body">
      <div id="layer-col">
        <div id="layer-list"></div>
      </div>
      <div id="frames-scroll"><div id="frames-rows"></div></div>
    </div>`;

  const layerList = panelEl.querySelector("#layer-list") as HTMLDivElement;
  const framesRows = panelEl.querySelector("#frames-rows") as HTMLDivElement;
  const framesScroll = panelEl.querySelector("#frames-scroll") as HTMLDivElement;
  const rulerEl = panelEl.querySelector("#frame-ruler") as HTMLDivElement;
  const rulerInner = panelEl.querySelector("#frame-ruler-inner") as HTMLDivElement;
  const addLayerBtn = panelEl.querySelector("#add-layer") as HTMLButtonElement;

  addLayerBtn.addEventListener("click", () => store.addLayer());

  let lastStructural = "";
  // A hold drag in progress: the frame being dragged. While it is
  // set, sync updates the gap in place instead of rebuilding — a
  // rebuild would destroy the handle mid-drag (pointer capture lost).
  let holdDrag: { frameId: string } | null = null;
  // Swallow the click that follows a reorder drop: the drop already
  // selected the moved frame, and the click would re-select the
  // frame at its OLD index. Cleared by the click handler, or by a
  // 0ms timer if the click never fires (a rebuild in between can
  // disconnect the cell before the click is dispatched).
  let suppressCellClick = false;
  // The frame pitch: a 96px cell plus the 6px between cells. A hold
  // gap is (hold − 1) pitches plus the 6px inter-cell space, so the
  // line spans exactly from one cell's right edge to the next cell's
  // left edge.
  const PITCH = 102;
  const gapWidth = (hold: number): number => (hold > 1 ? (hold - 1) * PITCH + 6 : 6);
  // The frame-number ruler: one number per timeline frame, centred
  // over its cell at the pitch. The total is the same one the clock
  // uses — timelineLength, the longest layer's summed holds. The
  // ruler lives in the header, outside the strip's scroll container,
  // so its inner strip follows the strip's scrollLeft by transform.
  // The numbers' base offset is the 1px layer-column divider plus
  // the 12px left padding of #frames-rows: the first cell's left
  // edge sits 13px right of the ruler's left edge.
  const RULER_OFFSET = 13;
  let lastRulerTotal = 0;
  function syncRuler(): void {
    const len = timelineLength(store.doc);
    if (len !== lastRulerTotal) {
      lastRulerTotal = len;
      rulerInner.innerHTML = "";
      rulerInner.style.width = `${RULER_OFFSET + len * PITCH}px`;
      for (let i = 1; i <= len; i++) {
        const num = document.createElement("span");
        num.className = "frame-ruler-num";
        num.textContent = String(i);
        num.style.left = `${RULER_OFFSET + (i - 1) * PITCH}px`;
        rulerInner.appendChild(num);
      }
    }
    rulerInner.style.transform = `translateX(${-framesScroll.scrollLeft}px)`;
  }
  framesScroll.addEventListener("scroll", () => {
    rulerInner.style.transform = `translateX(${-framesScroll.scrollLeft}px)`;
  });
  // Ruler scrubbing: pointerdown on the ruler moves the playhead to
  // that tick and selects the frame whose span contains it; dragging
  // scrubs live; release leaves the playhead where it is. The tick
  // comes from the pointer's x against the ruler's own geometry —
  // the inner strip's on-screen left (which already includes the
  // scroll transform) minus the same 13px base offset, at the same
  // 102px pitch — so a click on number N lands on tick N. Playback
  // pauses on scrub start (store.seek), so it cannot fight the
  // pointer. Clamps to 1..total.
  function tickFromClientX(clientX: number): number {
    const len = timelineLength(store.doc);
    const rect = rulerInner.getBoundingClientRect();
    const x = clientX - rect.left - RULER_OFFSET;
    return Math.min(len, Math.max(1, Math.floor(x / PITCH) + 1));
  }
  rulerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    rulerEl.setPointerCapture(e.pointerId);
    store.seek(tickFromClientX(e.clientX) - 1);
    const move = (ev: PointerEvent) => {
      store.seek(tickFromClientX(ev.clientX) - 1);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  // Lock/unlock glyphs (Lucide, 16px, stroke 1.8, ink — the same
  // icon-button treatment as the move chevrons).
  const LOCK_SVG = `<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
  const UNLOCK_SVG = `<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;
  // Onion skin glyph (Lucide "layers", 16px, stroke 1.8): stacked
  // frames — the neighbouring frames stacked under the live one.
  // The ghost glyph is gone; this is the per-layer toggle's icon.
  const ONION_SVG = `<svg viewBox="0 0 24 24"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>`;
  const thumbSigs = new Map<string, string>();

  function structuralSig(): string {
    return store.doc.layers
      .map((l) => `${l.id}:${l.name}:${l.visible ? 1 : 0}:${l.locked ? 1 : 0}:${l.frames.map((f) => `${f.id}x${f.hold}`).join(",")}`)
      .join("|");
  }

  // The thumbnail signature is the frame's full content — every item's
  // geometry, colour and size — plus the layer's visibility and
  // opacity. The old signature only listed item ids and types, so
  // moving a stroke, resizing a shape, editing text, or undoing a
  // change left the thumbnail stale: the signature never changed, so
  // it never redrew. Opacity is in the signature so a slider drag
  // redraws the thumbnail at the new opacity.
  function thumbSig(frame: Frame, visible: boolean, opacity: number): string {
    return `${visible ? 1 : 0}:${opacity}:${JSON.stringify(frame.items)}`;
  }

  function rebuild(): void {
    layerList.innerHTML = "";
    framesRows.innerHTML = "";
    thumbSigs.clear();
    for (const layer of store.doc.layers) {
      // ---- Layer row: an old .blayer card, two lines. ----
      // Line 1 is the name only, with the hover-revealed delete ×
      // top-right. Line 2 holds ALL the controls on one line:
      // visibility toggle, lock, onion skin, opacity, move up/down.
      // The opacity is a draggable % value (see below) — a slider
      // would not fit the controls line at 250px.
      const row = document.createElement("div");
      row.className = "layer-row" + (layer.visible ? "" : " hidden") + (layer.locked ? " locked" : "");
      row.dataset.layerId = layer.id;
      const head = document.createElement("div");
      head.className = "layer-head";
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
      head.appendChild(name);
      // Duplicate is the same hover-revealed 24px button as the
      // delete ×, sitting immediately left of it on the name line —
      // the two row actions grouped together, both hidden until the
      // row is hovered.
      const dupLayer = document.createElement("button");
      dupLayer.className = "layer-duplicate";
      dupLayer.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      dupLayer.title = "Duplicate layer";
      dupLayer.setAttribute("aria-label", `Duplicate layer ${layer.name}`);
      dupLayer.addEventListener("click", (e) => {
        e.stopPropagation();
        store.duplicateLayer(layer.id);
      });
      head.appendChild(dupLayer);
      const del = document.createElement("button");
      del.className = "layer-remove";
      del.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
      del.title = "Delete layer";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        store.deleteLayer(layer.id);
      });
      head.appendChild(del);
      row.appendChild(head);
      // Controls line: visibility toggle, lock, opacity, move
      // up/down — all on this one line, under the name.
      const controls = document.createElement("div");
      controls.className = "layer-controls";
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
      controls.appendChild(eye);
      const lockBtn = document.createElement("button");
      lockBtn.className = "layer-lock";
      lockBtn.innerHTML = layer.locked ? LOCK_SVG : UNLOCK_SVG;
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer";
      lockBtn.setAttribute("aria-label", layer.locked ? `Unlock layer ${layer.name}` : `Lock layer ${layer.name}`);
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        store.toggleLayerLocked(layer.id);
      });
      controls.appendChild(lockBtn);
      // Onion skin is per-layer: the layers glyph, same 24px
      // treatment as the lock, sitting right after it. On is full
      // ink, off dims the button — the state reads at a glance.
      const onionBtn = document.createElement("button");
      onionBtn.className = "layer-onion" + ((layer.onionSkin ?? true) ? "" : " off");
      onionBtn.innerHTML = ONION_SVG;
      onionBtn.title = (layer.onionSkin ?? true) ? "Turn onion skin off" : "Turn onion skin on";
      onionBtn.setAttribute("aria-label", (layer.onionSkin ?? true) ? `Turn onion skin off for ${layer.name}` : `Turn onion skin on for ${layer.name}`);
      onionBtn.setAttribute("aria-pressed", String(layer.onionSkin ?? true));
      onionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        store.toggleLayerOnionSkin(layer.id);
      });
      controls.appendChild(onionBtn);
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
      controls.appendChild(up);
      controls.appendChild(down);
      // Opacity is a draggable % value, like the brush-size drag
      // pattern: drag horizontally, 1% per 2px, one undo step per
      // drag (the same begin/preview/end pattern as a hold drag).
      // A mini-slider would not fit the controls line at 250px;
      // the % is compact, precise, and its live value is always
      // visible. Arrow keys adjust by 1 (Shift: 10).
      const oValue = document.createElement("span");
      oValue.className = "layer-opacity-value";
      oValue.tabIndex = 0;
      oValue.setAttribute("role", "slider");
      oValue.setAttribute("aria-label", `Opacity of layer ${layer.name}`);
      oValue.setAttribute("aria-valuemin", "0");
      oValue.setAttribute("aria-valuemax", "100");
      oValue.textContent = `${layer.opacity ?? 100}%`;
      oValue.title = "Opacity — drag to change";
      oValue.addEventListener("pointerdown", (e) => {
        // Read the opacity from the store, not the closure: undo
        // replaces store.doc with a clone, and opacity is not in
        // the structural signature, so no rebuild refreshes this
        // closure — the closed-over layer would be stale after an
        // undo of an opacity change.
        const layerNow = store.doc.layers.find((l) => l.id === layer.id);
        const startX = e.clientX;
        const startOpacity = layerNow?.opacity ?? 100;
        store.beginLayerOpacity(layer.id);
        const move = (ev: PointerEvent) => {
          store.previewLayerOpacity(startOpacity + Math.round((ev.clientX - startX) / 2));
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          store.endLayerOpacity();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      });
      oValue.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 10 : 1;
        let delta = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
        else return;
        e.preventDefault();
        e.stopPropagation();
        store.beginLayerOpacity(layer.id);
        // Same staleness as the drag above: read the current
        // opacity from the store, not the closure.
        const layerNow = store.doc.layers.find((l) => l.id === layer.id);
        store.previewLayerOpacity((layerNow?.opacity ?? 100) + delta);
        store.endLayerOpacity();
      });
      controls.insertBefore(oValue, up);
      row.appendChild(controls);
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
        // Duplicate is the same hover-revealed 20px button as the
        // delete ×, mirrored top-LEFT (the × is top-right), so the
        // two are disjoint by construction — 20px buttons at the
        // cell's two top corners, 54px apart on a 96px cell. The
        // Lucide copy glyph is two overlapping squares. Unlike
        // delete, it appears on every cell: duplicating a layer's
        // only frame is fine.
        const dup = document.createElement("button");
        dup.className = "frame-duplicate";
        dup.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        dup.title = "Duplicate frame";
        dup.setAttribute("aria-label", "Duplicate frame");
        dup.addEventListener("click", (e) => {
          e.stopPropagation();
          store.duplicateFrame(layer.id, index);
        });
        cell.appendChild(dup);
        cell.addEventListener("click", () => {
          if (suppressCellClick) {
            suppressCellClick = false;
            return;
          }
          store.setCurrentFrame(layer.id, index);
        });
        // Dragging a cell horizontally reorders the frame within its
        // own layer — its hold moves with it. A plain click still
        // selects (below); the hold handle still drags the hold
        // (its own pointerdown stops propagation, so this never
        // fires from the handle); the delete and duplicate buttons
        // are excluded by the closest("button") check. A drag starts
        // only after the pointer moves past a 5px threshold, so a
        // click is never mistaken for a drag. While dragging, an ink
        // vertical line marks the insertion point; on drop the frame
        // moves there in one undo step and the selection follows it.
        // Same layer only — the drag never leaves its row, so there
        // is no cross-layer move and no auto-scroll.
        cell.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button")) return;
          const startX = e.clientX;
          const startY = e.clientY;
          let dragging = false;
          let insertIndex = index;
          let indicator: HTMLDivElement | null = null;
          cell.setPointerCapture(e.pointerId);
          const cells = (): HTMLElement[] => [...frow.querySelectorAll(".frame-cell")] as HTMLElement[];
          // The insertion point from the pointer's x: the first cell
          // whose centre is right of the pointer, or past the last
          // cell — at the end of its hold gap, just before the +
          // button. The gap after a held frame is wide, but the
          // cell-centre rule still lands right: a pointer anywhere
          // in it is between the two cells' centres.
          const insertionFromX = (clientX: number): { at: number; x: number } => {
            const frowRect = frow.getBoundingClientRect();
            const cs = cells();
            for (let i = 0; i < cs.length; i++) {
              const r = cs[i].getBoundingClientRect();
              if (clientX < r.left + r.width / 2) {
                return { at: i, x: r.left - frowRect.left };
              }
            }
            const gaps = frow.querySelectorAll(".hold-gap");
            const lastGap = gaps[gaps.length - 1];
            const x = lastGap
              ? lastGap.getBoundingClientRect().right - frowRect.left
              : (cs[cs.length - 1]?.getBoundingClientRect().right ?? 0) - frowRect.left;
            return { at: cs.length, x };
          };
          const move = (ev: PointerEvent) => {
            if (!dragging) {
              if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= 5) return;
              dragging = true;
              indicator = document.createElement("div");
              indicator.className = "frame-drop-indicator";
              frow.appendChild(indicator);
              cell.classList.add("reordering");
            }
            const { at, x } = insertionFromX(ev.clientX);
            insertIndex = at;
            if (indicator) indicator.style.left = `${Math.round(x - 1)}px`;
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            if (!dragging) return;
            indicator?.remove();
            cell.classList.remove("reordering");
            suppressCellClick = true;
            setTimeout(() => { suppressCellClick = false; }, 0);
            store.moveFrame(layer.id, index, insertIndex);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", up);
        });
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
        // click's x within the gap — one 102px pitch per tick, the
        // cell itself being tick 0, so the first 102px of the gap is
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
        // The bar spans the FULL HEIGHT of the frame cell: it fills
        // the gap, which is the row's full height (set from the
        // card), so bar and cell share their top and bottom edges.
        // It is 4px wide: in the 6px gap of a hold-1 frame it sits
        // at the gap's right end with a 2px sliver of line between
        // it and the cell. Solid ink, no border, no shadow —
        // direction A, picked by the user. It has the form of the
        // frame's right side: flat on the left, right corners
        // rounded at the cell's 9px radius language (clamped to the
        // bar's 4px width), so it reads as the frame's own right
        // edge, pulled out to the hold's endpoint. Visible only
        // while its cell (or the gap) is hovered, or while dragging
        // — nothing shows at rest.
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
          // Same staleness rule as the opacity drag: read the hold
          // from the store, not the closure.
          const frameNow = store.doc.layers.find((l) => l.id === layer.id)?.frames[index];
          const startHold = frameNow?.hold ?? frame.hold;
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
      // The ruler follows the same live total, so its numbers grow
      // or shrink with the drag.
      syncRuler();
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
      if (layer) {
        el.classList.toggle("hidden", !layer.visible);
        el.classList.toggle("locked", layer.locked);
        // The draggable % value lives on the card; keep it in step
        // with the store (a drag previews through here).
        const value = el.querySelector<HTMLElement>(".layer-opacity-value");
        if (value) {
          value.textContent = `${layer.opacity ?? 100}%`;
          value.setAttribute("aria-valuenow", String(layer.opacity ?? 100));
        }
        // The onion-skin toggle lives on the card too; keep its
        // state in step — toggling it is not a structural change,
        // so no rebuild refreshes the button.
        const onion = el.querySelector<HTMLElement>(".layer-onion");
        if (onion) {
          const on = layer.onionSkin ?? true;
          onion.classList.toggle("off", !on);
          onion.title = on ? "Turn onion skin off" : "Turn onion skin on";
          onion.setAttribute("aria-pressed", String(on));
          onion.setAttribute("aria-label", on ? `Turn onion skin off for ${layer.name}` : `Turn onion skin on for ${layer.name}`);
        }
      }
      // A frame row matches its layer card's height, so the rows stay
      // aligned. Guarded to write only when changed.
      const frow = framesRows.querySelector(`.frame-row[data-layer-id="${el.dataset.layerId}"]`) as HTMLElement | null;
      if (frow) {
        const h = `${Math.round(el.getBoundingClientRect().height)}px`;
        if (frow.style.height !== h) frow.style.height = h;
      }
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
        const sig = thumbSig(frame, layer.visible, layer.opacity ?? 100);
        if (thumbSigs.get(frame.id) === sig) continue;
        thumbSigs.set(frame.id, sig);
        const cell = framesRows.querySelector(`.frame-cell[data-frame-id="${frame.id}"] canvas`) as HTMLCanvasElement | null;
        if (cell) {
          const stage = STAGES.find((s) => s.id === store.doc.stageId) ?? STAGES[0];
          renderThumbnail(cell, frame, { w: stage.w, h: stage.h }, (layer.opacity ?? 100) / 100);
        }
      }
    }
    // The ruler re-renders when the total changes (frame add/delete,
    // hold change, split) and its inner strip follows the strip's
    // scrollLeft, so each number stays above its cell.
    syncRuler();
  }

  store.onChange(sync);
  rebuild();
  sync();
}

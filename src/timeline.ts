// Timeline: the layers list and the frame cells. Layers[0] is the top
// layer. A cell is a thumbnail of its frame; clicking a cell edits it.
import { STAGES, frameAt } from "./model";
import type { Frame } from "./model";
import { renderThumbnail } from "./render";
import type { Store } from "./store";

export function createTimeline(panelEl: HTMLElement, store: Store): void {
  panelEl.innerHTML = `
    <div id="timeline-head">
      <span class="panel-title">Layers</span>
      <span class="head-spacer"></span>
      <span id="frame-actions" class="seg">
        <button id="hold-minus" title="Shorter hold">−</button>
        <span id="hold-value" title="Hold">1</span>
        <button id="hold-plus" title="Longer hold">+</button>
      </span>
    </div>
    <div id="timeline-body">
      <div id="layer-col">
        <div id="layer-list"></div>
        <button id="add-layer" class="add-btn" title="Add layer"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Add layer</span></button>
      </div>
      <div id="frames-scroll"><div id="frames-rows"></div></div>
    </div>`;

  const layerList = panelEl.querySelector("#layer-list") as HTMLDivElement;
  const framesRows = panelEl.querySelector("#frames-rows") as HTMLDivElement;
  const addLayerBtn = panelEl.querySelector("#add-layer") as HTMLButtonElement;
  const holdMinus = panelEl.querySelector("#hold-minus") as HTMLButtonElement;
  const holdPlus = panelEl.querySelector("#hold-plus") as HTMLButtonElement;
  const holdValue = panelEl.querySelector("#hold-value") as HTMLSpanElement;

  addLayerBtn.addEventListener("click", () => store.addLayer());
  holdMinus.addEventListener("click", () => {
    const { layer, index, frame } = store.currentFrame();
    store.setHold(layer.id, index, frame.hold - 1);
  });
  holdPlus.addEventListener("click", () => {
    const { layer, index, frame } = store.currentFrame();
    store.setHold(layer.id, index, frame.hold + 1);
  });

  let lastStructural = "";
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
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.title = `Frame ${index + 1}${frame.hold > 1 ? `, hold ${frame.hold}` : ""}`;
        const thumb = document.createElement("canvas");
        cell.appendChild(thumb);
        if (frame.hold > 1) {
          const badge = document.createElement("span");
          badge.className = "hold-badge";
          badge.textContent = `×${frame.hold}`;
          cell.appendChild(badge);
        }
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
    holdValue.textContent = String(curLayer.frames[curIndex].hold);
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

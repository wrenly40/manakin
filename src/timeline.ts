// Timeline: the layers list and the frame cells. Layers[0] is the top
// layer. A cell is a thumbnail of its frame; clicking a cell edits it.
import { STAGES } from "./model";
import { renderThumbnail } from "./render";
import type { Store } from "./store";

export function createTimeline(panelEl: HTMLElement, store: Store): void {
  panelEl.innerHTML = `
    <div id="timeline-head">
      <span class="panel-title">Layers</span>
      <button id="add-layer" class="pbtn" title="Add layer">+ Layer</button>
      <span class="head-spacer"></span>
      <span id="frame-actions" class="seg">
        <button id="hold-minus" title="Shorter hold">−</button>
        <span id="hold-value" title="Hold">1</span>
        <button id="hold-plus" title="Longer hold">+</button>
      </span>
    </div>
    <div id="timeline-body">
      <div id="layer-list"></div>
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

  function thumbSig(frameId: string): string {
    for (const layer of store.doc.layers) {
      const f = layer.frames.find((fr) => fr.id === frameId);
      if (f) return f.items.map((it) => `${it.id}:${it.type}`).join(",");
    }
    return "";
  }

  function rebuild(): void {
    layerList.innerHTML = "";
    framesRows.innerHTML = "";
    thumbSigs.clear();
    for (const layer of store.doc.layers) {
      // ---- Layer row ----
      const row = document.createElement("div");
      row.className = "layer-row";
      row.dataset.layerId = layer.id;
      const eye = document.createElement("button");
      eye.className = "icon-btn";
      eye.title = layer.visible ? "Hide layer" : "Show layer";
      eye.setAttribute("aria-label", layer.visible ? "Hide layer" : "Show layer");
      eye.innerHTML = layer.visible
        ? `<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.6 10.6 0 0 1 12 19c-6.5 0-10-7-10-7a17.6 17.6 0 0 1 4.06-4.94M9.9 4.24A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.16 3.19M14.12 14.12A3 3 0 1 1 9.88 9.88"/><path d="M1 1l22 22"/></svg>`;
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
      up.className = "icon-btn";
      up.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>`;
      up.title = "Move layer up";
      up.addEventListener("click", (e) => {
        e.stopPropagation();
        store.moveLayer(layer.id, -1);
      });
      const down = document.createElement("button");
      down.className = "icon-btn";
      down.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 10l6 6 6-6"/></svg>`;
      down.title = "Move layer down";
      down.addEventListener("click", (e) => {
        e.stopPropagation();
        store.moveLayer(layer.id, 1);
      });
      const del = document.createElement("button");
      del.className = "icon-btn";
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
        const cell = document.createElement("button");
        cell.className = "frame-cell";
        cell.dataset.frameId = frame.id;
        cell.title = `Frame ${index + 1}${frame.hold > 1 ? `, hold ${frame.hold}` : ""}`;
        const thumb = document.createElement("canvas");
        cell.appendChild(thumb);
        if (frame.hold > 1) {
          const badge = document.createElement("span");
          badge.className = "hold-badge";
          badge.textContent = `×${frame.hold}`;
          cell.appendChild(badge);
        }
        cell.addEventListener("click", () => store.setCurrentFrame(layer.id, index));
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
      (row as HTMLElement).classList.toggle(
        "active",
        (row as HTMLElement).dataset.layerId === store.currentLayerId,
      );
    }
    for (const row of framesRows.querySelectorAll(".frame-row")) {
      (row as HTMLElement).classList.toggle(
        "active",
        (row as HTMLElement).dataset.layerId === store.currentLayerId,
      );
    }
    for (const cell of framesRows.querySelectorAll(".frame-cell")) {
      const el = cell as HTMLElement;
      el.classList.toggle(
        "active",
        el.dataset.frameId === curLayer.frames[curIndex].id,
      );
    }
    holdValue.textContent = String(curLayer.frames[curIndex].hold);
    // Thumbnails, redrawn when a frame's items change.
    for (const layer of store.doc.layers) {
      for (const frame of layer.frames) {
        const sig = thumbSig(frame.id);
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

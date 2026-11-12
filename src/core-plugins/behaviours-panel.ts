// Behaviour panel — the layer stack UI (Manakin Plugin API v1).
//
// Moved verbatim out of src/main.ts in the core-plugins phase 3: the
// layer cards, graphs, Add behavior list and behaviour groups are the
// Behaviours plugin's UI, not the core's. The core renders its own
// panels (Canvas, multi-select, the Arrange-only fallbacks) and asks
// the panel-view registry for this one; with the plugin off, no view
// matches and the behaviour UI is gone entirely. Everything the panel
// needs from the core comes through the PluginContext: the document
// gestures and save, the panel re-render, the shared Arrange section
// and divider builders, the shared tooltip.

import type { PanelViewDef, PluginContext } from "../plugins";
import { amplitudeScale, behaviourValue, hostCtx, hostFindLayer, hostGroups, hostLayers } from "./behaviours-motion";
import { BEHAVIOURS, CYCLE_MAX, CYCLE_MIN, EASING_ARIA, EASING_IDS, EASING_LABELS, LAYER_ICONS, newLayer, nid } from "../model";
import type { BehaviourGroup, BehaviourLayer, EasingName, Item, ItemGroup, LayerCtx, LayerHost } from "../model";

let api!: PluginContext;

// Panel state the plugin owns: which layer / group is expanded, the
// inline Add behavior list, the layers checked for grouping, and the
// scroll-into-view requests the view's afterRender serves.
let expandedLayerId: string | null = null;
let expandedGroup: string | null = null; // id of the open group in the Behaviours panel
let addPickerOpen = false; // the inline Add behavior list is showing
let checkedLayers: Set<string> = new Set(); // top-level layer ids picked for grouping
let checkedHostId: string | null = null; // the host (item or item group) the checked rows belong to
let scrollToLayerId: string | null = null;
let scrollToAddList = false; // set when the Add button opens the list

export function initBehaviourPanel(a: PluginContext): void {
  api = a;
}

// The panel transient: the inline Add behavior list closes on Escape
// or on a click anywhere outside it. The core asks this before its
// own overlay handling.
export function closeBehaviourTransient(target?: HTMLElement): boolean {
  if (!addPickerOpen) return false;
  if (target && target.closest(".add-wrap")) return false;
  addPickerOpen = false;
  return true;
}

// The panel view: a single selected item, or an item group selected
// as a whole, shows the behaviour stack. Everything else falls
// through to the core's own panels.
export const behaviourPanelView: PanelViewDef = {
  id: "behaviours",
  when: (ctx) => ctx.selectedGroup !== null || ctx.selectedItems.length === 1,
  render: (ctx, body, setTitle) => {
    if (ctx.selectedGroup) renderItemGroupPanel(ctx.selectedGroup, body, setTitle);
    else renderBehavioursPanel(ctx.selectedItems[0], body, setTitle);
  },
  afterRender: (_ctx, body) => {
    if (scrollToLayerId) {
      const el = body.querySelector(`[data-layer-id="${scrollToLayerId}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
      scrollToLayerId = null;
    }
    if (scrollToAddList) {
      const list = body.querySelector(".add-list");
      if (list) (list as HTMLElement).scrollIntoView({ block: "nearest" });
      scrollToAddList = false;
    }
  },
};

function paramSlider(opts: {
  label: string; min: number; max: number; step: number; value: number;
  format: (v: number) => string; aria: string;
  onInput: (v: number) => void; onCommit: () => void;
}): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "pslider-row";
  const lab = document.createElement("span");
  lab.className = "dctl-label";
  lab.textContent = opts.label;
  const input = document.createElement("input");
  input.type = "range";
  input.className = "pslider";
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.setAttribute("aria-label", opts.aria);
  const val = document.createElement("span");
  val.className = "pslider-value";
  val.textContent = opts.format(opts.value);
  // One undo entry per drag, not one per input event: capture the
  // pre-change snapshot when the interaction starts (pointerdown,
  // focus, or — for synthetic events — the first input) and commit it
  // on release, but only when the value actually moved.
  let pendingBefore: string | null = null;
  let startValue = opts.value;
  const begin = (): void => {
    if (pendingBefore === null) {
      pendingBefore = api.doc.gestureStart();
      startValue = parseFloat(input.value);
    }
  };
  input.addEventListener("pointerdown", begin);
  input.addEventListener("focus", begin);
  input.addEventListener("input", () => {
    begin();
    const v = parseFloat(input.value);
    val.textContent = opts.format(v);
    opts.onInput(v);
  });
  input.addEventListener("change", () => {
    if (pendingBefore !== null) {
      if (parseFloat(input.value) !== startValue) api.doc.gestureCommit(pendingBefore, true);
      pendingBefore = null;
    }
    opts.onCommit();
  });
  row.appendChild(lab);
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

// A labelled segmented choice (Easing, Orbit Direction): the label sits
// above the control, the control is a .seg. The active button updates in
// place; the caller owns history/save/redraw. A click on the already
// active option is a no-op (no undo entry, no re-render).
function choiceSeg(opts: {
  label: string; aria: string; compact?: boolean;
  options: { id: string; label: string; aria: string }[];
  value: string;
  onPick: (id: string) => void;
}): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "choice-row";
  const lab = document.createElement("span");
  lab.className = "dctl-label";
  lab.textContent = opts.label;
  row.appendChild(lab);
  const seg = document.createElement("div");
  seg.className = "seg" + (opts.compact ? " compact-seg" : "");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", opts.aria);
  let current = opts.value;
  const btns: HTMLButtonElement[] = [];
  for (const o of opts.options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = current === o.id ? "active" : "";
    b.textContent = o.label;
    b.setAttribute("aria-label", o.aria);
    b.addEventListener("click", () => {
      if (current === o.id) return;
      current = o.id;
      for (const x of btns) x.classList.toggle("active", x === b);
      opts.onPick(o.id);
    });
    seg.appendChild(b);
    btns.push(b);
  }
  row.appendChild(seg);
  return row;
}

function drawGraph(cv: HTMLCanvasElement, layer: BehaviourLayer, ctx: LayerCtx): void {
  const W = 232, H = 48;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = "rgba(0,0,0,0.08)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, H / 2 + 0.5);
  g.lineTo(W, H / 2 + 0.5);
  g.stroke();
  const N = 120;
  const maxAmp = 1.8; // amplitudeScale(1)
  g.strokeStyle = "#1d1d1f";
  g.lineWidth = 1.5;
  g.lineJoin = "round";
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const v = behaviourValue(layer, ctx, t) / maxAmp;
    const x = (t * (W - 4)) + 2;
    const y = H / 2 - v * (H / 2 - 5);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}


function drawGroupGraph(cv: HTMLCanvasElement, host: LayerHost, group: BehaviourGroup): void {
  const W = 232, H = 48;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = "rgba(0,0,0,0.08)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, H / 2 + 0.5);
  g.lineTo(W, H / 2 + 0.5);
  g.stroke();
  const N = 120;
  const ctx = hostCtx(host);
  const members = group.members.map((id) => hostFindLayer(host, id)).filter((l): l is BehaviourLayer => !!l);
  const vals: number[] = [];
  let scale = 0;
  for (const layer of members) if (ctx.active(layer)) scale += amplitudeScale(layer.amplitude);
  if (scale < 0.01) scale = 1;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let v = 0;
    for (const layer of members) if (ctx.active(layer)) v += behaviourValue(layer, ctx, t);
    vals.push(v);
  }
  g.strokeStyle = "#1d1d1f";
  g.lineWidth = 1.5;
  g.lineJoin = "round";
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = ((i / N) * (W - 4)) + 2;
    const y = H / 2 - (vals[i] / scale) * (H / 2 - 5);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

// Display name is derived, not stored: when a stack holds more than one
// instance of a behaviour, each shows its ordinal among instances of that
// behaviour in stack order — first "Bob", second "Bob 2", third "Bob 3".
// A lone instance shows just "Bob".
function layerDisplayName(h: LayerHost, layer: BehaviourLayer): string {
  const same = hostLayers(h).filter((l) => l.behaviour === layer.behaviour);
  if (same.length <= 1) return BEHAVIOURS[layer.behaviour];
  const idx = same.indexOf(layer);
  return idx === 0 ? BEHAVIOURS[layer.behaviour] : `${BEHAVIOURS[layer.behaviour]} ${idx + 1}`;
}

// One behaviour layer row: on/off toggle, name, expand chevron, and — when
// expanded — its graph plus Cycle/Amplitude/Offset and its own extra controls.
// Works on an item's stack or an item group's stack; the host is what
// owns the layer. Returns the row and its graph canvas (null while
// collapsed) so a group can redraw member graphs when a group slider moves.
function behaviourLayer(host: LayerHost, inst: BehaviourLayer, opts: { checkable: boolean; onParamChange?: () => void }): { layer: HTMLDivElement; graph: HTMLCanvasElement | null } {
  const b = inst.behaviour;
  const displayName = layerDisplayName(host, inst);
  const liveLayer = (): BehaviourLayer | undefined => hostFindLayer(host, inst.id);
  const layer = document.createElement("div");
  layer.className = "blayer" + (expandedLayerId === inst.id ? " expanded" : "");
  layer.dataset.behaviour = String(b);
  layer.dataset.layerId = inst.id;
  const head = document.createElement("div");
  head.className = "layer-head";
  if (opts.checkable) {
    const check = document.createElement("button");
    check.type = "button";
    check.className = "layer-check" + (checkedLayers.has(inst.id) ? " checked" : "");
    check.setAttribute("aria-label", `Select ${displayName} for grouping`);
    check.setAttribute("aria-pressed", String(checkedLayers.has(inst.id)));
    check.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg>";
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      if (checkedLayers.has(inst.id)) checkedLayers.delete(inst.id);
      else checkedLayers.add(inst.id);
      api.app.renderPanel();
    });
    head.appendChild(check);
  }
  const icon = document.createElement("span");
  icon.className = "layer-icon";
  icon.innerHTML = LAYER_ICONS[b];
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "layer-toggle" + (inst.on ? " on" : "");
  toggle.setAttribute("aria-label", `${displayName} on or off`);
  toggle.setAttribute("aria-pressed", String(inst.on));
  toggle.innerHTML = "<span class=\"knob\"></span>";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const l = liveLayer();
    if (!l) return;
    api.doc.pushHistory();
    l.on = !l.on;
    api.doc.save();
    api.app.renderPanel();
  });
  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = displayName;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "layer-remove";
  remove.title = "Remove";
  remove.setAttribute("aria-label", `Remove ${displayName}`);
  remove.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg>";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    removeBehaviourLayer(host, inst.id);
  });
  const chev = document.createElement("button");
  chev.type = "button";
  chev.className = "layer-chev";
  chev.setAttribute("aria-label", expandedLayerId === inst.id ? `Collapse ${displayName}` : `Expand ${displayName}`);
  chev.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M6 9l6 6 6-6\"/></svg>";
  const toggleExpand = (): void => {
    expandedLayerId = expandedLayerId === inst.id ? null : inst.id;
    api.app.renderPanel();
  };
  chev.addEventListener("click", (e) => {
    e.stopPropagation(); // the head row also toggles; without this it flips twice
    toggleExpand();
  });
  head.appendChild(icon);
  head.appendChild(name);
  head.appendChild(toggle);
  head.appendChild(chev);
  head.appendChild(remove);
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".layer-toggle, .layer-check, .layer-remove")) return;
    toggleExpand();
  });
  layer.appendChild(head);
  let graph: HTMLCanvasElement | null = null;
  if (expandedLayerId === inst.id) {
    const body = document.createElement("div");
    body.className = "layer-body";
    graph = document.createElement("canvas");
    graph.className = "graph";
    graph.setAttribute("aria-label", `${displayName} motion graph`);
    body.appendChild(graph);
    const redraw = (): void => {
      const l = hostFindLayer(host, inst.id);
      if (graph && l) drawGraph(graph, l, hostCtx(host));
      opts.onParamChange?.();
    };
    body.appendChild(paramSlider({
      label: "Cycle", min: CYCLE_MIN, max: CYCLE_MAX, step: 1, value: inst.cycle,
      format: (v) => `${Math.round(v)}`,
      aria: `${displayName} cycle`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.cycle = Math.round(v); redraw(); },
      onCommit: () => api.doc.save(),
    }));
    body.appendChild(paramSlider({
      label: "Amplitude", min: 0, max: 1, step: 0.01, value: inst.amplitude,
      format: (v) => v.toFixed(2),
      aria: `${displayName} amplitude`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.amplitude = v; redraw(); },
      onCommit: () => api.doc.save(),
    }));
    body.appendChild(paramSlider({
      label: "Offset", min: 0, max: 1, step: 0.01, value: inst.offset,
      format: (v) => v.toFixed(2),
      aria: `${displayName} offset`,
      onInput: (v) => { const l = liveLayer(); if (!l) return; l.offset = v; redraw(); },
      onCommit: () => api.doc.save(),
    }));
    body.appendChild(choiceSeg({
      label: "Easing", aria: `${displayName} easing`, compact: true,
      options: EASING_IDS.map((e) => ({ id: e, label: EASING_LABELS[e], aria: EASING_ARIA[e] })),
      value: inst.easing,
      onPick: (id) => {
        const l = liveLayer();
        if (!l) return;
        api.doc.pushHistory();
        l.easing = id as EasingName;
        redraw();
        api.doc.save();
      },
    }));
    if (b === 3) {
      body.appendChild(paramSlider({
        label: "Duration", min: 10, max: 60, step: 1, value: inst.blinkDuration,
        format: (v) => `${Math.round(v)}%`,
        aria: "Blink duration",
        onInput: (v) => { const l = liveLayer(); if (!l) return; l.blinkDuration = v; redraw(); },
        onCommit: () => api.doc.save(),
      }));
    }
    if (b === 4) {
      const revRow = document.createElement("div");
      revRow.className = "ptoggle-row";
      const revLab = document.createElement("span");
      revLab.className = "dctl-label";
      revLab.textContent = "Reverse";
      const revToggle = document.createElement("button");
      revToggle.type = "button";
      revToggle.className = "layer-toggle" + (inst.spinReverse ? " on" : "");
      revToggle.setAttribute("aria-label", "Spin reverse");
      revToggle.setAttribute("aria-pressed", String(inst.spinReverse));
      revToggle.innerHTML = "<span class=\"knob\"></span>";
      const revVal = document.createElement("span");
      revVal.className = "pslider-value";
      revVal.textContent = inst.spinReverse ? "On" : "Off";
      revToggle.addEventListener("click", () => {
        const l = liveLayer();
        if (!l) return;
        api.doc.pushHistory();
        l.spinReverse = !l.spinReverse;
        revToggle.classList.toggle("on", l.spinReverse);
        revToggle.setAttribute("aria-pressed", String(l.spinReverse));
        revVal.textContent = l.spinReverse ? "On" : "Off";
        redraw();
        api.doc.save();
      });
      revRow.appendChild(revLab);
      revRow.appendChild(revToggle);
      revRow.appendChild(revVal);
      body.appendChild(revRow);
    }
    if (b === 5) {
      body.appendChild(paramSlider({
        label: "Smooth", min: 0, max: 100, step: 1, value: inst.wanderSmooth,
        format: (v) => `${Math.round(v)}%`,
        aria: "Wander smoothness",
        onInput: (v) => { const l = liveLayer(); if (!l) return; l.wanderSmooth = v; redraw(); },
        onCommit: () => api.doc.save(),
      }));
    }
    if (b === 8) {
      body.appendChild(choiceSeg({
        label: "Direction", aria: "Orbit direction",
        options: [
          { id: "cw", label: "Clockwise", aria: "Orbit direction clockwise" },
          { id: "ccw", label: "Counter-clockwise", aria: "Orbit direction counter-clockwise" },
        ],
        value: inst.orbitReverse ? "ccw" : "cw",
        onPick: (id) => {
          const l = liveLayer();
          if (!l) return;
          api.doc.pushHistory();
          l.orbitReverse = id === "ccw";
          redraw();
          api.doc.save();
        },
      }));
    }
    layer.appendChild(body);
    drawGraph(graph, inst, hostCtx(host));
  }
  return { layer, graph };
}

// One group row: chevron, name (click to rename inline), on/off toggle,
// ungroup button. When expanded: combined graph, the group's Cycle and
// Amplitude sliders, then the member rows with their own controls.
function groupLayer(host: LayerHost, group: BehaviourGroup): HTMLDivElement {
  const open = expandedGroup === group.id;
  const layer = document.createElement("div");
  layer.className = "blayer group" + (open ? " expanded" : "");
  layer.dataset.group = group.id;
  const head = document.createElement("div");
  head.className = "layer-head group-head";
  const chev = document.createElement("button");
  chev.type = "button";
  chev.className = "layer-chev";
  chev.setAttribute("aria-label", open ? `Collapse ${group.name}` : `Expand ${group.name}`);
  chev.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M6 9l6 6 6-6\"/></svg>";
  const toggleExpand = (): void => {
    expandedGroup = expandedGroup === group.id ? null : group.id;
    api.app.renderPanel();
  };
  chev.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExpand();
  });
  const name = document.createElement("span");
  name.className = "layer-name group-name";
  name.textContent = group.name;
  name.addEventListener("click", (e) => {
    e.stopPropagation();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "group-rename";
    input.value = group.name;
    input.setAttribute("aria-label", "Layer group name");
    input.spellcheck = false;
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) {
        const v = input.value.trim();
        if (v && v !== group.name) { api.doc.pushHistory(); group.name = v; api.doc.save(); }
      }
      api.app.renderPanel();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    head.replaceChild(input, name);
    input.focus();
    input.select();
  });
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "layer-toggle" + (group.active ? " on" : "");
  toggle.setAttribute("aria-label", `${group.name} on or off`);
  toggle.setAttribute("aria-pressed", String(group.active));
  toggle.innerHTML = "<span class=\"knob\"></span>";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const g = hostGroups(host).find((gg) => gg.id === group.id);
    if (!g) return;
    api.doc.pushHistory();
    g.active = !g.active;
    api.doc.save();
    api.app.renderPanel();
  });
  const ungroup = document.createElement("button");
  ungroup.type = "button";
  ungroup.className = "ungroup-btn";
  ungroup.title = "Ungroup behaviours";
  ungroup.setAttribute("aria-label", `Ungroup ${group.name}`);
  // One square with a crack in it: a single rounded-square outline
  // with a zigzag crack running from the top edge to the bottom edge.
  // The two-squares version read as two shapes; this one is one
  // shape, broken. Same 16px / stroke 1.8 treatment as the other
  // header icons. Only the behaviour ungroup uses this glyph — the
  // item-group ungroup is a labelled pill, not an icon.
  ungroup.innerHTML = "<svg viewBox=\"0 0 24 24\"><rect x=\"5\" y=\"5\" width=\"14\" height=\"14\" rx=\"2.5\"/><path d=\"M13 5 L9.5 9 L14 12.5 L10 16 L13 19\"/></svg>";
  ungroup.addEventListener("click", (e) => {
    e.stopPropagation();
    api.doc.pushHistory();
    const gs = hostGroups(host);
    const i = gs.findIndex((g) => g.id === group.id);
    if (i >= 0) gs.splice(i, 1);
    if (expandedGroup === group.id) expandedGroup = null;
    api.doc.save();
    api.app.renderPanel();
  });
  // Head order matches a layer head: name, toggle, chevron, action —
  // the expand chevron sits on the right in both, not on the left here.
  head.appendChild(name);
  head.appendChild(toggle);
  head.appendChild(chev);
  head.appendChild(ungroup);
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".layer-toggle, .ungroup-btn, .group-rename")) return;
    toggleExpand();
  });
  layer.appendChild(head);
  if (open) {
    const body = document.createElement("div");
    body.className = "layer-body group-body";
    const graph = document.createElement("canvas");
    graph.className = "graph";
    graph.setAttribute("aria-label", `${group.name} combined graph`);
    body.appendChild(graph);
    const memberGraphs = new Map<string, HTMLCanvasElement>();
    const redrawGroupGraph = (): void => {
      const g = hostGroups(host).find((gg) => gg.id === group.id);
      if (g) drawGroupGraph(graph, host, g);
    };
    const redrawMemberGraphs = (): void => {
      for (const [id, cv] of memberGraphs) {
        const l = hostFindLayer(host, id);
        if (l) drawGraph(cv, l, hostCtx(host));
      }
    };
    body.appendChild(paramSlider({
      label: "Cycle", min: CYCLE_MIN, max: CYCLE_MAX, step: 1, value: group.cycle,
      format: (v) => `${Math.round(v)}`,
      aria: `${group.name} cycle`,
      onInput: (v) => { const g = hostGroups(host).find((gg) => gg.id === group.id); if (!g) return; g.cycle = Math.round(v); redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => api.doc.save(),
    }));
    body.appendChild(paramSlider({
      label: "Amplitude", min: 0, max: 1, step: 0.01, value: group.amplitude,
      format: (v) => v.toFixed(2),
      aria: `${group.name} amplitude`,
      onInput: (v) => { const g = hostGroups(host).find((gg) => gg.id === group.id); if (!g) return; g.amplitude = v; redrawGroupGraph(); redrawMemberGraphs(); },
      onCommit: () => api.doc.save(),
    }));
    const membersWrap = document.createElement("div");
    membersWrap.className = "group-members";
    for (const memberId of group.members) {
      const member = hostFindLayer(host, memberId);
      if (!member) continue;
      const { layer: mLayer, graph: mGraph } = behaviourLayer(host, member, {
        checkable: false,
        onParamChange: () => redrawGroupGraph(),
      });
      mLayer.classList.add("in-group");
      if (mGraph) memberGraphs.set(member.id, mGraph);
      membersWrap.appendChild(mLayer);
    }
    body.appendChild(membersWrap);
    layer.appendChild(body);
    drawGroupGraph(graph, host, group);
  }
  return layer;
}

// Remove a layer from a stack. On an item its parameters are stashed
// by behaviour, so adding that behaviour again restores them exactly;
// a later removal of the same behaviour overwrites the stash with the
// most recently removed instance. Other instances of the same behaviour
// are untouched. A grouped member leaves its behaviour group; an
// emptied behaviour group is removed. An item group's stack has no
// stash, but it has behaviour groups: a removed member leaves its
// group the same way.
function removeBehaviourLayer(host: LayerHost, layerId: string): void {
  if (host.kind === "group") {
    api.doc.pushHistory();
    host.group.layers = host.group.layers.filter((l) => l.id !== layerId);
    for (const g of host.group.groups) g.members = g.members.filter((m) => m !== layerId);
    host.group.groups = host.group.groups.filter((g) => g.members.length > 0);
    if (expandedGroup && !host.group.groups.some((g) => g.id === expandedGroup)) expandedGroup = null;
    checkedLayers.delete(layerId);
    if (expandedLayerId === layerId) expandedLayerId = null;
    api.doc.save();
    api.app.renderPanel();
    return;
  }
  const sel = host.item;
  const layer = sel.layers.find((l) => l.id === layerId);
  if (!layer) return;
  api.doc.pushHistory();
  sel.stash[layer.behaviour] = {
    on: layer.on, cycle: layer.cycle, amplitude: layer.amplitude, offset: layer.offset,
    easing: layer.easing,
    blinkDuration: layer.blinkDuration, spinReverse: layer.spinReverse, wanderSmooth: layer.wanderSmooth,
    orbitReverse: layer.orbitReverse,
  };
  sel.layers = sel.layers.filter((l) => l.id !== layerId);
  for (const g of sel.groups) g.members = g.members.filter((m) => m !== layerId);
  sel.groups = sel.groups.filter((g) => g.members.length > 0);
  if (expandedGroup && !sel.groups.some((g) => g.id === expandedGroup)) expandedGroup = null;
  checkedLayers.delete(layerId);
  if (expandedLayerId === layerId) expandedLayerId = null;
  api.doc.save();
  api.app.renderPanel();
}

// Add a behaviour to a stack. Always a NEW instance, even when one of
// that behaviour is already there. On an item, a stashed instance (the
// most recently removed one of this behaviour) restores its parameters;
// a never-added behaviour starts at the defaults. An item group's stack
// has no stash: it always starts at the defaults.
function addBehaviour(host: LayerHost, b: number): void {
  api.doc.pushHistory();
  let layer: BehaviourLayer;
  if (host.kind === "group") {
    layer = newLayer(b);
    host.group.layers.push(layer);
  } else {
    const stashed = host.item.stash[b];
    layer = stashed
      ? { id: nid(), behaviour: b, ...stashed }
      : newLayer(b);
    if (stashed) delete host.item.stash[b];
    host.item.layers.push(layer);
  }
  scrollToLayerId = layer.id;
  addPickerOpen = false;
  api.doc.save();
  api.app.renderPanel();
}

// The Add behavior list: opens inline in the panel, directly below
// the Add button, as part of the panel's own scrollable flow — it
// covers nothing and pushes nothing aside. Lists all eleven
// behaviours with their icons. Every row is always enabled: the same
// behaviour can be added several times, each add creating a new
// instance. Picking a row adds the behaviour and collapses the list.
function renderAddList(host: LayerHost): HTMLElement {
  const list = document.createElement("div");
  list.className = "add-list";
  list.setAttribute("role", "listbox");
  for (let b = 0; b < BEHAVIOURS.length; b++) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "add-list-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-label", `Add ${BEHAVIOURS[b]}`);
    row.innerHTML = `<span class="layer-icon">${LAYER_ICONS[b]}</span><span class="layer-name">${BEHAVIOURS[b]}</span>`;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      addBehaviour(host, b);
    });
    list.appendChild(row);
  }
  return list;
}

// Group the checked layers of a host's stack into one behaviour
// group: the group's Cycle/Amplitude multiply its members'. Same
// flow on an item and on an item group.
function createBehaviourGroup(host: LayerHost): void {
  if (checkedLayers.size < 2) return;
  api.doc.pushHistory();
  const layers = hostLayers(host);
  const groups = hostGroups(host);
  const members = [...checkedLayers].sort((a, b) => layers.findIndex((l) => l.id === a) - layers.findIndex((l) => l.id === b));
  let n = 1;
  for (const g of groups) {
    const m = /^Layer Group (\d+)$/.exec(g.name);
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
  }
  const group: BehaviourGroup = { id: nid(), name: `Layer Group ${n}`, members, active: true, cycle: 1, amplitude: 1 };
  groups.push(group);
  checkedLayers.clear();
  expandedLayerId = null;
  expandedGroup = group.id;
  api.doc.save();
  api.app.renderPanel();
}

// The checkable stack for a host: the grouping checks reset when the
// host changes, checks drop for layers that left the stack or joined
// a group, and the rows and behaviour-group cards render in stack
// order — a group takes its first member's place, so ungrouping
// restores members to their original positions.
function appendStackEntries(host: LayerHost, body: HTMLElement): void {
  const layers = hostLayers(host);
  const groups = hostGroups(host);
  const hostId = host.kind === "item" ? host.item.id : host.group.id;
  if (checkedHostId !== hostId) { checkedLayers.clear(); checkedHostId = hostId; addPickerOpen = false; }
  const grouped = new Set(groups.flatMap((g) => g.members));
  // Drop checks for layers that left the stack or joined a group.
  for (const id of [...checkedLayers]) if (!layers.some((l) => l.id === id) || grouped.has(id)) checkedLayers.delete(id);
  type Entry = { pos: number; render: () => HTMLElement };
  const entries: Entry[] = [];
  for (const layer of layers) {
    if (!grouped.has(layer.id)) entries.push({ pos: layers.indexOf(layer), render: () => behaviourLayer(host, layer, { checkable: true }).layer });
  }
  for (const g of groups) {
    const idxs = g.members.map((id) => layers.findIndex((l) => l.id === id)).filter((i) => i >= 0);
    entries.push({ pos: idxs.length ? Math.min(...idxs) : Number.POSITIVE_INFINITY, render: () => groupLayer(host, g) });
  }
  entries.sort((a, b) => a.pos - b.pos);
  for (const e of entries) body.appendChild(e.render());
}

// The "Group behaviours" pill, shown when 2+ layers of the host's
// stack are checked. Same flow on an item and on an item group.
function appendGroupBehavioursAction(host: LayerHost, body: HTMLElement): void {
  if (checkedLayers.size < 2) return;
  body.appendChild(api.ui.panelDivider());
  const action = document.createElement("div");
  action.className = "group-action";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pbtn-quiet";
  btn.textContent = "Group behaviours";
  btn.setAttribute("aria-label", `Group ${checkedLayers.size} behaviours`);
  btn.addEventListener("click", () => createBehaviourGroup(host));
  action.appendChild(btn);
  body.appendChild(action);
}

function renderBehavioursPanel(sel: Item, body: HTMLElement, setTitle: (t: string) => void): void {
  setTitle("Behaviours");
  body.appendChild(api.ui.arrangeSection());
  body.appendChild(api.ui.panelDivider());
  const host: LayerHost = { kind: "item", item: sel };
  appendStackEntries(host, body);
  if (sel.layers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-behaviours";
    empty.textContent = "No behaviours";
    body.appendChild(empty);
  }
  appendGroupBehavioursAction(host, body);
  // Add behavior: a quiet pill at the bottom of the stack. Always
  // enabled — adding the same behaviour again creates another instance.
  body.appendChild(renderAddBehaviourButton(host));
}

// The Add behavior pill, shared by the item stack and the item-group
// stack: it expands the behaviour list inline below the button, for
// that host.
function renderAddBehaviourButton(host: LayerHost): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "add-wrap";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "add-btn";
  addBtn.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg><span>Add behavior</span>";
  addBtn.setAttribute("aria-label", "Add behavior");
  addBtn.setAttribute("aria-expanded", String(addPickerOpen));
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    addPickerOpen = !addPickerOpen;
    if (addPickerOpen) scrollToAddList = true;
    api.app.renderPanel();
  });
  wrap.appendChild(addBtn);
  if (addPickerOpen) wrap.appendChild(renderAddList(host));
  return wrap;
}

// ---------- item groups (panel) ----------
function renderItemGroupPanel(group: ItemGroup, body: HTMLElement, setTitle: (t: string) => void): void {
  setTitle("Behaviours");
  body.appendChild(api.ui.arrangeSection());
  body.appendChild(api.ui.panelDivider());
  const host: LayerHost = { kind: "group", group };
  appendStackEntries(host, body);
  if (group.layers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-behaviours";
    empty.textContent = "No behaviours";
    body.appendChild(empty);
  }
  appendGroupBehavioursAction(host, body);
  body.appendChild(api.ui.panelDivider());
  const action = document.createElement("div");
  action.className = "group-action";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pbtn-quiet";
  btn.textContent = "Ungroup objects";
  btn.setAttribute("aria-label", "Ungroup objects");
  btn.addEventListener("click", () => { api.doc.ungroupItemGroup(group); });
  action.appendChild(btn);
  body.appendChild(action);
  body.appendChild(renderAddBehaviourButton(host));
}

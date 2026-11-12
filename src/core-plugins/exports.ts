// Exports — first-party plugin (Manakin Plugin API v1).
//
// PNG sequence, GIF, WebM and MP4 export, plus the Export dropdown
// (the bordered card with PNG / Video tabs) in the Canvas panel's
// Actions section. Migrated out of the core in the core-plugins
// phase 1: the core never calls into this module directly — it renders
// the registered Export action, and the plugin system owns the
// dropdown's lifecycle (open/close/refresh) through the overlay
// registry. Everything the plugin needs from the core comes through
// the PluginContext: the offline frame renderer, the loop, the file
// surface and the panel re-render.
//
// State the plugin owns, including its persistence: the active tab
// and the video format live in plugin storage (api.storage), seeded
// once from the core save's legacy values (exportTab / videoFormat)
// the first time the plugin activates. The core save no longer
// carries them.

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource } from "mediabunny";
import type { PluginContext, PluginModule } from "../plugins";

export const manifest = {
  id: "exports",
  name: "Exports",
  version: "1.0.0",
  apiVersion: "1",
  description: "PNG sequence and GIF / WebM / MP4 video export, with the Export dropdown.",
  permissions: ["doc", "export", "ui", "storage"],
  contributions: {
    actions: [{ id: "export", label: "Export" }],
    overlays: [{ id: "export-dropdown" }],
  },
};

type ExportTab = "png" | "video";
type VideoFormat = "gif" | "webm" | "mp4";

let api!: PluginContext;
let exporting = false; // an export (PNG sequence or video) is running right now
let exportTab: ExportTab = "png";
let videoFormat: VideoFormat = "webm";
let exportProgress: { text: string; target: ExportTab } | null = null;
let exportDropdownOpen = false; // the Export dropdown (card in a popover) is showing

// "Exporting 45/120" while an offline export runs, on the button doing it.
function setExportProgress(text: string, target: ExportTab): void {
  exportProgress = { text, target };
  const b = document.getElementById(target === "png" ? "export-png-btn" : "export-video-btn");
  if (b) b.textContent = text;
}

function closeExportDropdownEl(): void {
  document.querySelector(".export-dropdown")?.remove();
}

// The Export card itself: PNG and Video are tabs at its top, the
// active tab's content sits below them. No Scale, no Frame. Built
// fresh on every render, so tab switches and format picks re-render
// through renderPanel.
function renderExportCard(): HTMLDivElement {
  const card = document.createElement("div");
  card.id = "export-card";
  const tabs = document.createElement("div");
  tabs.className = "seg";
  tabs.id = "export-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Export");
  const tabBtns: HTMLButtonElement[] = [];
  for (const t of [{ id: "png", label: "PNG" }, { id: "video", label: "Video" }] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = exportTab === t.id ? "active" : "";
    b.textContent = t.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", exportTab === t.id ? "true" : "false");
    b.addEventListener("click", () => {
      if (exportTab === t.id) return;
      exportTab = t.id;
      api.storage.set("exportTab", exportTab);
      api.app.renderPanel();
    });
    tabs.appendChild(b);
    tabBtns.push(b);
  }
  card.appendChild(tabs);
  let actionBtn: HTMLButtonElement | null = null;
  const fmtBtns: HTMLButtonElement[] = [];
  if (exportTab === "png") {
    actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "pbtn";
    actionBtn.id = "export-png-btn";
    actionBtn.textContent = "Export PNG";
    actionBtn.addEventListener("click", () => { void exportPNGSequence(); });
    card.appendChild(actionBtn);
  } else {
    // Video format: the small segmented control above the action
    // button. The choice persists (plugin storage).
    const fmtSeg = document.createElement("div");
    fmtSeg.className = "seg";
    fmtSeg.id = "video-format-seg";
    fmtSeg.setAttribute("role", "group");
    fmtSeg.setAttribute("aria-label", "Video format");
    for (const f of [{ id: "gif", label: "GIF" }, { id: "webm", label: "WebM" }, { id: "mp4", label: "MP4" }] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = videoFormat === f.id ? "active" : "";
      b.textContent = f.label;
      b.setAttribute("aria-label", `Video format ${f.label}`);
      b.addEventListener("click", () => {
        if (videoFormat === f.id) return;
        videoFormat = f.id;
        api.storage.set("videoFormat", videoFormat);
        api.app.renderPanel();
      });
      fmtSeg.appendChild(b);
      fmtBtns.push(b);
    }
    card.appendChild(fmtSeg);
    actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "pbtn";
    actionBtn.id = "export-video-btn";
    actionBtn.textContent = `Export ${videoFormat === "gif" ? "GIF" : videoFormat === "webm" ? "WebM" : "MP4"}`;
    actionBtn.addEventListener("click", () => { void exportVideo(); });
    card.appendChild(actionBtn);
  }
  if (exporting) {
    for (const b of tabBtns) b.disabled = true;
    for (const b of fmtBtns) b.disabled = true;
    if (actionBtn) actionBtn.disabled = true;
    // An offline export (PNG sequence, GIF, WebM, MP4) shows its
    // progress on the action button.
    if (exportProgress && actionBtn) actionBtn.textContent = exportProgress.text;
  }
  return card;
}

// The Export dropdown: the card in a frosted popover anchored below
// the Export button, like the Add behavior picker. Fixed-position so
// it floats above the panel content and never pushes it down; flips
// above the button when there is no room below. Rebuilt from scratch
// on every call (the core re-renders open overlays after each panel
// render, and the anchor button is rebuilt each time).
function renderExportDropdown(anchorBtn: HTMLElement | null): void {
  closeExportDropdownEl();
  if (!anchorBtn) return;
  const pop = document.createElement("div");
  pop.className = "export-dropdown";
  pop.setAttribute("role", "menu");
  pop.appendChild(renderExportCard());
  document.body.appendChild(pop);
  const r = anchorBtn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const top = (r.bottom + 6 + h > window.innerHeight) ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

async function exportPNGSequence(): Promise<void> {
  const a = api;
  if (exporting) return;
  const dir = await a.files.pickSequenceFolder();
  if (!dir) return; // user cancelled the folder dialog (or no Electron bridge)
  exporting = true;
  exportProgress = null;
  a.app.renderPanel();
  try {
    const { w, h } = a.app.getStageSize();
    const { frames } = exportSchedule();
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d")!;
    for (let i = 0; i < frames.length; i++) {
      a.app.renderFrameAt(frames[i].frameIndex, frames[i].t01, octx, 1);
      const dataUrl = off.toDataURL("image/png");
      await a.files.writeSequenceFile(dir, `frame-${String(i + 1).padStart(4, "0")}.png`, dataUrl);
      setExportProgress(`Exporting ${i + 1}/${frames.length}`, "png");
    }
  } finally {
    exporting = false;
    exportProgress = null;
    a.app.renderPanel();
  }
}

// The export schedule: what each exported image is. A one-frame
// timeline falls back to the behaviour loop (round(L*30) images at
// 30fps, as before); a multi-frame timeline exports one image per
// timeline frame at the timeline's fps, held frames repeating their
// image, with behaviours superposed at the timeline position when the
// Behaviours plugin is on (t01 = k/total) and pure frames when it is
// off (the motion provider is gone, so t01 reads as rest). `time` is
// the image's timestamp in the video, `step` the seconds per image.
type ExportFrame = { frameIndex: number; t01: number; time: number };
function exportSchedule(): { frames: ExportFrame[]; step: number } {
  const tl = api.doc.getTimeline();
  if (tl.frames.length <= 1) {
    const n = api.app.frameCount();
    const frames: ExportFrame[] = [];
    for (let i = 0; i < n; i++) frames.push({ frameIndex: 0, t01: i / n, time: i / 30 });
    return { frames, step: 1 / 30 };
  }
  const total = tl.frames.reduce((n, f) => n + f.duration, 0);
  const frames: ExportFrame[] = [];
  let k = 0;
  for (let fi = 0; fi < tl.frames.length; fi++) {
    for (let d = 0; d < tl.frames[fi].duration; d++) {
      frames.push({ frameIndex: fi, t01: k / total, time: k / tl.fps });
      k++;
    }
  }
  return { frames, step: 1 / tl.fps };
}

// Video export: GIF, WebM or MP4, one full loop at 30fps, stage size,
// artwork only. The format is picked in the Actions area; no other
// parameters.
async function exportVideo(): Promise<void> {
  if (exporting) return;
  if (videoFormat === "gif") { await exportGIF(); return; }
  if (videoFormat === "mp4") { await exportMP4(); return; }
  await exportWebM();
}

// GIF: animated, looping forever. Frames render offline the same way as
// the PNG sequence; gifenc quantizes each frame to a 256-colour palette.
// GIF delays are stored in 10ms units, so the per-frame delay alternates
// to average exactly the step (30/40ms at 30fps, 80/90ms at 12fps).
async function exportGIF(): Promise<void> {
  const a = api;
  exporting = true;
  a.app.renderPanel();
  try {
    const { w, h } = a.app.getStageSize();
    const { frames, step } = exportSchedule();
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d")!;
    const gif = GIFEncoder();
    for (let i = 0; i < frames.length; i++) {
      a.app.renderFrameAt(frames[i].frameIndex, frames[i].t01, octx, 1);
      const img = octx.getImageData(0, 0, w, h);
      const palette = quantize(img.data, 256);
      const index = applyPalette(img.data, palette);
      const delay = Math.round((i + 1) * step * 100) - Math.round(i * step * 100);
      gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
      setExportProgress(`Exporting ${i + 1}/${frames.length}`, "video");
      // The encode loop never yielded, so no live progress was
      // observable and the UI did not repaint until the file was
      // done. One macrotask per frame lets the button repaint.
      await new Promise((r) => setTimeout(r, 0));
    }
    gif.finish();
    a.files.download(new Blob([gif.bytes() as BlobPart], { type: "image/gif" }), "manakin.gif");
  } finally {
    exporting = false;
    exportProgress = null;
    a.app.renderPanel();
  }
}

// MP4: H.264 via WebCodecs (VideoEncoder) + Mediabunny, both JS-only.
// Chromium cannot do this with MediaRecorder. If this build has no
// H.264 encoder, isConfigSupported says so and nothing is exported.
// Frames render offline to an offscreen canvas at stage size, one per
// schedule step, so the frame count and the duration follow the
// schedule — the behaviour loop at 30fps, or the timeline at its fps.
async function exportMP4(): Promise<void> {
  const a = api;
  if (typeof VideoEncoder === "undefined") return;
  const { w, h } = a.app.getStageSize();
  const config: VideoEncoderConfig = {
    codec: "avc1.42001f", width: w, height: h,
    bitrate: 8_000_000, framerate: 30, avc: { format: "avc" },
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) return;
  exporting = true;
  a.app.renderPanel();
  try {
    const { frames, step } = exportSchedule();
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d")!;
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    const source = new CanvasSource(off, { codec: "avc", bitrate: 8_000_000 });
    output.addVideoTrack(source);
    await output.start();
    for (let i = 0; i < frames.length; i++) {
      a.app.renderFrameAt(frames[i].frameIndex, frames[i].t01, octx, 1);
      // CanvasSource snapshots the canvas synchronously (new
      // VideoFrame), so the next render cannot corrupt this frame.
      await source.add(frames[i].time, step);
      setExportProgress(`Exporting ${i + 1}/${frames.length}`, "video");
    }
    await output.finalize();
    const buf = target.buffer;
    if (!buf) return;
    a.files.download(new Blob([buf], { type: "video/mp4" }), "manakin.mp4");
  } finally {
    exporting = false;
    exportProgress = null;
    a.app.renderPanel();
  }
}

// WebM: VP9 via WebCodecs (VideoEncoder) + Mediabunny, rendered
// offline like PNG/GIF/MP4 — one frame per schedule step, so the frame
// count follows the schedule (round(L*30) for the behaviour loop, the
// timeline's frame count at its fps). The old path recorded an
// offscreen canvas in real time through MediaRecorder, so the frame
// count followed the machine's rAF rate (119 clean, 26 under CPU load,
// 171 in a 6s run) instead of the frame schedule. Mediabunny's default
// 'quality' latency mode never drops frames; the old 'realtime'
// behaviour is what lost them.
async function exportWebM(): Promise<void> {
  const a = api;
  if (exporting) return;
  if (typeof VideoEncoder === "undefined") return;
  const { w, h } = a.app.getStageSize();
  const support = await VideoEncoder.isConfigSupported({
    codec: "vp09.00.10.08", width: w, height: h,
    bitrate: 8_000_000, framerate: 30,
  });
  if (!support.supported) return;
  exporting = true;
  a.app.renderPanel();
  try {
    const { frames, step } = exportSchedule();
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d")!;
    const target = new BufferTarget();
    const output = new Output({
      format: new WebMOutputFormat(),
      target,
    });
    const source = new CanvasSource(off, { codec: "vp9", bitrate: 8_000_000 });
    output.addVideoTrack(source);
    await output.start();
    for (let i = 0; i < frames.length; i++) {
      a.app.renderFrameAt(frames[i].frameIndex, frames[i].t01, octx, 1);
      // CanvasSource snapshots the canvas synchronously (new
      // VideoFrame), so the next render cannot corrupt this frame.
      await source.add(frames[i].time, step);
      setExportProgress(`Exporting ${i + 1}/${frames.length}`, "video");
    }
    await output.finalize();
    const buf = target.buffer;
    if (!buf) return;
    a.files.download(new Blob([buf], { type: "video/webm" }), "manakin.webm");
  } finally {
    exporting = false;
    exportProgress = null;
    a.app.renderPanel();
  }
}

export function activate(pluginApi: PluginContext): void {
  api = pluginApi;
  // One-time seed from the core save's legacy values (exportTab /
  // videoFormat used to live in manakin-v1): a user who had picked a
  // format keeps it; a fresh install starts on the defaults.
  const storedTab = pluginApi.storage.get("exportTab");
  if (storedTab === undefined && (pluginApi.legacy.exportTab === "png" || pluginApi.legacy.exportTab === "video")) {
    exportTab = pluginApi.legacy.exportTab;
    pluginApi.storage.set("exportTab", exportTab);
  } else if (storedTab === "png" || storedTab === "video") {
    exportTab = storedTab;
  }
  const storedFmt = pluginApi.storage.get("videoFormat");
  if (storedFmt === undefined && (pluginApi.legacy.videoFormat === "gif" || pluginApi.legacy.videoFormat === "webm" || pluginApi.legacy.videoFormat === "mp4")) {
    videoFormat = pluginApi.legacy.videoFormat;
    pluginApi.storage.set("videoFormat", videoFormat);
  } else if (storedFmt === "gif" || storedFmt === "webm" || storedFmt === "mp4") {
    videoFormat = storedFmt;
  }
  pluginApi.ui.registerAction({
    id: "export",
    label: "Export",
    chevron: true,
    onClick: () => {
      exportDropdownOpen = !exportDropdownOpen;
      pluginApi.app.renderPanel();
    },
  });
  pluginApi.ui.registerOverlay({
    id: "export-dropdown",
    actionId: "export",
    isOpen: () => exportDropdownOpen,
    render: (anchor) => renderExportDropdown(anchor),
    close: () => {
      exportDropdownOpen = false;
      closeExportDropdownEl();
    },
    contains: (t) => {
      const btn = pluginApi.ui.getActionButton("export");
      // closest() walks detached ancestors too: a tab click rebuilds
      // the panel — and the dropdown — under its own handler, so by
      // the time the event bubbles to the document its target is
      // detached from the live dropdown. A live contains() alone
      // would miss it, and the document handler would close the
      // dropdown the tab click just rebuilt.
      return t.closest(".export-dropdown") !== null || (btn?.contains(t) ?? false);
    },
  });
}

export const plugin: PluginModule = { manifest, activate };

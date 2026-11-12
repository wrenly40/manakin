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

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource } from 'mediabunny';
import type { PluginContext, PluginModule } from '../plugins';

export const manifest = {
  id: 'exports',
  name: 'Exports',
  version: '1.0.0',
  apiVersion: '1',
  description: 'PNG sequence and GIF / WebM / MP4 video export, with the Export dropdown.',
  permissions: ['export', 'ui', 'storage'],
  contributions: {
    actions: [{ id: 'export', label: 'Export' }],
    overlays: [{ id: 'export-dropdown' }],
  },
};

type ExportTab = 'png' | 'video';
type VideoFormat = 'gif' | 'webm' | 'mp4';

let api: PluginContext | null = null;
let exporting = false; // an export (PNG sequence or video) is running right now
let exportTab: ExportTab = 'png';
let videoFormat: VideoFormat = 'webm';
let exportProgress: { text: string; target: ExportTab } | null = null;
let exportDropdownOpen = false; // the Export dropdown (card in a popover) is showing

function ctx(): PluginContext {
  if (!api) throw new Error('Exports plugin is not active');
  return api;
}

// "Exporting 45/120" while an offline export runs, on the button doing it.
function setExportProgress(text: string, target: ExportTab): void {
  exportProgress = { text, target };
  const b = document.getElementById(target === 'png' ? 'export-png-btn' : 'export-video-btn');
  if (b) b.textContent = text;
}

function closeExportDropdownEl(): void {
  document.querySelector('.export-dropdown')?.remove();
}

// The Export card itself: PNG and Video are tabs at its top, the
// active tab's content sits below them. No Scale, no Frame. Built
// fresh on every render, so tab switches and format picks re-render
// through renderPanel.
function renderExportCard(): HTMLDivElement {
  const card = document.createElement('div');
  card.id = 'export-card';
  const tabs = document.createElement('div');
  tabs.className = 'seg';
  tabs.id = 'export-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Export');
  const tabBtns: HTMLButtonElement[] = [];
  for (const t of [{ id: 'png', label: 'PNG' }, { id: 'video', label: 'Video' }] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = exportTab === t.id ? 'active' : '';
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', exportTab === t.id ? 'true' : 'false');
    b.addEventListener('click', () => {
      if (exportTab === t.id) return;
      exportTab = t.id;
      ctx().storage.set('exportTab', exportTab);
      ctx().app.renderPanel();
    });
    tabs.appendChild(b);
    tabBtns.push(b);
  }
  card.appendChild(tabs);
  let actionBtn: HTMLButtonElement | null = null;
  const fmtBtns: HTMLButtonElement[] = [];
  if (exportTab === 'png') {
    actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'pbtn';
    actionBtn.id = 'export-png-btn';
    actionBtn.textContent = 'Export PNG';
    actionBtn.addEventListener('click', () => { void exportPNGSequence(); });
    card.appendChild(actionBtn);
  } else {
    // Video format: the small segmented control above the action
    // button. The choice persists (plugin storage).
    const fmtSeg = document.createElement('div');
    fmtSeg.className = 'seg';
    fmtSeg.id = 'video-format-seg';
    fmtSeg.setAttribute('role', 'group');
    fmtSeg.setAttribute('aria-label', 'Video format');
    for (const f of [{ id: 'gif', label: 'GIF' }, { id: 'webm', label: 'WebM' }, { id: 'mp4', label: 'MP4' }] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = videoFormat === f.id ? 'active' : '';
      b.textContent = f.label;
      b.setAttribute('aria-label', `Video format ${f.label}`);
      b.addEventListener('click', () => {
        if (videoFormat === f.id) return;
        videoFormat = f.id;
        ctx().storage.set('videoFormat', videoFormat);
        ctx().app.renderPanel();
      });
      fmtSeg.appendChild(b);
      fmtBtns.push(b);
    }
    card.appendChild(fmtSeg);
    actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'pbtn';
    actionBtn.id = 'export-video-btn';
    actionBtn.textContent = `Export ${videoFormat === 'gif' ? 'GIF' : videoFormat === 'webm' ? 'WebM' : 'MP4'}`;
    actionBtn.addEventListener('click', () => { void exportVideo(); });
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
  const pop = document.createElement('div');
  pop.className = 'export-dropdown';
  pop.setAttribute('role', 'menu');
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
  const a = ctx();
  if (exporting) return;
  const dir = await a.files.pickSequenceFolder();
  if (!dir) return; // user cancelled the folder dialog (or no Electron bridge)
  exporting = true;
  exportProgress = null;
  a.app.renderPanel();
  try {
    const { w, h } = a.app.getStageSize();
    const n = a.app.frameCount();
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    for (let i = 0; i < n; i++) {
      a.app.renderFrame(i / n, octx, 1);
      const dataUrl = off.toDataURL('image/png');
      await a.files.writeSequenceFile(dir, `frame-${String(i + 1).padStart(4, '0')}.png`, dataUrl);
      setExportProgress(`Exporting ${i + 1}/${n}`, 'png');
    }
  } finally {
    exporting = false;
    exportProgress = null;
    a.app.renderPanel();
  }
}

// Video export: GIF, WebM or MP4, one full loop at 30fps, stage size,
// artwork only. The format is picked in the Actions area; no other
// parameters.
async function exportVideo(): Promise<void> {
  if (exporting) return;
  if (videoFormat === 'gif') { await exportGIF(); return; }
  if (videoFormat === 'mp4') { await exportMP4(); return; }
  await exportWebM();
}

// GIF: animated, looping forever. Frames render offline the same way as
// the PNG sequence; gifenc quantizes each frame to a 256-colour palette.
// GIF delays are stored in 10ms units, so the per-frame delay alternates
// 30/40ms to average exactly 1/30s.
async function exportGIF(): Promise<void> {
  const a = ctx();
  exporting = true;
  a.app.renderPanel();
  try {
    const { w, h } = a.app.getStageSize();
    const n = a.app.frameCount();
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    const gif = GIFEncoder();
    for (let i = 0; i < n; i++) {
      a.app.renderFrame(i / n, octx, 1);
      const img = octx.getImageData(0, 0, w, h);
      const palette = quantize(img.data, 256);
      const index = applyPalette(img.data, palette);
      const delay = (Math.round(((i + 1) * 10) / 3) - Math.round((i * 10) / 3)) * 10;
      gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
      setExportProgress(`Exporting ${i + 1}/${n}`, 'video');
      // The encode loop never yielded, so no live progress was
      // observable and the UI did not repaint until the file was
      // done. One macrotask per frame lets the button repaint.
      await new Promise((r) => setTimeout(r, 0));
    }
    gif.finish();
    a.files.download(new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }), 'manakin.gif');
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
// 1/30s step, so the frame count is exactly round(L*30) and the
// duration is exactly L — the same offline path as PNG/GIF.
async function exportMP4(): Promise<void> {
  const a = ctx();
  if (typeof VideoEncoder === 'undefined') return;
  const { w, h } = a.app.getStageSize();
  const config: VideoEncoderConfig = {
    codec: 'avc1.42001f', width: w, height: h,
    bitrate: 8_000_000, framerate: 30, avc: { format: 'avc' },
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) return;
  exporting = true;
  a.app.renderPanel();
  try {
    const n = a.app.frameCount();
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    const source = new CanvasSource(off, { codec: 'avc', bitrate: 8_000_000 });
    output.addVideoTrack(source);
    await output.start();
    for (let i = 0; i < n; i++) {
      a.app.renderFrame(i / n, octx, 1);
      // CanvasSource snapshots the canvas synchronously (new
      // VideoFrame), so the next render cannot corrupt this frame.
      await source.add(i / 30, 1 / 30);
      setExportProgress(`Exporting ${i + 1}/${n}`, 'video');
    }
    await output.finalize();
    const buf = target.buffer;
    if (!buf) return;
    a.files.download(new Blob([buf], { type: 'video/mp4' }), 'manakin.mp4');
  } finally {
    exporting = false;
    exportProgress = null;
    a.app.renderPanel();
  }
}

// WebM: VP9 via WebCodecs (VideoEncoder) + Mediabunny, rendered
// offline like PNG/GIF/MP4 — one frame per 1/30s step, so the frame
// count is exactly round(L*30) and the duration is exactly L. The
// old path recorded an offscreen canvas in real time through
// MediaRecorder, so the frame count followed the machine's rAF rate
// (119 clean, 26 under CPU load, 171 in a 6s run) instead of the
// frame schedule. Mediabunny's default 'quality' latency mode never
// drops frames; the old 'realtime' behaviour is what lost them.
async function exportWebM(): Promise<void> {
  const a = ctx();
  if (exporting) return;
  if (typeof VideoEncoder === 'undefined') return;
  const { w, h } = a.app.getStageSize();
  const support = await VideoEncoder.isConfigSupported({
    codec: 'vp09.00.10.08', width: w, height: h,
    bitrate: 8_000_000, framerate: 30,
  });
  if (!support.supported) return;
  exporting = true;
  a.app.renderPanel();
  try {
    const n = a.app.frameCount();
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    const target = new BufferTarget();
    const output = new Output({
      format: new WebMOutputFormat(),
      target,
    });
    const source = new CanvasSource(off, { codec: 'vp9', bitrate: 8_000_000 });
    output.addVideoTrack(source);
    await output.start();
    for (let i = 0; i < n; i++) {
      a.app.renderFrame(i / n, octx, 1);
      // CanvasSource snapshots the canvas synchronously (new
      // VideoFrame), so the next render cannot corrupt this frame.
      await source.add(i / 30, 1 / 30);
      setExportProgress(`Exporting ${i + 1}/${n}`, 'video');
    }
    await output.finalize();
    const buf = target.buffer;
    if (!buf) return;
    a.files.download(new Blob([buf], { type: 'video/webm' }), 'manakin.webm');
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
  const storedTab = pluginApi.storage.get('exportTab');
  if (storedTab === undefined && (pluginApi.legacy.exportTab === 'png' || pluginApi.legacy.exportTab === 'video')) {
    exportTab = pluginApi.legacy.exportTab;
    pluginApi.storage.set('exportTab', exportTab);
  } else if (storedTab === 'png' || storedTab === 'video') {
    exportTab = storedTab;
  }
  const storedFmt = pluginApi.storage.get('videoFormat');
  if (storedFmt === undefined && (pluginApi.legacy.videoFormat === 'gif' || pluginApi.legacy.videoFormat === 'webm' || pluginApi.legacy.videoFormat === 'mp4')) {
    videoFormat = pluginApi.legacy.videoFormat;
    pluginApi.storage.set('videoFormat', videoFormat);
  } else if (storedFmt === 'gif' || storedFmt === 'webm' || storedFmt === 'mp4') {
    videoFormat = storedFmt;
  }
  pluginApi.ui.registerAction({
    id: 'export',
    label: 'Export',
    chevron: true,
    onClick: () => {
      exportDropdownOpen = !exportDropdownOpen;
      pluginApi.app.renderPanel();
    },
  });
  pluginApi.ui.registerOverlay({
    id: 'export-dropdown',
    actionId: 'export',
    isOpen: () => exportDropdownOpen,
    render: (anchor) => renderExportDropdown(anchor),
    close: () => {
      exportDropdownOpen = false;
      closeExportDropdownEl();
    },
    contains: (t) => {
      const btn = pluginApi.ui.getActionButton('export');
      // closest() walks detached ancestors too: a tab click rebuilds
      // the panel — and the dropdown — under its own handler, so by
      // the time the event bubbles to the document its target is
      // detached from the live dropdown. A live contains() alone
      // would miss it, and the document handler would close the
      // dropdown the tab click just rebuilt.
      return t.closest('.export-dropdown') !== null || (btn?.contains(t) ?? false);
    },
  });
}

export const plugin: PluginModule = { manifest, activate };

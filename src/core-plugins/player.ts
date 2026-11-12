// Player — the bottom bar (Manakin Plugin API v1).
//
// Owns the bottom bar: the transport (Back / Play / Stop / Forward),
// the timeline (progress fill and clock), and the zoom cluster (bare
// - / label / + glyphs, with the angle readout alone at the far left
// while rotated). The Loop setting itself stays in the Canvas panel
// (core); the player shows the loop length in its clock total.
//
// The frame loop lives here: every animation frame it advances the
// clock through api.transport.tick and asks the canvas to render
// through api.canvas.requestRender (a no-op when the canvas plugin
// is disabled, so the clock keeps ticking over an empty stage).
// Transport and zoom changes go through api.transport / api.view,
// which emit "transport" / "view" — this plugin updates its labels
// from those events, never from a direct call elsewhere.

import type { PluginContext, PluginModule } from "../plugins";

export const manifest = {
  id: "core-player",
  name: "Player",
  version: "1.0.0",
  apiVersion: "1",
  description: "The bottom bar: transport, timeline, clock, zoom.",
  permissions: ["doc", "view", "transport", "canvas", "shell", "events", "ui"],
};

let api!: PluginContext;
let playerEl!: HTMLElement;
let playBtn!: HTMLButtonElement;
let backBtn!: HTMLButtonElement;
let stopBtn!: HTMLButtonElement;
let forwardBtn!: HTMLButtonElement;
let progressFill!: HTMLElement;
let timeState!: HTMLElement;
let zoomLabel!: HTMLButtonElement;
let zoomOutBtn!: HTMLButtonElement;
let zoomInBtn!: HTMLButtonElement;
let raf = 0;
let loopRunning = false;

const PLAY_ICON = "<svg viewBox=\"0 0 12 12\"><path d=\"M3 1.5 10 6l-7 4.5z\"/></svg>";
const PAUSE_ICON = "<svg viewBox=\"0 0 12 12\"><path d=\"M2.5 2h2.6v8H2.5zM6.9 2h2.6v8H6.9z\"/></svg>";

// Zoom and angle are separate readouts: the label shows only the
// zoom; the angle lives alone at the far left of the bar as plain
// text, and exists in the DOM only while rotated. The rounded angle
// wraps (359.6° reads as 0°, not 360°).
function updateZoomLabel(): void {
  const d = Math.round(api.view.getRotate()) % 360;
  zoomLabel.textContent = `${Math.round(api.view.getZoom() * 100)}%`;
  let angle = playerEl.querySelector<HTMLElement>("#angle-readout");
  if (d === 0) {
    angle?.remove();
    return;
  }
  if (!angle) {
    angle = document.createElement("span");
    angle.id = "angle-readout";
    playerEl.prepend(angle);
  }
  angle.textContent = `${d}°`;
}

function setPlayLabel(): void {
  const playing = api.transport.isPlaying();
  playBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  playBtn.classList.toggle("playing", playing);
  playBtn.title = playing ? "Pause" : "Play";
  playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function frame(ts: number): void {
  if (!loopRunning) return;
  // One bad frame must not kill the loop: a render error is logged
  // and the next frame is still scheduled. (A permission or renderer
  // failure shows up as a blank canvas and a console error, not as a
  // dead tab — the loop keeps asking for frames.)
  try {
    const t01 = api.transport.tick(ts);
    api.canvas.requestRender(t01);
    progressFill.style.width = `${(t01 * 100).toFixed(1)}%`;
    // The clock reads the frame as well as seconds on a multi-frame
    // timeline; a single frame keeps the old seconds-only reading.
    const frames = api.doc.getTimeline().frames.length;
    const sec = `${(api.transport.getPlayTime() / 1000).toFixed(1)} / ${(api.app.getLoopMs() / 1000).toFixed(1)}s`;
    timeState.textContent = frames > 1 ? `${api.doc.getCurrentFrame() + 1}/${frames} · ${sec}` : sec;
  } catch (e) {
    console.error("[manakin] player frame failed:", e);
  }
  raf = requestAnimationFrame(frame);
}

export function activate(a: PluginContext): void {
  api = a;
  playerEl = api.shell.player;
  playerEl.innerHTML = `
<div id="player-row">
  <button id="back-btn" class="pctl solid" title="Back" aria-label="Back to start"><svg viewBox="0 0 24 24"><path d="M6 5h2.5v14H6z"/><path d="M20 5v14l-9.5-7z"/></svg></button>
  <button id="play-btn" class="pctl" title="Play" aria-label="Play"><svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg></button>
  <button id="stop-btn" class="pctl solid" title="Stop" aria-label="Stop"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
  <button id="forward-btn" class="pctl solid" title="Forward" aria-label="Forward to end"><svg viewBox="0 0 24 24"><path d="M15.5 5h2.5v14h-2.5z"/><path d="M4 5v14l9.5-7z"/></svg></button>
</div>
<div id="timeline-row">
  <div id="progress-track" aria-hidden="true"><div id="progress-fill"></div></div>
  <span id="time-state">0.0 / 4.0s</span>
</div>
<div id="zoom-control" aria-label="Zoom">
  <button id="zoom-out" class="zctl" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
  <button id="zoom-label" class="zoom-label" aria-label="Zoom level, activate to reset zoom to 100%">100%</button>
  <button id="zoom-in" class="zctl" aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
</div>`;
  playBtn = playerEl.querySelector("#play-btn") as HTMLButtonElement;
  backBtn = playerEl.querySelector("#back-btn") as HTMLButtonElement;
  stopBtn = playerEl.querySelector("#stop-btn") as HTMLButtonElement;
  forwardBtn = playerEl.querySelector("#forward-btn") as HTMLButtonElement;
  progressFill = playerEl.querySelector("#progress-fill") as HTMLElement;
  timeState = playerEl.querySelector("#time-state") as HTMLElement;
  zoomLabel = playerEl.querySelector("#zoom-label") as HTMLButtonElement;
  zoomOutBtn = playerEl.querySelector("#zoom-out") as HTMLButtonElement;
  zoomInBtn = playerEl.querySelector("#zoom-in") as HTMLButtonElement;
  playBtn.addEventListener("click", () => {
    if (api.transport.isPlaying()) api.transport.pause();
    else api.transport.play();
  });
  backBtn.addEventListener("click", () => {
    api.transport.back();
  });
  stopBtn.addEventListener("click", () => {
    api.transport.stop();
  });
  forwardBtn.addEventListener("click", () => {
    api.transport.forward();
  });
  zoomInBtn.addEventListener("click", () => api.view.zoomStep(1));
  zoomOutBtn.addEventListener("click", () => api.view.zoomStep(-1));
  zoomLabel.addEventListener("click", () => api.view.resetZoom());
  // Same shared tooltip as the Arrange/Align buttons; the label cell
  // gets none (its reset action is already known).
  api.ui.attachTooltip(zoomOutBtn, "Zoom out");
  api.ui.attachTooltip(zoomInBtn, "Zoom in");
  api.events.on("view", updateZoomLabel);
  api.events.on("transport", setPlayLabel);
  updateZoomLabel();
  setPlayLabel();
  loopRunning = true;
  raf = requestAnimationFrame(frame);
}

export function deactivate(): void {
  loopRunning = false;
  cancelAnimationFrame(raf);
  api.events.off("view", updateZoomLabel);
  api.events.off("transport", setPlayLabel);
  playerEl.innerHTML = "";
}

export const plugin: PluginModule = { manifest, activate, deactivate };

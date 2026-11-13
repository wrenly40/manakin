// Player: the bottom bar — transport, clock, zoom.
// Playback runs at FPS through the timeline; reaching the end stops.
import { FPS, ZOOM_STOPS, timelineLength } from "./model";
import type { Store } from "./store";

export function createPlayer(barEl: HTMLElement, store: Store): void {
  barEl.innerHTML = `
    <div id="player-left"><span id="angle-readout"></span></div>
    <div id="player-centre">
      <div id="transport">
        <button id="back-btn" class="pctl solid" title="Back" aria-label="Back to start"><svg viewBox="0 0 24 24"><path d="M6 5h2.5v14H6z"/><path d="M20 5v14l-9.5-7z"/></svg></button>
        <button id="play-btn" class="pctl play" title="Play" aria-label="Play"><svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg></button>
        <button id="stop-btn" class="pctl solid" title="Stop" aria-label="Stop"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
        <button id="forward-btn" class="pctl solid" title="Forward" aria-label="Forward to end"><svg viewBox="0 0 24 24"><path d="M15.5 5h2.5v14h-2.5z"/><path d="M4 5v14l9.5-7z"/></svg></button>
      </div>
      <span id="clock">1/1 · 0.0s</span>
    </div>
    <div id="player-right">
      <button id="zoom-out" class="zctl" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
      <button id="zoom-label" class="zoom-label" title="Reset zoom" aria-label="Zoom level, activate to reset zoom to 100%">100%</button>
      <button id="zoom-in" class="zctl" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>`;

  const playBtn = barEl.querySelector("#play-btn") as HTMLButtonElement;
  const backBtn = barEl.querySelector("#back-btn") as HTMLButtonElement;
  const stopBtn = barEl.querySelector("#stop-btn") as HTMLButtonElement;
  const forwardBtn = barEl.querySelector("#forward-btn") as HTMLButtonElement;
  const clockEl = barEl.querySelector("#clock") as HTMLSpanElement;
  const angleEl = barEl.querySelector("#angle-readout") as HTMLSpanElement;
  const zoomOut = barEl.querySelector("#zoom-out") as HTMLButtonElement;
  const zoomIn = barEl.querySelector("#zoom-in") as HTMLButtonElement;
  const zoomLabel = barEl.querySelector("#zoom-label") as HTMLButtonElement;

  backBtn.addEventListener("click", () => store.back());
  stopBtn.addEventListener("click", () => store.stop());
  forwardBtn.addEventListener("click", () => store.forward());
  playBtn.addEventListener("click", () => store.playToggle());
  zoomOut.addEventListener("click", () => zoomStep(-1));
  zoomIn.addEventListener("click", () => zoomStep(1));
  zoomLabel.addEventListener("click", () => store.resetZoom());

  function zoomStep(dir: number): void {
    const i = ZOOM_STOPS.indexOf(store.view.zoom);
    const at = i < 0 ? ZOOM_STOPS.indexOf(1) : i;
    store.setView({ zoom: ZOOM_STOPS[Math.min(ZOOM_STOPS.length - 1, Math.max(0, at + dir))] });
  }

  // Playback: an accumulator advances the playhead at FPS; the end stops.
  let lastTs = 0;
  let acc = 0;
  function tick(ts: number): void {
    requestAnimationFrame(tick);
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!store.playing) return;
    acc += dt;
    const step = 1 / FPS;
    let advanced = false;
    while (acc >= step) {
      acc -= step;
      const len = timelineLength(store.doc);
      if (store.pos + 1 >= len) {
        store.setPlaying(false);
        store.setPos(len - 1);
        acc = 0;
        return;
      }
      store.setPos(store.pos + 1);
      advanced = true;
    }
    void advanced;
  }
  requestAnimationFrame(tick);

  function sync(): void {
    const len = timelineLength(store.doc);
    const pos = Math.min(store.pos, len - 1);
    playBtn.title = store.playing ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", store.playing ? "Pause" : "Play");
    playBtn.innerHTML = store.playing
      ? `<svg viewBox="0 0 12 12"><rect x="2" y="1.5" width="3" height="9" rx="0.5"/><rect x="7" y="1.5" width="3" height="9" rx="0.5"/></svg>`
      : `<svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg>`;
    clockEl.textContent = `${pos + 1}/${len} · ${(pos / FPS).toFixed(1)}s`;
    angleEl.textContent = store.view.rotateDeg !== 0 ? `${Math.round(store.view.rotateDeg)}°` : "";
    zoomLabel.textContent = `${Math.round(store.view.zoom * 100)}%`;
  }

  store.onChange(sync);
  sync();
}

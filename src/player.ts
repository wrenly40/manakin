// Player: the bottom bar — transport, clock, zoom.
// Playback runs at the document's fps through the timeline;
// reaching the end stops.
import { ZOOM_STOPS, timelineLength } from "./model";
import type { Store } from "./store";

export function createPlayer(barEl: HTMLElement, store: Store): void {
  barEl.innerHTML = `
    <div id="player-left"><span id="angle-readout"></span></div>
    <div id="player-centre">
      <div id="transport">
        <button id="back-btn" class="pctl solid" title="Previous frame" aria-label="Previous frame"><svg viewBox="0 0 24 24"><path d="M6 5h2.5v14H6z"/><path d="M20 5v14l-9.5-7z"/></svg></button>
        <button id="play-btn" class="pctl play" title="Play" aria-label="Play"><svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg></button>
        <button id="stop-btn" class="pctl solid" title="Stop" aria-label="Stop"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
        <button id="forward-btn" class="pctl solid" title="Next frame" aria-label="Next frame"><svg viewBox="0 0 24 24"><path d="M15.5 5h2.5v14h-2.5z"/><path d="M4 5v14l9.5-7z"/></svg></button>
        <button id="loop-btn" class="pctl" title="Loop" aria-label="Loop" aria-pressed="false"><svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></button>
        <button id="onion-btn" class="pctl" title="Onion skin" aria-label="Onion skin" aria-pressed="true"><svg viewBox="0 0 24 24"><path d="M5 11a7 7 0 0 1 14 0v8a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3a1 1 0 0 0-2 0v3a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3a1 1 0 0 0-2 0v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 10h.01"/><path d="M15 10h.01"/></svg></button>
        <span id="clock"><span id="clock-pos">1/1 · 0.0s</span> · <span id="fps-value" class="fps-value" tabindex="0" role="slider" aria-label="Frame rate" aria-valuemin="1" aria-valuemax="60" aria-valuenow="12" title="Frame rate — drag to change">12 fps</span></span>
      </div>
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
  const loopBtn = barEl.querySelector("#loop-btn") as HTMLButtonElement;
  const onionBtn = barEl.querySelector("#onion-btn") as HTMLButtonElement;
  const clockEl = barEl.querySelector("#clock") as HTMLSpanElement;
  const clockPosEl = barEl.querySelector("#clock-pos") as HTMLSpanElement;
  const fpsEl = barEl.querySelector("#fps-value") as HTMLSpanElement;
  const angleEl = barEl.querySelector("#angle-readout") as HTMLSpanElement;
  const zoomOut = barEl.querySelector("#zoom-out") as HTMLButtonElement;
  const zoomIn = barEl.querySelector("#zoom-in") as HTMLButtonElement;
  const zoomLabel = barEl.querySelector("#zoom-label") as HTMLButtonElement;

  backBtn.addEventListener("click", () => store.back());
  stopBtn.addEventListener("click", () => store.stop());
  forwardBtn.addEventListener("click", () => store.forward());
  loopBtn.addEventListener("click", () => store.toggleLoop());
  onionBtn.addEventListener("click", () => store.toggleOnionSkin());
  playBtn.addEventListener("click", () => store.playToggle());
  zoomOut.addEventListener("click", () => zoomStep(-1));
  zoomIn.addEventListener("click", () => zoomStep(1));
  zoomLabel.addEventListener("click", () => store.resetZoom());

  // The frame rate is a draggable value in the clock, like the
  // opacity draggable %: drag horizontally, 1 fps per 2px, one undo
  // step per drag (the begin/preview/end pattern). A stepper would
  // add two more buttons to the transport; the value sits in the
  // clock's own line, so dragging it reads as part of the readout.
  // Arrow keys adjust by 1 (Shift: 10). The value is read from the
  // store at drag start, not the closure — undo replaces store.doc
  // with a clone, so a closed-over fps would go stale.
  fpsEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startFps = store.doc.fps ?? 12;
    store.beginFpsDrag();
    const move = (ev: PointerEvent) => {
      store.previewFps(startFps + Math.round((ev.clientX - startX) / 2));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      store.endFps();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  fpsEl.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 1;
    let delta = 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
    else return;
    e.preventDefault();
    e.stopPropagation();
    store.beginFpsDrag();
    store.previewFps((store.doc.fps ?? 12) + delta);
    store.endFps();
  });

  function zoomStep(dir: number): void {
    const i = ZOOM_STOPS.indexOf(store.view.zoom);
    const at = i < 0 ? ZOOM_STOPS.indexOf(1) : i;
    store.setView({ zoom: ZOOM_STOPS[Math.min(ZOOM_STOPS.length - 1, Math.max(0, at + dir))] });
  }

  // Playback: an accumulator advances the playhead at the
  // document's fps; the end stops. The rate is read from the doc
  // every frame, so dragging the fps control changes the playback
  // rate live, mid-playback.
  let lastTs = 0;
  let acc = 0;
  function tick(ts: number): void {
    requestAnimationFrame(tick);
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (!store.playing) return;
    acc += dt;
    const step = 1 / (store.doc.fps ?? 12);
    let advanced = false;
    while (acc >= step) {
      acc -= step;
      const len = timelineLength(store.doc);
      if (store.pos + 1 >= len) {
        // Loop on: back to frame 1 and keep playing. Loop off: stop.
        if (store.loop) {
          store.setPos(0);
          advanced = true;
          continue;
        }
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
    const fps = store.doc.fps ?? 12;
    playBtn.title = store.playing ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", store.playing ? "Pause" : "Play");
    playBtn.innerHTML = store.playing
      ? `<svg viewBox="0 0 12 12"><rect x="2" y="1.5" width="3" height="9" rx="0.5"/><rect x="7" y="1.5" width="3" height="9" rx="0.5"/></svg>`
      : `<svg viewBox="0 0 12 12"><path d="M3 1.5 10 6l-7 4.5z"/></svg>`;
    clockPosEl.textContent = `${pos + 1}/${len} · ${(pos / fps).toFixed(1)}s`;
    fpsEl.textContent = `${fps} fps`;
    fpsEl.setAttribute("aria-valuenow", String(fps));
    loopBtn.classList.toggle("active", store.loop);
    loopBtn.setAttribute("aria-pressed", String(store.loop));
    onionBtn.classList.toggle("active", store.onionSkin);
    onionBtn.setAttribute("aria-pressed", String(store.onionSkin));
    angleEl.textContent = store.view.rotateDeg !== 0 ? `${Math.round(store.view.rotateDeg)}°` : "";
    zoomLabel.textContent = `${Math.round(store.view.zoom * 100)}%`;
  }

  store.onChange(sync);
  sync();
}

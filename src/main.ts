// Shell: the window layout (top bar, workspace, timeline, player) and the
// keyboard. The four components own their own DOM; this file wires them.
import "./styles.css";
import { createCanvasView } from "./canvas";
import { createPlayer } from "./player";
import { createStore } from "./store";
import { createTimeline } from "./timeline";
import { createToolbar } from "./toolbar";

declare global {
  interface Window {
    manakin?: {
      platform: string;
      quit: () => Promise<void>;
      minimise: () => Promise<void>;
      maximise: () => Promise<boolean>;
      fullscreen: () => Promise<boolean>;
      windowState: () => Promise<{ maximised: boolean; fullscreen: boolean }>;
    };
  }
}

const app = document.getElementById("app") as HTMLDivElement;
app.innerHTML = `
  <div id="top-bar">
    <div id="traffic-lights">
      <button id="tl-close" class="tl red" title="Close" aria-label="Close"></button>
      <button id="tl-min" class="tl yellow" title="Minimise" aria-label="Minimise"></button>
      <button id="tl-max" class="tl green" title="Maximise" aria-label="Maximise"></button>
    </div>
    <span id="app-name">Manakin</span>
    <input id="project-name" type="text" spellcheck="false" aria-label="Project name" />
    <div id="top-actions">
      <button id="undo-btn" class="hbtn" title="Undo" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
      <button id="redo-btn" class="hbtn" title="Redo" aria-label="Redo"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
    </div>
  </div>
  <div id="middle"><div id="workspace-wrap"></div></div>
  <div id="bottom-bar">
    <div id="resize-handle" title="Drag to resize" aria-label="Resize bottom bar"></div>
    <div id="player-bar"></div>
    <div id="timeline-panel"></div>
  </div>`;

const store = createStore();
const wrap = document.getElementById("workspace-wrap") as HTMLDivElement;
const canvasView = createCanvasView(wrap, store);
createToolbar(wrap, store);
createTimeline(document.getElementById("timeline-panel") as HTMLDivElement, store);
createPlayer(document.getElementById("player-bar") as HTMLDivElement, store);

// ---- Top bar ----------------------------------------------------------

const manakin = window.manakin;
document.getElementById("tl-close")?.addEventListener("click", () => void manakin?.quit());
document.getElementById("tl-min")?.addEventListener("click", () => void manakin?.minimise());
document.getElementById("tl-max")?.addEventListener("click", () => void manakin?.maximise());

const nameInput = document.getElementById("project-name") as HTMLInputElement;
nameInput.value = store.name;
nameInput.addEventListener("change", () => store.setName(nameInput.value.trim() || "Untitled"));

const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
undoBtn.addEventListener("click", () => store.undo());
redoBtn.addEventListener("click", () => store.redo());

// ---- Bottom bar: resizable ---------------------------------------------
// The bottom bar (player + layers) drags from its top edge. Min still
// shows the player plus one layer row; max is 60% of the window. The
// height persists in its own key, next to the document save.

const BOTTOM_HEIGHT_KEY = "manakin-v2-bottom-height";
const BOTTOM_MIN = 150;
const BOTTOM_DEFAULT = 228;
const bottomBar = document.getElementById("bottom-bar") as HTMLDivElement;
const resizeHandle = document.getElementById("resize-handle") as HTMLDivElement;

function bottomMax(): number {
  return Math.round(window.innerHeight * 0.6);
}
function clampBottom(h: number): number {
  return Math.min(bottomMax(), Math.max(BOTTOM_MIN, Math.round(h)));
}
function loadBottomHeight(): number {
  try {
    const raw = localStorage.getItem(BOTTOM_HEIGHT_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n) && n > 0) return clampBottom(n);
  } catch {
    // Storage unavailable — the default height stands.
  }
  return clampBottom(BOTTOM_DEFAULT);
}
bottomBar.style.height = `${loadBottomHeight()}px`;

resizeHandle.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = bottomBar.getBoundingClientRect().height;
  resizeHandle.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent): void => {
    bottomBar.style.height = `${clampBottom(startH + (startY - ev.clientY))}px`;
  };
  const up = (): void => {
    resizeHandle.removeEventListener("pointermove", move);
    resizeHandle.removeEventListener("pointerup", up);
    try {
      localStorage.setItem(BOTTOM_HEIGHT_KEY, String(Math.round(bottomBar.getBoundingClientRect().height)));
    } catch {
      // Storage unavailable — the height just doesn't persist.
    }
  };
  resizeHandle.addEventListener("pointermove", move);
  resizeHandle.addEventListener("pointerup", up);
});
window.addEventListener("resize", () => {
  const h = bottomBar.getBoundingClientRect().height;
  const c = clampBottom(h);
  if (c !== h) bottomBar.style.height = `${c}px`;
});

function syncTopBar(): void {
  undoBtn.disabled = !store.canUndo();
  redoBtn.disabled = !store.canRedo();
  if (document.activeElement !== nameInput) nameInput.value = store.name;
}
store.onChange(syncTopBar);
syncTopBar();

// ---- Keyboard ----------------------------------------------------------

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
}

window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    store.undo();
    return;
  }
  if ((mod && e.key.toLowerCase() === "y") || (mod && e.shiftKey && e.key.toLowerCase() === "z")) {
    e.preventDefault();
    store.redo();
    return;
  }
  if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    store.duplicateSelection();
    return;
  }
  if (mod && e.key === "0") {
    e.preventDefault();
    store.resetView();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    store.deleteSelection();
    return;
  }
  if (mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "v") store.setTool("select");
  else if (k === "p") store.setTool("pen");
  else if (k === "d") store.setTool("eraser");
  else if (k === "t") store.setTool("text");
  else if (k === "b") store.setTool("paint");
  else if (k === "i") store.setTool("eyedropper");
  else if (k === "x") store.swapColors();
  else if (k === "e") {
    if (store.tool === "shape") {
      store.setShapeKind(store.shapeKind === "rect" ? "ellipse" : "rect");
    } else {
      store.setTool("shape");
    }
  }
});

// A lingering text selection (from dragging on the top bar) makes the
// next canvas press start a native drag instead of a stroke; clear it
// on every canvas press.
wrap.addEventListener("pointerdown", () => {
  window.getSelection()?.removeAllRanges();
});

canvasView.render();

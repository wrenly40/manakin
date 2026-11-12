# Code style — Manakin follows Bowerbird

Manakin and Bowerbird are one family of apps. Their codebases must read
the same way: the same file shapes, the same naming, the same idioms.
This document records what Bowerbird actually does (observed in
`~/workspace/quickboard/src/`, November 2026) and how Manakin applies it.
Where Manakin still diverges, it says so — the divergence is a migration
debt, not a second style.

## Observed conventions (Bowerbird)

### Quotes and formatting

- Double quotes for strings, always. Single quotes appear only inside a
  double-quoted string (an apostrophe) or inside a template literal.
- Two-space indent. Semicolons everywhere. Trailing commas where the
  list spans lines.
- `import type` for type-only imports; value imports and type imports
  are separate statements.
- One blank line between a type (or constant) and the next block; related
  declarations stay adjacent with no blank line inside the group.

### File shape

- Small, single-purpose modules. A file does one thing: `model.ts` is the
  pure data model, `plugins.ts` is the plugin system, one file per plugin.
- A module that owns state exposes a factory — `createX(deps)` returning
  a typed interface — never a bag of loose exported `let`s. Callers get
  the interface, not the internals.
- Section dividers mark the big blocks of a file:

  ```ts
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  ```

  with a shorter form for subsections:

  ```ts
  // ---- Panel ------------------------------------------------------
  ```

- Comments explain WHY, not what. A comment justifies a decision, a
  magic number, or a non-obvious consequence ("the 1.8 is the peak scale
  so a full-amplitude layer reaches 1.8 in graph units"). Code that needs
  no justification gets no comment.

### Types and naming

- Types are `PascalCase`, functions and values `camelCase`, constants
  `UPPER_SNAKE_CASE`. Boolean state reads as a question (`isDev`,
  `hasMore`, `panelOpen`).
- Types are defined next to the code that owns them, exported when another
  module needs them. A type that only describes one function's input is
  declared right above that function.
- Explicit return types on exported functions. Internal helpers may infer.
- `unknown` at trust boundaries (loaded saves, plugin payloads), narrowed
  with a guard — never `any`, never a bare cast.

### Plugins

- A plugin is one module exporting `manifest` + `activate(api)` (+
  `deactivate()` when it registers anything). The manifest carries
  `id`, `name`, `version`, `apiVersion`, `description`, `permissions`,
  `enabled`, `required`.
- First-party plugins live in `src/core-plugins/`. The core never imports
  a plugin by name; it loads a list of modules and the registry does the
  rest.
- The plugin context is built per plugin by `createContext`: one API
  object per plugin, with a `require` closure that throws
  `Plugin <id> lacks permission <perm>` when the manifest does not grant
  the permission. `has` is a fixed capability list, not a free-form
  string.
- Registry keys are namespaced: `` `${pluginId}:${id}` ``. `domId` is the
  same namespacing for element ids, so two plugins can never collide.
- The loader is defensive by construction: first-party plugins load
  first; a disabled plugin still enters the loaded map (so re-enabling
  retries it once); a wrong `apiVersion` or a throwing `activate` is
  recorded as a failure with its error and the plugin never half-registers;
  a failed plugin's actions and overlays are removed.
- Plugin calls are wrapped in try/catch with the failure recorded, never
  thrown into the core. A plugin that fails degrades the app honestly:
  its UI disappears, the rest keeps working.
- Plugins talk to each other and to the core through an events bus —
  `emitPluginEvent` / `onEvent` / `offEvent` — not through direct imports
  of each other's internals. A plugin that needs to react to core state
  subscribes; it never polls and never reaches into core state.
- Shell elements (toolbar, stage area, player) are registered once by the
  core with `registerShellElements`; a plugin receives the element it
  owns and builds its UI inside it.

### CSS

- One shared `styles.css`, organised by component, each component headed
  by a `/* ---- Component ---- */` comment.
- Design tokens live at the top as custom properties (`--ink`,
  `--accent`, `--grey`, `--bg-system`, `--hairline`, `--shadow`).
- Component classes are short and prefixed by component (`.tbtn`,
  `.pbtn`, `.seg`, `.blayer`). State is a class on the element
  (`.active`, `.open`), not a second class name.

### Error handling and state

- State that can be stale is re-derived, not cached: a lookup that finds
  nothing returns `null` / `undefined` and the caller handles it.
- A save/load boundary migrates old shapes explicitly (named migration
  functions, one per shape change), never silently.
- Undo is a snapshot of the document only — view state (zoom, pan,
  rotation, focus) is never in a snapshot.

## Applied in Manakin (phase 2, branch `core-plugins`)

- `src/model.ts` is the pure model: types, constants, geometry, animation
  math, colour helpers, save migration, the sample bird. No DOM, no
  module state except the id counter, the smoothed-amplitude map, and a
  text-measurer hook (`setTextMeasurer`) the canvas plugin registers —
  the model measures text through the hook, never through a canvas it
  does not own (the same shape as Bowerbird's `model.ts` WeakMap index).
- `src/plugins.ts` is the plugin system in Bowerbird's shape: manifest,
  `requirePerm`, `createContext`, namespaced registries, the defensive
  loader, the events bus, shell-element and canvas-renderer registration.
- `src/core-plugins/` holds the first-party plugins: `canvas` (stage
  surface, rendering, pointer input), `toolbar` (floating toolbar, tool
  selection), `player` (bottom bar: transport, timeline, clock, loop
  length), `exports` (PNG/GIF/WebM/MP4), `hello` (the minimal example).
  Each is one module exporting `manifest` + `activate` (+ `deactivate`).
- New code is double-quoted throughout. Moved code was converted with a
  tokenizer (string values verified identical before/after); template
  literals are untouched.
- The plugin context gained the domains the core plugins need, each a
  thin closure over core state: `doc` (items, selection, tools, colours,
  gestures, save), `view` (zoom, pan, rotation, layout), `transport`
  (play state, clock, tick), `canvas` (element, render, resize,
  renderer registration), `shell` (the three owned elements),
  `events` (the bus), plus the phase-1 domains (`app`, `files`, `ui`,
  `storage`, `legacy`).

## Applied in Manakin (phase 3, branch `core-plugins`)

- `src/model.ts` gained the timeline (`Frame`, `Timeline`,
  `TIMELINE_FPS = 12`, `newFrame`, `migrateTimeline`,
  `totalTimelineFrames`, `timelineDurationMs`, `frameIndexAtTime`,
  `frameStartMs`) and the motion-provider read surface: the behaviour
  engine moved out of the model into the Behaviours plugin, and the
  model keeps only the data plus `MotionProvider`,
  `setMotionProvider`, `hasMotionProvider` and a delegating
  `motionForItem` (identity motion with no provider). The smoothed
  map moved with the engine; `pruneSmoothed`/`clearSmoothed` stay as
  delegating wrappers in the model because the core calls them.
- `src/core-plugins/` gained `frames` (the traditional animation
  layer: filmstrip, thumbnails, onion toggle, frame menu, drag
  reorder) and `behaviours` (off by default: the motion engine in
  `behaviours-motion.ts`, the layer-stack panel in
  `behaviours-panel.ts`). The default app without any extra plugin is
  frame-by-frame animation.
- The plugin system gained the seams the layer needs: a `"timeline"`
  event; `renderFrameAt` on the app domain and the canvas renderer;
  the `filmstrip` shell element; the frame operations on the `doc`
  domain; the panel-view registry (`registerPanelView`,
  `getPanelView`, `closePanelTransients`) and the shared
  `arrangeSection` / `panelDivider` builders on the `ui` domain, so a
  plugin can claim the panel for a selection and the core falls back
  to its own panels when none matches.
- The exports plugin follows the export schedule: one-frame timeline
  exports the behaviour loop at 30fps, multi-frame exports the
  timeline at its fps through `renderFrameAt`.
- `src/main.ts` keeps single quotes (the panel remainder still lives
  there until the colour/grids/editing/groups migrations dissolve
  it); the moved behaviour panel was converted to double quotes with
  the same tokenizer.

## Still diverging (migration debt, later phases)

- `src/main.ts` is still one large file (2,350 lines after phase 2)
  and still single-quoted. It converges as the panel, keyboard, and
  remaining editing code migrate into plugins: the quote conversion and
  the file split finish when `main.ts` is dissolved, not before. Do not
  reformat it gratuitously in the meantime — a half-converted 2,350-line
  file is worse than an honestly single-quoted one.
- The panel (`renderPanel` and everything it calls) still mutates core
  state directly (`selectedIds = [...]`, `panelView = ...`) instead of
  going through `api.doc`. The canvas/toolbar/player plugins go through
  the API; the panel follows when it becomes a plugin.
- The keyboard handler in `main.ts` still calls core functions directly
  (it is core code, so that is correct). Tool changes go through
  `setTool`, which emits the `tool` event the toolbar subscribes to;
  Space/R keydown/keyup/blur emit the `view` event the canvas
  subscribes to.
- `ZOOM_STOPS` and the view constants live in `model.ts`; the view state
  itself (`zoom`, `panX`, `panY`, `rotateDeg`) stays in `main.ts` until
  the view becomes its own module.

## Before / after

### 1. A plugin file, before and after

Before (phase 1, `src/plugins/exports.ts`): single quotes, no section
dividers, the plugin reached into core through a bespoke `app` domain
only:

```ts
import { writeSequenceFile, ... } from '../electron/preload';
import type { PluginModule, PluginContext } from '../plugins';
export const plugin: PluginModule = {
  manifest: {
    id: 'exports',
    name: 'Exports',
    ...
  },
  activate(api) { ... },
};
```

After (phase 2, `src/core-plugins/exports.ts`): double quotes, Bowerbird
dividers, the same manifest shape Bowerbird uses, and the context domains
named the way Bowerbird names its:

```ts
import { writeSequenceFile, ... } from "../electron/preload";
import type { PluginModule, PluginContext } from "../plugins";

// ---------------------------------------------------------------------------
// Exports — PNG sequence, GIF, WebM, MP4
// ---------------------------------------------------------------------------

export const plugin: PluginModule = {
  manifest: {
    id: "exports",
    name: "Exports",
    ...
  },
  activate(api: PluginContext): void { ... },
};
```

### 2. A pure function, before and after

Before (`src/main.ts`): the animation engine sat in the middle of the
shell file, reading module state (`loopLength`, `smoothed`) directly:

```ts
function loopMs(): number {
  return loopLength * 1000;
}
function smoothedAmp(layer: BehaviourLayer, target: number): number {
  const cur = smoothed.get(layer.id) ?? 0;
  ...
}
```

After (`src/model.ts`): the same functions are pure over their arguments
(the loop length is a parameter; the smoothed map is module state in the
model, the way Bowerbird's `model.ts` keeps its WeakMap index):

```ts
// The loop length is the Loop setting: Cycle N completes N cycles
// in it, so every contributing instance completes a whole number of
// cycles and the pose at the wrap equals the pose at the start.
export function loopMs(loopLength: LoopLength): number {
  return loopLength * 1000;
}
```

and the shell keeps a one-line wrapper so existing callers do not change
(the model's `loopMs` is imported aliased as `loopMsFor`, because the
shell's wrapper keeps the bare name):

```ts
function loopMs(): number {
  return loopMsFor(loopLength);
}
```

### 3. A UI owner, before and after

Before (`src/main.ts`): the toolbar was built by the shell into a
hard-coded element, and every tool change re-rendered it from wherever
the change happened:

```ts
function renderToolbar(): void {
  toolbarEl.innerHTML = TOOL_ICONS.map((icon, i) => `
    <button class="tbtn${tool === TOOLS[i] ? ' active' : ''}" ...>
  `).join('') + `...`;
}
```

After (`src/core-plugins/toolbar.ts`): the toolbar is a plugin that owns
its shell element, subscribes to the `tool` and `pen` events, and
re-renders only when one of them fires. The core never names it, and
disabling it removes the toolbar and nothing else:

```ts
export const plugin: PluginModule = {
  manifest: { id: "core-toolbar", ... },
  activate(api: PluginContext): void {
    const el = api.shell.toolbar;
    api.events.on("tool", render);
    api.events.on("pen", render);
    render();
  },
  deactivate(): void {
    api.events.off("tool", render);
    ...
    el.innerHTML = "";
  },
};
```

## Rule for later phases

Apply Bowerbird's style where you work. Do not reformat code you are not
touching. When a file is fully migrated, it is double-quoted, divided,
and factory-shaped; until then it says so in this document.

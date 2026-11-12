# Manakin plugins

Manakin is a core plus plugins, the way Bowerbird is. The core is the core
of an animation software; everything else is a first-party plugin on a
PluginContext. A plugin adds expert complexity or beginner simplification —
never core behaviour. Plugin development must be easy and seamless: one
plugin philosophy across Manakin and Bowerbird, mirroring Bowerbird's model
rather than a second system per app.

## Copied from Bowerbird, not reinvented

The plugin system is Bowerbird's (`~/workspace/quickboard/src/plugins.ts`,
`PLUGIN_API.md`), copied and adapted — the user's rule for this refactor.
What was copied, what was adapted, and what was deliberately left out:

Copied (adapted only where Manakin's v1 differs):
- The manifest shape: id, name, version, apiVersion, description,
  permissions, enabled, required, plus `contributions` — a summary for a
  future Settings UI; the code in `activate()` is what actually registers
  each contribution, and if the two disagree the registered contributions
  win.
- The trust model and the wording around it (installing a plugin is
  trusting its code, Obsidian/VS Code extension).
- `requirePerm`: a method needing a permission the manifest did not
  declare throws `Plugin <id> lacks permission <perm>` — verbatim.
- `has`: whether the API offers a capability at all (the fixed list of
  domains and contribution kinds in this version), separate from the
  permission check. Copied from Bowerbird's `createContext`.
- `createContext`: one API object per plugin, filtered to the manifest's
  permissions, with the `require` closure.
- `firstPartyModule`: the bundled module is retained across deactivation,
  so re-enabling a bundled plugin re-activates the same module instead
  of failing on a file that does not exist. `deactivate` nulls the active
  `module` but keeps `firstPartyModule`.
- Namespaced registry keys (`${pluginId}:${id}`), as Bowerbird keys cards,
  commands and settings sections — two plugins may register the same
  short id without colliding.
- `domId`: a DOM id namespaced by plugin (`<kind>-plugin-<id>-<id>`) —
  verbatim, used for action button ids.
- The loader shape: first-party plugins first, a disabled plugin still
  enters the loaded map (so it shows in the list and can be re-enabled),
  the apiVersion gate with the recorded failure, a failed plugin never
  half-registers, re-enabling retries a failed plugin once.
- The required-wins rule: a required plugin is always enabled, whatever
  the enabled map says.
- The unregister shape: removing a plugin unregisters everything it
  contributed, by plugin id, and closes any open overlay it owned.

Adapted to Manakin v1 (same philosophy, smaller surface):
- The loader is synchronous and the enabled map lives in localStorage
  (`manakin-plugins`); Bowerbird's is async behind the bridge
  (`plugins.json`) because it loads user plugins from disk. When the
  user-folder loader lands, `initPlugins` becomes async, as Bowerbird's
  is.
- The context domains are Manakin's: `app` (animation reads), `legacy`
  (migration seed), `files` (download + sequence folder), `ui` (actions
  + overlays), `storage` (localStorage, namespaced). Bowerbird's full
  domains (board, window, view, shapes, search, pen, media, text,
  geometry, cards, ai, plugins, events) land with the features that need
  them.
- Overlays are Manakin's own shape (anchored to an action button, with
  `isOpen` / `render` / `close` / `contains`); Bowerbird has no
  anchored-action overlay, so there was nothing to copy there — only the
  registry pattern.

Deliberately not copied in phase 1 (each lands with the phase that needs
it, copied from the same source):
- The user-folder loader: `main` / `styles` manifest fields, the
  `plugin:` scheme, the bridge plugin IPC (`listPlugins`,
  `readPluginFile`, `getPluginEnabled`, `installPlugin`,
  `pluginStorageGet/Set/Delete`). Explicitly a later phase.
- Trial plugins (`try` / `endTrial`, blob-URL loading).
- Secure storage — no plugin holds a secret yet.
- Toast on plugin failure — Manakin's core has no toast; failures are
  recorded in `list()` and surface in the future Settings UI.

Landed in phase 2 (branch `core-plugins`), copied from the same source:
- The events bus (`emitPluginEvent` / `onEvent` / `offEvent`): the
  events are `tool`, `pen`, `selection`, `view`, `transport`,
  `document`. Handlers run in try/catch and a throwing handler is
  recorded, not propagated — a plugin cannot crash the core by
  throwing from an event. The core emits the matching event from
  every host setter; plugins subscribe to the events they care about
  and re-render from them.
- Shell elements (`registerShellElements` / `getShellElements`):
  `toolbar`, `stageWrap`, `player`. The core registers the three
  shell mounts before `initPlugins`; a plugin reads its mount from
  `api.shell` and builds its UI inside it. The mount is a stable
  element the core owns; the plugin owns everything inside it.
- The canvas-renderer registry (`registerCanvasRenderer` /
  `getCanvasElement` / `requestCanvasRender` / `renderFrameTo` /
  `requestCanvasResize`): one plugin owns the stage surface and
  registers a renderer `{ getElement, render, renderFrame, resize }`.
  Everything that needs a frame — the player loop, the exports —
  goes through the registry, never to a canvas it does not own.
  With no renderer registered the calls are no-ops, so disabling the
  canvas plugin degrades honestly instead of throwing.

## What is core, what is a plugin

Core (in `src/main.ts` for now; the pure model lives in `src/model.ts`,
the plugin system in `src/plugins.ts`):
- Document state: items, item groups, stage, loop length, background, grid.
- Animation engine: `motionFor`, behaviours, Cycle/Amplitude/Offset/Easing,
  the seamless loop.
- Undo snapshots, persistence (`manakin-v1`), the sample bird.
- The panel shell, the colour panel, the Actions section — including the
  generic action and overlay registries below.
- The keyboard, the window chrome, the save/load boundary.

Plugins (first-party, bundled in `src/core-plugins/`):
- Canvas — the stage/workspace surface, rendering, pointer input
  (drawing, erasing, dragging, marquee, text editing, pan/rotate drags).
  Migrated in phase 2.
- Toolbar — the floating toolbar: tool selection, brush size, the two
  colour swatches and their swap. Migrated in phase 2.
- Player — the bottom bar: transport (Back/Play/Stop/Forward), the
  timeline and clock, the zoom control, the angle readout. Migrated in
  phase 2.
- Exports (PNG sequence, GIF, WebM, MP4 + the Export dropdown) — migrated
  in phase 1. It is the proof the system works: self-contained, its own UI,
  no hard-wired calls from the core.
- Hello — the minimal example. Disabled by default; enable it to see the
  system work end to end.

Disabling a core plugin removes its UI and degrades honestly: no canvas
means no stage surface (the panel, the toolbar and the player stay up and
the app does not crash; the player loop requests renders that no-op);
no toolbar means no tool switching (the current tool keeps working, the
keyboard still switches tools); no player means no transport or timeline
(the canvas keeps rendering the current pose and the panel keeps working).
Re-enabling rebuilds the UI from the live state.

Later phases migrate the rest, in this order: the traditional animation
layer (phase 3 — designed below), colour panel, grids, editing
(Duplicate/Copy-paste/Z-order/Align), behaviours as an extra plugin (the
behaviour registry itself), groups last. The order is smallest-boundary
first; the behaviour engine is last because everything reads it. The
behaviours stay core behaviour until the traditional layer is the
default — they become an opt-in plugin only after that.

## What a plugin is

A module with a manifest and two lifecycle functions:

```ts
import type { PluginContext, PluginModule } from '../plugins';

export const manifest = {
  id: 'hello',
  name: 'Hello (example)',
  version: '1.0.0',
  apiVersion: '1',
  description: 'The minimal example plugin.',
  permissions: ['ui', 'export'],
  enabled: false, // off by default; enable it in Settings (later) or window.manakinPlugins
};

export function activate(api: PluginContext): void {
  api.ui.registerAction({
    id: 'hello',
    label: 'Hello',
    onClick: () => {
      api.files.download(new Blob(['Hello from the Manakin plugin API v1\n'], { type: 'text/plain' }), 'hello.txt');
    },
  });
}

export function deactivate(): void {
  // The system unregisters this plugin's actions and overlays itself
  // when it deactivates, so most plugins need nothing here. Close
  // anything the plugin opened itself (timers, listeners, DOM).
}

export const plugin: PluginModule = { manifest, activate, deactivate };
```

- `id` is unique, lowercase, letters, digits and `-` only.
- `apiVersion` is `'1'`. A plugin written for another API version does not
  load; the failure is recorded and listed, not swallowed.
- `permissions` gates the API object. A method that needs a permission the
  manifest did not declare throws. Reading the animation is always
  allowed; everything else must be declared.
- `required` (optional) marks a plugin that cannot be disabled. Nothing
  uses it in phase 1.
- `enabled: false` (optional) means off by default; absent means on.
- `activate` is synchronous in API v1. A plugin that needs async setup
  does it lazily, after activation.
- Installing a plugin is trusting its code, the way installing an
  Obsidian or VS Code extension is. The API below is the supported
  contract. A plugin that reaches past it into core DOM or internals may
  break in a later version.

## The API object (v1)

`activate(api)` receives one object, per plugin, filtered to the manifest's
permissions. `api.version` is `'1'`. The full reference is the
`PluginContext` type in `src/plugins.ts`. The domains:

- `app` — read the animation: loop length and milliseconds, stage size,
  frame count (`round(L*30)`), `renderFrame(t01, target, dprOverride?)`
  for offline rendering, and `renderPanel()` to re-render the right panel.
  No permission needed: these read, they do not write. `legacy` carries
  the one-time migration seed (values the core used to own that now
  belong to a plugin, keyed by plugin id) — read it at `activate` if the
  plugin needs it, then forget it.
- `doc` — needs `doc`: the document. Reads: `getItems()` (the live
  array — a plugin may push, splice and reorder it in place, exactly
  as the canvas plugin does when it commits a stroke), `getItemGroups()`,
  `getSelectedItems()`, `getItemGroupOf(itemId)`, `getSelection()`,
  `getFocusedId()`, `getTool()`, `getColor()`, `getBgColor()`,
  `getActiveSlot()`, `getPenWidth()`, `getShapeKind()`, `getStageBg()`,
  `getGridMode()`, `getStageId()`. Writes (each emits the matching
  event): `setSelection(ids)`, `setFocusedId(id)` (emit `selection`),
  `setTool(t)`, `setColor(hex)`, `setBgColor(hex)`, `setActiveSlot(slot)`,
  `swapColors()`, `setPenWidth(n)`, `setShapeKind(kind)` (emit `pen` or
  `tool`), `setStageBg(id, custom)`, `pruneItemGroups()` (emit
  `document`). Gestures: `gestureStart()` returns the undo snapshot
  to restore on cancel; `gestureCommit(before, changed)` pushes the
  undo entry (only when `changed` is true) and emits `document`.
  `pushHistory()` and `save()` are the raw forms.
- `view` — needs `view`: the view transform. `getZoom()` / `setZoom(z)`,
  `zoomStep(dir)`, `resetView()`, `resetZoom()`, `getPan()` /
  `setPan(x, y)`, `getRotate()` / `setRotate(deg)`, `getLayout()`
  (the workspace layout: stage origin, scale, rotation — read it
  fresh, never cache it), `getViewState()`, `isSpaceHeld()`,
  `isRotateHeld()`. Every setter emits `view`.
- `transport` — needs `transport`: the player clock. `isPlaying()`,
  `getPlayTime()` / `setPlayTime(ms)`, `play()`, `pause()`, `stop()`,
  `back()`, `forward()`, `tick(ts)` (advances the clock and returns
  the loop position `t01`). Every method emits `transport`.
- `canvas` — needs `canvas`: the stage surface. `getElement()` (the
  live canvas, or `null` when the canvas plugin is disabled),
  `requestRender(t01?)` (re-render the current pose), `resize()`
  (re-fit the canvas to the workspace), `registerRenderer(renderer)`
  (the canvas plugin registers `{ getElement, render, renderFrame,
  resize }`; `registerRenderer(null)` unregisters it). Reads are
  safe with no renderer — they no-op.
- `shell` — needs `shell`: the three shell mounts, `toolbar`,
  `stageWrap`, `player`. A plugin builds its UI inside its mount and
  empties it on `deactivate`. Throws if the shell was not registered.
- `events` — needs `events`: `on(event, handler)`, `off(event,
  handler)`, `emit(event)`. The events are `tool`, `pen`, `selection`,
  `view`, `transport`, `document`. A handler that throws is recorded
  and does not propagate.
- `files` — needs `export`: `download(blob, filename)` (the anchor
  download, straight to Downloads) and the PNG-sequence folder surface,
  `pickSequenceFolder()` and `writeSequenceFile(dir, name, dataUrl)`
  through the Electron bridge. Absent outside Electron.
- `ui` — needs `ui`: `registerAction` / `unregisterAction` (a button in
  the Canvas panel's Actions section, between Save and Clear; `chevron`
  gives it the Export-style chevron), `getActionButton(id)` (the live
  button, for anchoring), `registerOverlay` / `unregisterOverlay` (a
  floating panel anchored to an action button — see below),
  `openColour(slot)` (open the Colour view on the foreground or
  background swatch), `attachTooltip(btn, text)` (the shared frosted
  hint pill above the button).
- `storage` — needs `storage`: per-plugin key/value settings in
  localStorage, namespaced `manakin-plugin:<id>:<key>`. Never another
  plugin's keys, never the core save.

## Actions and overlays

The core's Actions section renders Save, then every registered action in
registration order, then Clear. An action's click never reaches the
document's outside-click handler (the core stops it), so an action that
opens an overlay does not immediately close it.

An overlay is a floating panel anchored to an action button. The plugin
registers it once; the core owns its lifecycle:

```ts
api.ui.registerOverlay({
  id: 'export-dropdown',
  actionId: 'export',
  isOpen: () => dropdownOpen,
  render: (anchor) => renderDropdown(anchor), // rebuild the overlay DOM
  close: () => { dropdownOpen = false; closeDropdownEl(); },
  contains: (t) => t.closest('.export-dropdown') !== null || anchorBtn?.contains(t) || false,
});
```

- The core re-renders open overlays after every panel render (the anchor
  button is rebuilt each time, so the overlay must be rebuilt with it).
  An open overlay whose anchor is gone (the panel switched away) is
  closed instead.
- Escape, an outside click, a panel scroll and a window resize all close
  open overlays through the same path. The core never names a plugin
  here; it asks the registry.
- `render(anchor)` rebuilds the overlay DOM from scratch (remove the old
  element first). `close()` removes the DOM and sets the plugin's open
  state to false.
- `contains` must use `closest()` as well as a live `contains()`: a click
  inside the overlay can rebuild the panel under its own handler, leaving
  its target detached — `closest()` still walks the detached ancestors,
  so the outside-click handler does not close the overlay the click just
  rebuilt.

## Enable and disable

Bundled plugins are on by default (absent from the map means enabled),
except a manifest with `enabled: false`. The enabled map lives in
localStorage under `manakin-plugins` (`{ [id]: boolean }`). Disabling
unregisters the plugin's actions and overlays, closes any open overlay,
and re-renders the panel — its UI is gone and the rest of the app still
works. Re-enabling re-runs `activate`. A plugin that fails to load (wrong
apiVersion, an error in `activate`) is recorded as failed with its error
and never half-registers.

Phase 1 has no Settings UI for plugins. The management surface is
`window.manakinPlugins`:

```js
window.manakinPlugins.list()
// [{ id, name, version, description, core, required, active, failed, error }]
window.manakinPlugins.setEnabled('exports', false) // reload not needed
window.manakinPlugins.setEnabled('hello', true)
```

A Settings → Plugins UI is a later phase; it uses the same `list` and
`setEnabled` calls.

## The traditional animation layer (phase 3 design)

This is the design phase 3 builds from. It is the default animation
model: the app without any extra plugin is frame-by-frame animation,
the way a flipbook is. Behaviours become an extra plugin layered on
top of it, only after this layer is the default.

### The frame model

A frame is a full pose of the document at one instant: the set of
items as drawn in that frame. Frames are the document's timeline, not
a property of one item.

```ts
type Frame = {
  id: string;
  items: Item[];          // the items as they look in this frame
  duration: number;       // frames held, in timeline frames (default 1)
};
type Timeline = {
  frames: Frame[];        // in order; index 0 is the first frame
  fps: number;            // timeline frames per second (default 12)
  current: number;        // the frame being edited (index into frames)
};
```

- The timeline lives in the document, next to `items` and
  `itemGroups`, and is saved in `manakin-v1` under `timeline` with a
  migration: a save without one gets a single frame holding its items
  (`{ id, items: <the saved items>, duration: 1 }`), so every existing
  document opens as a one-frame animation and keeps working.
- A frame holds its own items. The first frame is the document as it
  is today; drawing on frame N edits frame N's items only. Copying a
  frame duplicates its items (fresh ids, like Duplicate); deleting a
  frame removes its items; the timeline never has zero frames.
- `duration` is hold time: a frame with `duration: 2` shows for two
  timeline frames. It is the simple way to slow a pose down without
  duplicating it. The default is 1.
- `fps` is the timeline rate (default 12, the classic hand-drawn
  rate). The loop length setting stays: the loop is the whole
  timeline played at `fps`, and the loop length in seconds is
  `totalFrames / fps` — the Loop 4/6/8/10s control becomes a display
  of the timeline's length (and, when the timeline is a single frame,
  the behaviour loop length it already is). Phase 3 decides the exact
  seam: the Loop control stays in the Canvas panel and shows the
  timeline length when the timeline has more than one frame.
- Items keep their ids across frames only when copied from the
  previous frame — that is what makes onion skin and "edit this item
  in every frame" possible. An item drawn fresh in frame N has a new
  id and exists only in frame N.

### The filmstrip UI

The filmstrip is a horizontal strip of frame thumbnails along the
bottom of the workspace, above the player bar (the player owns the
transport; the filmstrip is the traditional layer's UI, registered
through the shell as a fourth mount, `filmstrip`, below the stage
wrap).

- One tile per frame, in order: a small live thumbnail of the frame's
  items (rendered through the canvas renderer at low resolution),
  the frame number underneath, the current frame outlined in ink.
- Click a tile to edit that frame. Drag a tile to reorder it.
  The tile's context actions (long-press / right-click / the small
  `+` at the end): duplicate frame, delete frame, add frame after,
  set hold duration (1/2/3/4).
- `+` at the end of the strip adds a frame: it starts as a copy of
  the current frame (so the drawing is there to change), the way a
  flipbook artist traces the previous drawing. A blank frame is the
  duplicate with its items deleted — one click, not a mode.
- The strip scrolls horizontally when the timeline is long. It never
  moves the player bar; the player bar stays where it is.

### Onion skin

Onion skin shows the neighbouring frames ghosted behind the current
one while drawing, so the next pose can be traced from the last.

- A toggle in the filmstrip (onion icon, on by default when the
  timeline has more than one frame): previous frame at ~30% opacity
  in ink, next frame at ~15% opacity in a different tint. Only the
  immediately adjacent frames; more would muddy the drawing.
- Onion frames are display-only: they are never hit-tested, never
  selectable, never exported, and never in the undo snapshot.
- The canvas plugin renders them: it reads the timeline through
  `api.doc` (the traditional layer registers the timeline on the
  `doc` domain, the same way items are registered) and draws the
  adjacent frames' items under the current frame's items, at the
  onion opacities, before the current frame.

### Frame playback through the player

The player does not change shape; it changes what it plays.

- Play advances the timeline at `fps`: the current frame is
  `floor(playTime * fps / 1000)` mapped through the hold durations,
  and the canvas renders that frame's items. Pause holds the current
  frame. Back returns to frame 0. Forward jumps to the last frame.
  Stop returns to frame 0 and pauses.
- The timeline progress bar is the player's existing progress fill:
  it shows the loop position, which is now the timeline position.
  The clock reads `frame N / total` as well as seconds.
- A single-frame timeline plays exactly as today: the behaviour
  loop. The frame model does not change the one-frame case at all —
  that is the compatibility guarantee.
- Exports render the timeline: PNG sequence, GIF, WebM and MP4 each
  emit one image per timeline frame at the timeline's `fps` (held
  frames repeat their image), so an export of a 24-frame timeline at
  12fps is 24 images over 2 seconds. The exports plugin reads the
  timeline through `api.doc` and falls back to the behaviour loop
  when the timeline has one frame.

### How it relates to the behaviour engine

Frames are the default; behaviours are an extra plugin layered on
top, in this order:

1. The frame's items are the base pose (what the artist drew in
   that frame).
2. The behaviour engine superposes its motion on top of the base
   pose, exactly as it does today: `motionFor` reads the frame's
   items and returns the displaced pose for the loop position.
3. The loop position for behaviours is the timeline position mapped
   onto the loop: a behaviour with Cycle N completes N cycles per
   loop, and the loop is the timeline's length. On a single-frame
   timeline the loop is the Loop setting, as today.
4. Turning the behaviours plugin off leaves pure frame-by-frame:
   the frames play, nothing moves between them. Turning it on adds
   motion to the frames. The behaviour layer stack in the panel
   stays exactly as it is; it reads the current frame's items.
5. A behaviour applied to a frame applies to that frame's items
   only. A behaviour copied with a frame (duplicate frame) keeps
   working on the copy's items, because the copy's layers are
   copied with the items, the way Duplicate copies layers today.

### Persistence and undo for frames

- Persistence: `timeline` in the `manakin-v1` payload, next to
  `items` (which becomes the current frame's items on load when no
  timeline exists — see the migration above). The undo snapshot
  gains `timeline` and `currentFrame` alongside `items`,
  `itemGroups`, `stageId`, `stageBgId`, `stageBgCustom`, `gridMode`,
  `loopLength`. One entry per gesture, pushed before the mutation,
  as today.
- Undo scope: a frame switch is not an undo entry (it is view state,
  like focus); drawing, adding, deleting, duplicating or reordering
  a frame is. Undoing a frame deletion restores the frame and its
  items; undoing a drawing gesture restores the frame's items as
  they were.
- The current frame index is view state (not saved, not in undo),
  like zoom and focus. Reloading opens on frame 0.

## User plugins (later phase, not phase 1)

Phase 1 loads bundled first-party plugins only. User plugins from a local
folder (Bowerbird's `plugin:` scheme, manifest + main module, same
`activate`/`deactivate` shape) come in a later phase, along with the
Settings UI. Nothing in the phase-1 design blocks them: the loader already
takes a module list, the version gate and the enabled map are the same
shape, and the context is the same object.

## Versioning

`PLUGIN_API_VERSION` is `'1'`, in `src/plugins.ts`. When the API changes
in a way that breaks plugins, the version bumps and old plugins stop
loading with a clear error — the same rule as Bowerbird (whose current
API is `2`; Manakin's API is its own, starting at `1`).

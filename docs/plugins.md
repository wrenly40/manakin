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
- The events bus (`events.on/off`, `selection` / `board` / `view` /
  `pen` / `tool`). No plugin consumes an event in v1 and nothing emits
  one; a bus with no emitters would be dead code. It lands with the
  first plugin that needs to react to core state, copied from
  Bowerbird's `emitPluginEvent` / `onEvent` / `offEvent`.
- Shell elements, the board controller and the settings-UI registration
  — Bowerbird's pattern for a fully plugin-built UI. That is the end
  state of the migration, not phase 1; the core still owns its DOM
  until more features migrate.
- Toast on plugin failure — Manakin's core has no toast; failures are
  recorded in `list()` and surface in the future Settings UI.

## What is core, what is a plugin

Core (stays in `src/main.ts` for now; splitting the core into files is a
later phase, after more features migrate):
- Document state: items, item groups, stage, loop length, background, grid.
- Animation engine: `motionFor`, behaviours, Cycle/Amplitude/Offset/Easing,
  the seamless loop.
- Undo snapshots, persistence (`manakin-v1`), the sample bird.
- Stage/workspace rendering, the view transform (pan/zoom/rotate),
  selection, hit-testing, drawing tools, the player.
- The panel shell, the toolbar, the colour panel, the Actions section —
  including the generic action and overlay registries below.

Plugins (first-party, bundled in `src/plugins/`):
- Exports (PNG sequence, GIF, WebM, MP4 + the Export dropdown) — migrated
  in phase 1. It is the proof the system works: self-contained, its own UI,
  no hard-wired calls from the core.
- Hello — the minimal example. Disabled by default; enable it to see the
  system work end to end.

Later phases migrate the rest, in this order: colour panel, grids, editing
(Duplicate/Copy-paste/Z-order/Align), behaviours as a plugin (the behaviour
registry itself), groups. The order is smallest-boundary first; the
behaviour engine is last because everything reads it.

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
- `files` — needs `export`: `download(blob, filename)` (the anchor
  download, straight to Downloads) and the PNG-sequence folder surface,
  `pickSequenceFolder()` and `writeSequenceFile(dir, name, dataUrl)`
  through the Electron bridge. Absent outside Electron.
- `ui` — needs `ui`: `registerAction` / `unregisterAction` (a button in
  the Canvas panel's Actions section, between Save and Clear; `chevron`
  gives it the Export-style chevron), `getActionButton(id)` (the live
  button, for anchoring), `registerOverlay` / `unregisterOverlay` (a
  floating panel anchored to an action button — see below).
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

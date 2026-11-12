// Hello — the minimal example plugin (Manakin Plugin API v1).
//
// The whole plugin is this file: a manifest, an activate that registers
// one action, and no deactivate (the system unregisters the action
// itself). It is OFF by default (enabled: false in the manifest) so the
// app ships unchanged; enable it from the phase-1 management surface
// to see it work:
//
//   window.manakinPlugins.setEnabled('hello', true)   // a Hello button appears in Actions
//   window.manakinPlugins.setEnabled('hello', false)  // and it is gone again
//
// Copy this file as the starting point for a new plugin: change the id,
// the name and the description, keep the shape, and register whatever
// the plugin contributes in activate. See docs/plugins.md.

import type { PluginContext, PluginModule } from "../plugins";

export const manifest = {
  id: "hello",
  name: "Hello (example)",
  version: "1.0.0",
  apiVersion: "1",
  description: "The minimal example plugin: one action that downloads a hello file.",
  permissions: ["ui", "export"],
  enabled: false,
  contributions: {
    actions: [{ id: "hello", label: "Hello" }],
  },
};

export function activate(api: PluginContext): void {
  api.ui.registerAction({
    id: "hello",
    label: "Hello",
    onClick: () => {
      api.files.download(
        new Blob(["Hello from the Manakin plugin API v1\n"], { type: "text/plain" }),
        "hello.txt",
      );
    },
  });
}

export const plugin: PluginModule = { manifest, activate };

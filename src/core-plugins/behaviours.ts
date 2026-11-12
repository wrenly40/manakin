// Behaviours — the behaviour animation plugin (Manakin Plugin API v1).
//
// Off by default: the default app is frame-by-frame animation, and
// behaviours are an extra plugin layered on top of it. When it is on,
// the behaviour engine superposes motion on the current frame's pose
// and the behaviour panel (layer stack, Add behavior list, behaviour
// groups) returns; when it is off, the motion provider is gone, so
// every motion read is the rest pose, and the panel view is gone, so
// no behaviour UI appears anywhere. The engine itself lives in
// behaviours-motion.ts, the panel in behaviours-panel.ts; this module
// is only the wiring between the two and the plugin system.

import type { PluginContext, PluginModule } from "../plugins";
import { setMotionProvider } from "../model";
import { createMotionProvider } from "./behaviours-motion";
import { behaviourPanelView, closeBehaviourTransient, initBehaviourPanel } from "./behaviours-panel";

export const manifest = {
  id: "behaviours",
  name: "Behaviours",
  version: "1.0.0",
  apiVersion: "1",
  description: "Behaviour animation: layer stacks that superpose motion on frames.",
  permissions: ["doc", "events", "ui"],
  enabled: false,
  contributions: {
    actions: [],
    overlays: [],
  },
};

let api!: PluginContext;

export function activate(a: PluginContext): void {
  api = a;
  initBehaviourPanel(api);
  // The motion provider is what makes items move: registering it
  // turns the behaviour engine on for every reader (the canvas, the
  // hit test, the exports) at once, and unregistering it turns the
  // whole app back to the rest pose.
  setMotionProvider(createMotionProvider());
  api.ui.registerPanelView(behaviourPanelView);
  api.ui.registerPanelTransient(closeBehaviourTransient);
  // How a frame renders changes with the provider (a thumbnail drawn
  // at rest is not the same thumbnail drawn at the Sway offset), so
  // the filmstrip re-renders its thumbnails on the toggle.
  api.events.emit("timeline");
}

export function deactivate(): void {
  setMotionProvider(null);
  api.ui.unregisterPanelView(behaviourPanelView.id);
  api.ui.unregisterPanelTransient();
  api.events.emit("timeline");
}

export const plugin: PluginModule = { manifest, activate, deactivate };

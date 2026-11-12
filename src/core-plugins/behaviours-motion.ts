// Behaviour motion — the behaviour engine (Manakin Plugin API v1).
//
// Moved verbatim out of src/model.ts in the core-plugins phase 3:
// the motion math is the Behaviours plugin's, not the core's. The
// model keeps only the data (layer instances on items, the registry)
// and the motion provider's read surface (setMotionProvider /
// motionForItem), which returns the rest pose when no provider is
// registered — that is what makes the default app pure
// frame-by-frame. A layer's effective parameters fold in its
// behaviour group's multipliers; motion and graphs read through the
// same LayerCtx, so the two agree.

import type { MotionProvider } from "../model";
import type { BehaviourGroup, BehaviourLayer, EasingName, Item, ItemGroup, LayerCtx, LayerHost, Motion } from "../model";

const smoothed = new Map<string, number>(); // layer id -> smoothed amplitude 0..1

// Animation
// A behaviour layer is on for the whole loop when toggled on.
// All on layers superpose; amplitude eases in/out so toggling is smooth.
// ---- Behaviour groups ----
// A layer's effective parameters fold in its group's multipliers.
// A member contributes only when both its own toggle and its group's toggle are on.
export function groupOfIn(groups: BehaviourGroup[], layer: BehaviourLayer): BehaviourGroup | undefined {
  return groups.find((g) => g.members.includes(layer.id));
}
export function groupOf(it: Item, layer: BehaviourLayer): BehaviourGroup | undefined {
  return groupOfIn(it.groups, layer);
}
export function effActiveIn(groups: BehaviourGroup[], layer: BehaviourLayer): boolean {
  const g = groupOfIn(groups, layer);
  return layer.on && (!g || g.active);
}
export function effActive(it: Item, layer: BehaviourLayer): boolean {
  return effActiveIn(it.groups, layer);
}
export function effCycleIn(groups: BehaviourGroup[], layer: BehaviourLayer): number {
  const g = groupOfIn(groups, layer);
  return layer.cycle * (g ? g.cycle : 1);
}
export function effCycle(it: Item, layer: BehaviourLayer): number {
  return effCycleIn(it.groups, layer);
}
export function effAmplitudeIn(groups: BehaviourGroup[], layer: BehaviourLayer): number {
  const g = groupOfIn(groups, layer);
  return layer.amplitude * (g ? g.amplitude : 1);
}
export function effAmplitude(it: Item, layer: BehaviourLayer): number {
  return effAmplitudeIn(it.groups, layer);
}
export function amplitudeScale(a: number): number {
  // Amplitudes are fractions (0-1); the 1.8 is the peak scale so a
  // full-amplitude layer reaches 1.8 in graph units and (via 0.08/0.35
  // factors) ~11% max scale and ~0.63 rad max rotation in the motion.
  return a * 1.8;
}
// Whole number of cycles an instance at this effective cycle count
// completes in one loop. The cycle math uses this, so the pose at the
// wrap equals the pose at the start.
export function loopCycles(cycle: number): number {
  return Math.max(1, Math.round(cycle));
}
export function smoothedAmp(layer: BehaviourLayer, target: number): number {
  const cur = smoothed.get(layer.id) ?? 0;
  let next = cur + (target - cur) * 0.06;
  if (Math.abs(next - target) < 0.002) next = target;
  smoothed.set(layer.id, next);
  return next;
}
// Blink pulse: a smooth raised-cosine bump centred where sin(ph) peaks
// (ph = PI/2), spanning `durationPct` % of the cycle at its base. At the
// default 26% the eye is more than half closed for ~13% of the cycle,
// matching the old sin^8 blink.
export function blinkPulse(ph: number, durationPct: number): number {
  const twoPi = Math.PI * 2;
  let d = (ph - Math.PI / 2) / twoPi; // distance from the blink centre, in cycles
  d -= Math.round(d); // wrap to [-0.5, 0.5]
  const w = durationPct / 100;
  if (Math.abs(d) >= w / 2) return 0;
  return 0.5 * (1 + Math.cos((twoPi * d) / w));
}
// Wander jitter amplitude: 50+ is the current smooth summed-sines drift;
// below 50, higher-frequency components creep in, up to 0.9 at 0%.
export function wanderJitterAmp(smooth: number): number {
  return smooth >= 50 ? 0 : ((50 - smooth) / 50) * 0.9;
}
// Wander drift terms, shared by the motion and the graph so the two agree.
// `cycles` is the whole number of cycles the instance completes in one
// loop; every component frequency is an integer multiple of it (1x base,
// 2x/3x jitter), so the pose at the cycle end equals the pose at the
// start. The old 0.5x/0.7x base and 2.3x/3.1x jitter never closed.
export function wanderTerms(layer: BehaviourLayer, cycles: number, t01: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const j = wanderJitterAmp(layer.wanderSmooth);
  if (layer.easing === "smooth") {
    // The old expression exactly, so Wander moves bit-identically on
    // old saves.
    const ph = twoPi * layer.offset;
    return {
      x: Math.sin(twoPi * cycles * t01 + ph) + j * Math.sin(twoPi * 2 * cycles * t01 + 0.4 + ph),
      y: Math.sin(twoPi * cycles * t01 + 1.3 + ph) + j * Math.sin(twoPi * 3 * cycles * t01 + 2.1 + ph),
    };
  }
  // Eased: every term reads the eased cycle position. The jitter is
  // 2x/3x the eased position (minus the offset, as the old expression
  // had it), so it still advances by whole cycles over the loop.
  const pos = easedCyclePos(layer, cycles, t01);
  const off = layer.offset;
  return {
    x: Math.sin(twoPi * pos) + j * Math.sin(twoPi * (2 * pos - off) + 0.4),
    y: Math.sin(twoPi * pos + 1.3) + j * Math.sin(twoPi * (3 * pos - 2 * off) + 2.1),
  };
}
// The instance's position within its own cycle, in cycles, after easing:
// whole cycles advance unwarped (so the pose at the wrap equals the pose
// at the start); only the fractional phase is reshaped.
export function easedCyclePos(layer: BehaviourLayer, cycles: number, t01: number): number {
  const cyc = cycles * t01 + layer.offset;
  const whole = Math.floor(cyc);
  return whole + easePhase(layer.easing, cyc - whole);
}
// The fractional eased phase, for curves read in [0,1) like Bounce's.
export function easedFrac(layer: BehaviourLayer, cycles: number, t01: number): number {
  const pos = easedCyclePos(layer, cycles, t01);
  return pos - Math.floor(pos);
}
// The phase angle for the sine-based behaviours. For Smooth the easing
// is the identity, so this is exactly the old expression — old saves
// and the sample bird move bit-identically.
export function phaseOf(layer: BehaviourLayer, cycles: number, t01: number): number {
  if (layer.easing === "smooth") return Math.PI * 2 * cycles * t01 + Math.PI * 2 * layer.offset;
  return Math.PI * 2 * easedCyclePos(layer, cycles, t01);
}
// Bounce height over one cycle: a parabola peaked mid-cycle — the
// constant-acceleration shape of a ball under gravity. It is 0 at the
// cycle ends (rest on the ground) and the velocity flips there: fast
// fall, sharp rebound. Always >= 0, unlike Bob's sine.
export function bounceCurve(u: number): number {
  return 4 * u * (1 - u);
}
// Fade depth over one cycle: a slow raised-cosine ramp, 0 at the ends
// and 1 mid-cycle — the whole loop is one fade out and back in, where
// Blink's pulse spans only blinkDuration % of the cycle.
export function fadeRamp(ph: number): number {
  return (1 - Math.cos(ph)) / 2;
}
// Tremble jitter, shared by the motion and the graph. Like Wander's
// drift but at higher integer-multiple frequencies (7x/9x base, 11x/13x
// second harmonic) and a much smaller radius, so it reads as a fast
// shiver rather than a slow drift. Every component is an integer
// multiple of the loop, so the pose at the cycle end equals the pose
// at the start.
export function trembleTerms(layer: BehaviourLayer, cycles: number, t01: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const pos = easedCyclePos(layer, cycles, t01);
  return {
    x: Math.sin(twoPi * 7 * pos) + 0.6 * Math.sin(twoPi * 11 * pos + 0.4),
    y: Math.sin(twoPi * 9 * pos + 1.3) + 0.6 * Math.sin(twoPi * 13 * pos + 2.1),
  };
}
// A layer's effective parameters, resolved through a context: an
// item's layers fold in their behaviour group (v9); an item group's
// layers fold in theirs the same way. Motion and graphs read through
// the same context, so the two agree.
export function itemCtx(it: Item): LayerCtx {
  return { cycle: (l) => effCycle(it, l), amplitude: (l) => effAmplitude(it, l), active: (l) => effActive(it, l) };
}
export function groupCtx(g: ItemGroup): LayerCtx {
  return { cycle: (l) => effCycleIn(g.groups, l), amplitude: (l) => effAmplitudeIn(g.groups, l), active: (l) => effActiveIn(g.groups, l) };
}
// A behaviour stack lives on an item or on an item group. The panel's
// layer cards work on either, and behaviour groups (v9) exist on either too.
export function hostLayers(h: LayerHost): BehaviourLayer[] {
  return h.kind === "item" ? h.item.layers : h.group.layers;
}
export function hostGroups(h: LayerHost): BehaviourGroup[] {
  return h.kind === "item" ? h.item.groups : h.group.groups;
}
export function hostCtx(h: LayerHost): LayerCtx {
  return h.kind === "item" ? itemCtx(h.item) : groupCtx(h.group);
}
export function hostFindLayer(h: LayerHost, id: string): BehaviourLayer | undefined {
  return hostLayers(h).find((l) => l.id === id);
}
export function motionForLayers(layers: BehaviourLayer[], ctx: LayerCtx, t01: number): Motion {
  let dx = 0, dy = 0, scale = 1, rot = 0, opacity = 1, sx = 1, sy = 1;
  for (const layer of layers) {
    const a = smoothedAmp(layer, ctx.active(layer) ? 1 : 0);
    if (a < 0.01) continue;
    const cycles = loopCycles(ctx.cycle(layer));
    const am = amplitudeScale(ctx.amplitude(layer));
    const ph = phaseOf(layer, cycles, t01); // Offset shifts the motion within its own cycle; easing reshapes the phase
    if (layer.behaviour === 0) dy += a * am * 16 * Math.sin(ph); // Bob
    if (layer.behaviour === 1) dx += a * am * 16 * Math.sin(ph + Math.PI / 2); // Sway
    if (layer.behaviour === 2) scale += a * am * 0.08 * Math.sin(ph); // Breathe
    if (layer.behaviour === 3) opacity -= a * ctx.amplitude(layer) * blinkPulse(ph, layer.blinkDuration); // Blink: depth is the amplitude (0 = never closes, 1 = fully shut)
    if (layer.behaviour === 4) rot += (layer.spinReverse ? -1 : 1) * a * am * 0.35 * Math.sin(ph); // Spin
    if (layer.behaviour === 5) { const w = wanderTerms(layer, cycles, t01); dx += a * am * 18 * w.x; dy += a * am * 14 * w.y; } // Wander
    if (layer.behaviour === 6) dy -= a * am * 16 * bounceCurve(easedFrac(layer, cycles, t01)); // Bounce: a hop up from rest — fast fall, sharp rebound at the ground
    if (layer.behaviour === 7) { const s = a * am * 0.08 * Math.sin(ph); sx += s; sy -= s; } // Stretch: scaleX and scaleY in opposition (wide+short <-> narrow+tall)
    if (layer.behaviour === 8) { const dir = layer.orbitReverse ? -1 : 1; dx += a * am * 16 * Math.cos(ph); dy += dir * a * am * 16 * Math.sin(ph); } // Orbit: a small circle around the rest position
    if (layer.behaviour === 9) opacity -= a * ctx.amplitude(layer) * fadeRamp(ph); // Fade: slow ramp in and out over the whole loop (depth is the amplitude, like Blink)
    if (layer.behaviour === 10) { const tr = trembleTerms(layer, cycles, t01); dx += a * am * 3 * tr.x; dy += a * am * 2.5 * tr.y; } // Tremble: tiny fast jitter, where Wander is a slow drift
  }
  return { dx, dy, scale, rot, opacity: Math.max(0.05, Math.min(1, opacity)), sx, sy };
}
export function motionFor(it: Item, t01: number): Motion {
  return motionForLayers(it.layers, itemCtx(it), t01);
}
// An item group's own stack, applied to every member.
export function groupMotion(g: ItemGroup, t01: number): Motion {
  return motionForLayers(g.layers, groupCtx(g), t01);
}
// An item's full motion: its own stack superposed with its item
// group's stack (if any). Offsets and rotation add, scale multiplies,
// opacity multiplies (both blink).
export function motionForItem(it: Item, t01: number, groups: ItemGroup[]): Motion {
  const m = motionFor(it, t01);
  const g = groups.find((gr) => gr.memberIds.includes(it.id));
  if (!g) return m;
  const mg = groupMotion(g, t01);
  return {
    dx: m.dx + mg.dx,
    dy: m.dy + mg.dy,
    scale: m.scale * mg.scale,
    sx: m.sx * mg.sx,
    sy: m.sy * mg.sy,
    rot: m.rot + mg.rot,
    opacity: Math.max(0.05, Math.min(1, m.opacity * mg.opacity)),
  };
}
// Motion value of one layer over the loop, for the layer graph.
// Reads the same parameters as motionFor, so the graph and the motion agree.
export function behaviourValue(layer: BehaviourLayer, ctx: LayerCtx, t01: number): number {
  const am = amplitudeScale(ctx.amplitude(layer));
  const cycles = loopCycles(ctx.cycle(layer));
  const ph = phaseOf(layer, cycles, t01);
  if (layer.behaviour === 3) return am * blinkPulse(ph, layer.blinkDuration); // Blink: the widened pulse itself, not a square wave
  if (layer.behaviour === 4) return (layer.spinReverse ? -1 : 1) * am * Math.sin(ph); // Spin: mirrors when reversed
  if (layer.behaviour === 5) { const w = wanderTerms(layer, cycles, t01); return am * (w.x + 0.7 * w.y) / 1.7; } // Wander
  if (layer.behaviour === 6) return am * bounceCurve(easedFrac(layer, cycles, t01)); // Bounce: the hop height (0 at rest, 1 at the apex)
  if (layer.behaviour === 7) return am * Math.sin(ph); // Stretch: the scaleX deviation; scaleY is its mirror
  if (layer.behaviour === 8) { const dir = layer.orbitReverse ? -1 : 1; return am * (Math.cos(ph) + 0.7 * dir * Math.sin(ph)) / 1.7; } // Orbit: mirrors when reversed, like Spin
  if (layer.behaviour === 9) return am * fadeRamp(ph); // Fade: the slow ramp itself
  if (layer.behaviour === 10) { const tr = trembleTerms(layer, cycles, t01); return am * (tr.x + 0.7 * tr.y) / 1.7; } // Tremble
  return am * Math.sin(ph);
}

// Easing reshapes the normalized cycle phase u in [0,1] with a function
// mapping 0->0 and 1->1, so every easing still closes the loop seamlessly.
// Smooth is the identity: the current sine, so old saves and the sample
// bird move exactly as before.
export function easePhase(easing: EasingName, u: number): number {
  if (easing === "linear") {
    // Constant-speed rise and fall (a triangle wave out of the sine):
    // the phase warp whose sine is linear in u. asin() is exact at the
    // joints (u = 0.25 / 0.75), so the warp is continuous.
    if (u < 0.25) return Math.asin(4 * u) / (Math.PI * 2);
    if (u < 0.75) return 0.5 - Math.asin(2 - 4 * u) / (Math.PI * 2);
    return 1 + Math.asin(4 * u - 4) / (Math.PI * 2);
  }
  if (easing === "ease-in-out") return u * u * (3 - 2 * u); // smoothstep: dwell at the extremes, sweep through the middle
  if (easing === "snap") return Math.floor(u * 4) / 4; // 4 holds per cycle: hold, then jump
  return u; // smooth
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

// Drop the eased amplitudes of layers that no longer exist. A layer id
// is never reused, so a dropped entry is never read again.
export function pruneSmoothed(liveLayerIds: Set<string>): void {
  for (const id of [...smoothed.keys()]) if (!liveLayerIds.has(id)) smoothed.delete(id);
}

// Clear every eased amplitude (clearing the stage): the next motion
// starts from rest.
export function clearSmoothed(): void {
  smoothed.clear();
}

// The motion provider the Behaviours plugin registers with the model:
// the core reads motion only through it, so disabling the plugin
// leaves the rest pose.
export function createMotionProvider(): MotionProvider {
  return { motionForItem, pruneSmoothed, clearSmoothed };
}

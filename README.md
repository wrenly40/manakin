# Manakin

Draw on a fixed stage, then give your drawings behaviours. Behaviours stack like a drum machine: add Bob, Sway, Breathe and more as layers on a part, press Play, and simple motions combine into complex ones. No timeline, no keyframes.

## Behaviours

Eleven behaviours: Bob, Sway, Breathe, Blink, Spin, Wander, Bounce, Stretch, Orbit, Fade, Tremble. Each layer has Cycle (1–10 cycles per loop), Amplitude, Offset and Easing (Smooth, Linear, In-Out, Snap). The loop runs 4, 6, 8 or 10 seconds — pick the length in the Canvas panel.

## Editing

Duplicate, copy and paste, Arrange (bring to front, forward, backward, back), Align, zoom and pan. Parts can be grouped into item groups with their own behaviours, and layers into behaviour groups ("Layer Group") with master Cycle and Amplitude. Group behaviours groups layers; Group objects groups parts on the canvas.

## Pasteboard

The stage sits on a workspace: draw outside the stage and it stays visible while you work, but exports crop to the stage.

## Exports

PNG sequence, GIF, WebM or MP4.

## Run

```
npm install
npm start
```

`npm start` builds first, then opens the built app — a fresh download works with no separate build step (`electron-dist/` is built, not shipped).

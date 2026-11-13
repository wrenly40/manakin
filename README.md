# Manakin

Draw and animate frame by frame on a fixed stage.

## The app

Four components, nothing else:

- **Toolbar** — Select, Pen, Eraser, Geometry, Text, paint bucket; brush
  size; colours and a colour panel.
- **Canvas** — a fixed stage (16:9, Square or Portrait) in a pasteboard
  workspace. Pan, zoom and rotate are view-only. Draw strokes, shapes
  and text; erase like a pen; select, move, duplicate and delete. Full
  undo and redo.
- **Player** — Back, Play, Stop, Forward, a scrubber and a clock.
  Playback runs at 12 frames per second.
- **Timeline** — layers with frames. Each layer has its own frames; click
  a cell to edit that frame on the canvas. Add, duplicate and delete
  frames; set a hold.

## Run

```sh
npm install
npm start
```

## Notes

- Work autosaves on this machine.
- Exports (PNG, GIF, video) are not in this build yet — they come later.

# Manakin

Draw on a fixed stage, then give your drawings behaviours. Behaviours stack like a drum machine: tap cells to turn Bob, Sway, Breathe, Blink, Spin or Wander on for each beat, press Play, and simple motions combine into complex ones. No timeline, no keyframes.

## Run

```
npm install
npm run dev
```

Runs Electron from source with the Vite dev server. `npm start` builds first, then opens the built app — no separate build step needed. (Before this fix, a fresh download failed with "Unable to find Electron app … electron-dist/main.js" because that file is only produced by a build and neither `npm start` nor `npm run dev` built it first.)

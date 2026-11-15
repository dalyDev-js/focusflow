# FocusFlow 🍅

A calm **Pomodoro timer** Chrome extension (Manifest V3). Focus for 25 minutes, take a 5 minute break, and after 4 rounds take a long break. You get a notification and a soft chime every time a phase ends.

**Live page:** https://focusflow-ext.vercel.app

![FocusFlow popup](site/popup-focus.webp)

## Features

- Focus, short break and long break phases with an animated progress ring
- Charged focus mode: a bold yellow lightning bolt strikes across the dial every few seconds while a focus session runs (respects reduced-motion)
- Runs in the background with `chrome.alarms`, so it keeps going when the popup is closed
- Desktop notifications with a "Start break / Start focus" button, plus a synthesized chime (offscreen document)
- Toolbar badge showing minutes left, colored by phase
- Daily stats: sessions, focus minutes, day streak, a 7-day chart and a daily goal
- Click the clock and type any time (`40`, `12:30`), use presets, or adjust mid-session
- Settings for every duration, long-break interval, auto-start and sound
- Keyboard: `Space` start/pause, digits set the time, `↑`/`↓` ±1 min (Shift ±5), `←`/`→` switch phase, `Alt+Shift+P` from any tab
- Zero dependencies, no build step, no tracking (fonts: Manrope and Space Grotesk, OFL)

## Install (unpacked)

1. Download `focusflow-extension.zip` from the live page (or clone this repo).
2. Unzip it, open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and pick the `focusflow-extension` folder (or the `extension/` folder of this repo).
4. Pin FocusFlow from the puzzle-piece menu.

## Project layout

```
extension/   the Chrome extension (manifest, service worker, popup, offscreen audio)
site/        static landing page deployed to Vercel, includes the packaged zip
```

`npm run build` re-packages `extension/` into `site/focusflow-extension.zip`.

## License

MIT

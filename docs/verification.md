# Verification record

What was actually run against this code, where, and what could not be.

## Environment

A Linux container with no GPU. Browsers render through SwiftShader
(software WebGL2), which exercises the same shaders and code paths as a
real GPU at a fraction of the speed — good for correctness, useless for
frame-rate numbers.

## Automated checks

| Check                       | Command             | Result               |
| --------------------------- | ------------------- | -------------------- |
| Lint (strict, type-checked) | `npm run lint`      | clean                |
| Formatting                  | `npm run format`    | clean                |
| Types (strict)              | `npm run typecheck` | clean                |
| Unit tests                  | `npm run test`      | 325 passed, 24 files |
| Production build            | `npm run build`     | succeeds             |
| End-to-end                  | `npm run e2e`       | 40 of 40 checks pass |

## End-to-end scenarios (`scripts/visual-check.mjs`)

Each scenario runs in a fresh browser context against the production
build.

1. **Desktop, pointer lock** — the world generates and meshes; the player
   stands on solid ground; the title menu is shown; the frame has real
   variety; pointer lock engages; placing, walking, breaking; `E` opens
   the inventory and a choice fills the hotbar slot; double-tap jump takes
   off and flight climbs and descends; leaving pointer lock pauses to a
   menu that offers to resume; a setting changes live; after a reload the
   position, hotbar, settings, flight state and world edits are all
   restored.
2. **Graphics tiers** — medium, high and ultra each compile their shaders
   and render a varied frame with no console errors (low is the tier the
   other scenarios run on).
3. **Pointer lock refused** — the game falls back to drag-look and stays
   playable: movement, look, tap-to-break.
4. **No WebGL** — the CPU raycaster engages, renders, moves and breaks.
5. **Phone (touch only)** — touch is detected and gets lighter defaults;
   play starts; the on-screen controls appear; the joystick moves; a tap
   breaks; the fly, inventory and pause buttons work.
6. **Offline** — the service worker installs and takes control; with the
   network disabled, a reload still boots the game and builds the world.
7. No console errors across all of the above.

## Shells

- **Desktop (Electron)** — launched under Xvfb in this container: the game
  boots in WebGL2 from `app://game/`, the page has no `require` or
  `process`, the preload flag is visible, and a path-traversal request
  (`app://game/..%2F..%2Fpackage.json`) returns 404. Packaging with
  `electron-builder` was **not** run here.
- **Mobile (Capacitor)** — `npx cap add android` and `npx cap sync`
  succeed and copy the web build into the generated Android project. No
  Android SDK is available here, so **no APK was built and nothing was run
  on a device or emulator**. iOS was not attempted (needs macOS).
- **GitHub Actions** — the `e2e` job in `ci.yml` and the manual
  `release.yml` workflow were written here but have **not been run on
  GitHub's runners**; expect to adjust them on first use.

## Not verified

- **Frame rate on real hardware.** Nothing here measures it. The design
  targets it (8-byte vertices, cave culling, a tier with no post passes,
  adaptive render scale), but the numbers have to come from real devices.
- **Real touch devices, notches, thermals, battery.**
- **Audio output** — the sound engine is exercised for not throwing; what
  it sounds like was not listened to.
- **Safari / iOS WebKit and Firefox** — only Chromium was driven. The
  renderer needs WebGL2 and, for the tiers above low, a renderable
  half-float target; without the former the game uses the CPU renderer,
  without the latter it stays on the low tier.
- **Store submission, signing, notarization.**

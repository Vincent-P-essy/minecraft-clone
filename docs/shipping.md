# Shipping Lumenwild

What exists in this repository, and what still stands between it and a
store page. The technical parts are done or scripted; the rest is a
checklist only the publisher can complete.

## What you can build today

| Target                  | Command                                                              | Output                           |
| ----------------------- | -------------------------------------------------------------------- | -------------------------------- |
| Web (any host)          | `npm run build`                                                      | `dist/` — static files           |
| Web (GitHub Pages)      | pushed to `main` → `pages.yml`                                       | the live site                    |
| Windows / macOS / Linux | `npm run build:native && cd desktop && npm ci && npm run dist`       | installers in `desktop/release/` |
| Android                 | `npm run build:native && cd mobile && npm ci && npm run android:apk` | a debug APK                      |
| iOS                     | same, with `npx cap add ios && npm run ios:open` on a Mac            | an Xcode project                 |

The **Release builds** workflow (`.github/workflows/release.yml`, run by
hand from the Actions tab) does the desktop builds on all three operating
systems and the Android debug APK, and attaches them to the run.

`build:native` differs from `build` in one way: every URL in the bundle is
relative, so the game loads from disk inside a shell.

For Google Play specifically — the Android project, the signed bundle,
the store listing, the privacy policy and the Families declarations — see
the step-by-step guide in [`play-store.md`](play-store.md) (in French).

## Before you sell it

### Identity

- **The name.** "Lumenwild" is a working title set in one place
  (`src/branding.ts`, plus `index.html`, `public/manifest.webmanifest` and
  the two shell configs). Before publishing, run a trademark search
  (EUIPO / INPI / USPTO) and check the stores for collisions.
- **No third-party marks.** The repository is still called
  `minecraft-clone`; nothing a player sees uses that name, and a store
  listing must not either — not in the title, keywords, description or
  screenshots. The game ships no third-party art, audio or code beyond its
  npm dependencies: every texture and sound is generated.
- **App id.** `com.lumenwild.game` (in `desktop/package.json` and
  `mobile/capacitor.config.json`) should become a reverse-domain you
  control before the first store upload — it can't be changed afterwards.

### Licensing

- The code is **MIT**. That permits selling it, and it equally permits
  anyone else to take this repository and do the same. If the commercial
  build should be exclusive, develop it in a private repository or
  relicense future work; what is already published under MIT stays MIT.
- Ship the dependency licenses with the app: three.js and simplex-noise
  (MIT) in the game; Electron (MIT) and Chromium's notices on desktop,
  which `electron-builder` bundles automatically; Capacitor (MIT) on
  mobile.

### Signing — required by every store, not done here

Nothing in this repository holds a certificate or key, by design.

- **Windows**: an Authenticode certificate (OV or EV), or distribution
  through the Microsoft Store / Steam, which removes the SmartScreen
  warning for unsigned installers.
- **macOS**: an Apple Developer ID certificate plus notarization
  (`electron-builder` supports both through environment variables).
- **Android**: an upload keystore and Play App Signing; switch the Gradle
  task from `assembleDebug` to `bundleRelease` to produce the `.aab` Play
  requires.
- **iOS**: an Apple Developer Program membership, a distribution
  certificate and provisioning profile, built on a Mac.

Keep keys out of the repository. In GitHub Actions, store them as
encrypted secrets scoped to a protected `release` environment with
required reviewers, and never expose them to pull-request workflows.

### Store requirements worth knowing early

- **Privacy.** The game makes no network requests after loading, has no
  accounts, analytics, ads or third-party SDKs, and stores only local
  save data. That makes the privacy questionnaires short — but both mobile
  stores still require a privacy policy URL, and the answers must stay
  true if analytics or ads are added later.
- **Age rating.** IARC (Google Play, Microsoft Store) and Apple's
  questionnaire; a sandbox with no violence or user-to-user communication
  rates for everyone.
- **Steam / itch.io.** The desktop build is a plain installer or
  AppImage; itch.io can also host the web build directly. Steam needs the
  Steamworks app set up and, for achievements or cloud saves, the
  Steamworks SDK wired into the Electron shell — neither exists yet.
- **Store screenshots** must be real gameplay at each store's required
  sizes; `scripts/screenshot.mjs` stages and captures scenes at any
  viewport.

## Security notes for the shells

- **Desktop** (`desktop/main.cjs`): the window is sandboxed and
  context-isolated with Node integration off; the preload script exposes
  one frozen, read-only object. Files are served over a privileged
  `app://` scheme from a single directory, and any path that resolves
  outside it returns 404. Every response carries a Content-Security-Policy
  (`default-src 'self'`, no inline script, no remote origins). Navigation
  away from the app origin, `window.open`, webviews and every permission
  except pointer lock and fullscreen are refused. Keep Electron current:
  it embeds Chromium, and its security fixes arrive through Electron
  releases.
- **Mobile** (`mobile/capacitor.config.json`): content is served from
  `https://localhost` inside the WebView, cleartext traffic and mixed
  content are disabled, and WebView debugging is off in release builds.
- **Web**: the service worker only handles same-origin GET requests and
  caches nothing it didn't ship. If the site is served from your own
  host, add the same Content-Security-Policy as a response header.
- **Saved data** is treated as untrusted on load: settings, hotbar and
  player saves are validated field by field and fall back to defaults,
  so a corrupted or hand-edited save can't wedge the game.

## Known gaps

See the README's _Limits_ and `docs/verification.md` for what has and has
not been verified. The short version for a release: test on real target
devices (frame rate, thermals, touch feel, notches), and decide whether a
commercial release needs content this sandbox doesn't have — goals,
progression, survival, multiplayer.

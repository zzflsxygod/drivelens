# app-platforms — Build targets, PWA and native shells

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources:
> - Web / PWA: `app/vite.config.ts`, `app/package.json` (scripts), `app/index.html`, `app/web-public/_headers`, `app/src/vite-env.d.ts`, `app/src/pwa.ts`.
> - Platform glue: `app/src/platform.ts`, except the back-stack logic, which `app-shell` owns.
> - Tauri: `app/src-tauri/tauri.conf.json`, `app/src-tauri/capabilities/default.json`, `app/src-tauri/src/lib.rs`, `app/src-tauri/src/main.rs`, `app/src-tauri/Cargo.toml`.
> - Android: `app/src-tauri/gen/android/app/src/main/java/com/zzflsxygod/drivelens/MainActivity.kt`, `AndroidManifest.xml`, `res/xml/network_security_config.xml`, `res/xml/file_paths.xml`.
> - Context: build targets in `.github/workflows/web.yml`, `android.yml` and `windows.yml`; `README.md`; `docs/install.md`.
>
> In this document, "the system" means the build configuration and platform layer that turn the shared TypeScript app into its delivery targets: the web app / PWA and the Tauri desktop and Android shells. It also covers the platform glue those targets need at runtime.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

One TypeScript code base is delivered as the official web app, which is the supported way to use DriveLens and can be installed to the home screen as a PWA. The same code can also be wrapped in Tauri shells for Windows and Android, whose builds are currently paused (doc: README.md "Quick start (server)"; comment: .github/workflows/android.yml:4; comment: .github/workflows/windows.yml:4).

This module defines what each build produces and the security headers / CSP of each target. It also covers the service worker that caches only the app shell, installation and updates of the PWA, and the native glue: Android safe areas, system bars, image share/save, and opening external links in the system browser.

## 2. Responsibility boundaries

### 2.1 In scope
- Build modes and outputs, build-time constants and environment variables, and the dev server.
- Web build: the injected `<head>` tags, `manifest.webmanifest`, and the generated `sw.js` with its app-shell precache and fetch policy.
- Service-worker registration, the update toast, the install prompt and the iOS install hint mode, `theme-color` syncing, and the root CSS classes.
- Hosting headers for the official web app (`_headers`: CSP, security headers, cache control).
- The Tauri configuration (window, CSP, bundle targets, capabilities) and the Rust shell.
- The Android activity: edge-to-edge insets, system-bar icon colors, the native share/save bridge, the manifest and network-security config, and FileProvider paths.
- Platform detection (`isTauri`, `isAndroid`, `isTouch`, `isWeb`, `isStandalone`, `isIOS`) and routing external links to the system browser.
- The third-party license file produced by the build.

### 2.2 Out of scope
- What "back" does (`inAppBack`, `setRootBack`, `nav.ts` history) → `app-shell`. This module only connects the Android hardware back button to it.
- The service worker's `push` and `notificationclick` handlers → `app-notifications`.
- Stripping `api` / `token` / `key` parameters inside the page (`urlguard.ts`) → `app-connection`. This module covers only the service worker's handling of such navigations.
- The share-card dialog itself (buttons, messages) → `app-journeys`. This module supplies the native share/save calls.
- Settings layout, including where the install card and support card appear, and the link list (`links.ts`) → `app-shell`.
- The connection test's http/https rules → `app-connection`.
- The API's CORS allow-list, which includes the Tauri origins → `api-core`.
- CI mechanics, signing, release and deploy pipelines → `ops-delivery`. Only the targets are stated here.
- Theme selection itself (`effectiveTheme`) → `app-shell` / `app-ui-kit`. This module only follows `data-theme`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `app-shell`: `inAppBack()` for the Android back button (src: app/src/platform.ts:39-51, 53-58).
  - `app-ui-kit`: `closeMenus` / `hasOpenMenu`, used by `inAppBack` (src: app/src/platform.ts:4).
  - `app-i18n`: `t()` for the update toast texts (src: app/src/pwa.ts:4, 52).
  - `app-notifications`: its handlers are generated into the same `sw.js` (src: app/vite.config.ts:92-116).
  - `app-connection`: the service worker mirrors its list of sensitive URL parameters (`api`, `token`, `key`) (src: app/vite.config.ts:81; app/src/urlguard.ts:6).
  - ext:Vite, Tauri 2 (`tauri`, `tauri-plugin-opener`, `@tauri-apps/api`), Android (WebView, `MediaStore`, `FileProvider`, `WindowInsetsCompat`), Cloudflare Pages (`_headers`), and the browser service worker / `beforeinstallprompt` APIs.
  - ext:map tile hosts `tiles.openfreemap.org` and `tile.openstreetmap.org`, allowed in both CSPs.
- **Used by:**
  - `app-shell`: `initPlatform()`, `initWeb()`, `isWeb()`, `installMode()` / `promptInstall()` / `onInstallChange()`, `__WEB_BUILD__` / `__WEB_ORIGIN__`, and the donation build variables (src: app/src/main.ts:498, 515, 520-531, 910-911, 961; app/src/links.ts:17).
  - `app-journeys`: `canNativeShare`, `canNativeSave`, `nativeShareImage` and `nativeSaveImage` (src: app/src/journey2.ts:4, 169-200).
  - `app-notifications`: `isTauri`, `isIOS`, `isStandalone`, and the registered service worker (src: app/src/notify.ts:9-10).
  - `app-connection`: `isTauri` and `isAndroid` (src: app/src/setup.ts:9, 61, 70).
  - `ops-delivery`: the npm build scripts and their outputs.
- **Provided interface:**
  - npm scripts: `dev`, `build`, `build:web`, `preview`, `preview:web`, `tauri`, `check:i18n` (src: app/package.json:7-15).
  - Build-time constants: `__APP_VERSION__`, `__WEB_BUILD__`, `__WEB_ORIGIN__` (src: app/vite.config.ts:161; app/src/vite-env.d.ts:2-6).
  - Build-time environment: `VITE_WEB_ORIGIN`, `VITE_DONATE_URL`, `VITE_DONATE_WEB_ONLY`, `TAURI_DEV_HOST` (src: app/vite.config.ts:6, 9; app/src/vite-env.d.ts:8-11).
  - Web output (`app/dist-web/`): `index.html`, hashed `assets/*`, `sw.js`, `manifest.webmanifest`, `third-party-licenses.txt`, and the copied `web-public/*` (`_headers`, `favicon.ico`, `icons/*`).
  - Tauri output: `app/dist/`.
  - JS exports from `platform.ts`: `isTauri`, `isAndroid`, `isTouch`, `syncSystemBars`, `openExternal`, `canNativeShare`, `nativeShareImage`, `canNativeSave`, `nativeSaveImage`, `initPlatform`.
  - JS exports from `pwa.ts`: `isWeb`, `isStandalone`, `isIOS`, `installMode`, `promptInstall`, `onInstallChange`, `initWeb`.
  - Android bridge `window.DriveLensAndroid` with `insets()`, `setDarkBars(dark)`, `shareImage(b64, name, title)` and `saveImage(b64, name)`, plus the callback `window.__dlInsets(json)` (src: app/src/platform.ts:7-11; MainActivity.kt:39, 57-95).
  - CSS hooks: variables `--a-sat`, `--a-sar`, `--a-sab`, `--a-sal`; classes on `<html>`: `web`, `standalone`, `ios`, `touch`, `android`, `ime`.
  - Cache Storage names: `drivelens-shell-<version>-<build id>`.

## 3. External behavior

### 3.1 Build modes
- **PLAT-001** When `npm run build` runs, the system SHALL run the i18n check and the TypeScript compiler, then a Vite build into `app/dist/` for the Tauri shells. That build SHALL contain no manifest, no service worker and no `web-public` files. (src: app/package.json:9; app/vite.config.ts:157-168; comment: app/vite.config.ts:16)
- **PLAT-002** When `npm run build:web` runs, the system SHALL run the same checks, then a Vite build in mode `web` into `app/dist-web/`. That build SHALL copy `app/web-public/` and add the PWA head tags, `manifest.webmanifest` and `sw.js`. (src: app/package.json:13; app/vite.config.ts:158, 165-167; comment: app/vite.config.ts:11-15)
- **PLAT-003** When either build runs, the system SHALL emit `third-party-licenses.txt` (PLAT-090). (src: app/vite.config.ts:166)
- **PLAT-004** When building, the system SHALL define these constants:
  - `__APP_VERSION__`: the `version` from `app/package.json`;
  - `__WEB_BUILD__`: `true` only in mode `web`;
  - `__WEB_ORIGIN__`: `VITE_WEB_ORIGIN`, or `https://drivelens-app.oharuru.com` when unset.

  (src: app/vite.config.ts:8-9, 161; app/src/vite-env.d.ts:2-6)
- **PLAT-005** When building, the system SHALL expose to app code only environment variables prefixed `VITE_` or `TAURI_ENV_`. It SHALL target `es2020` and empty the output directory first. (src: app/vite.config.ts:164, 167)
- **PLAT-006** When the dev server runs, it SHALL listen on port 1420 and fail if the port is taken. When `TAURI_DEV_HOST` is set, it SHALL listen on that host with hot reload over WebSocket port 1421. (src: app/vite.config.ts:6, 162-163; app/src-tauri/tauri.conf.json:7-8)
- **PLAT-007** When `npm run preview:web` runs, the system SHALL serve `app/dist-web/` on port 4174. (src: app/package.json:14)

### 3.2 Web document and manifest
- **PLAT-010** When building for the web, the system SHALL insert these tags before `</head>` of `index.html`:
  - a description meta;
  - two `theme-color` metas, `#f3f4f7` for light and `#07080a` for dark color schemes;
  - `color-scheme: light dark` and `referrer: no-referrer`;
  - the manifest link, favicon and 32 px PNG icon links, and the `apple-touch-icon` link;
  - `mobile-web-app-capable` and the Apple web-app metas (title equal to the PWA `name` below, status bar `black-translucent`);
  - and SHALL set the document `<title>` to that same name.

  (src: app/vite.config.ts:27-43)
- **PLAT-011** When building for the web without `VITE_DRIVELENS_CHANNEL=preview`, the system SHALL emit `manifest.webmanifest` with these values:
  - `id` `/`, `name` and `short_name` `DriveLens`, `start_url` `/?source=pwa`, `scope` `/`;
  - `display` `standalone`, with `display_override` `["standalone", "minimal-ui"]`;
  - `orientation` `portrait`, background and theme color `#f3f4f7`, `lang` `en`;
  - icons: 192 px and 512 px (`any`) and a 512 px maskable icon.

  (src: app/vite.config.ts:21-23, 45-57)
- **PLAT-012** When building for the web with `VITE_DRIVELENS_CHANNEL=preview`, the system SHALL use PWA `name` `DriveLens Preview` and `short_name` `DL Preview` (and the matching document / Apple titles); all other manifest fields SHALL match PLAT-011. (src: app/vite.config.ts:21-23, 45-57; doc: AGENTS.md §8)

### 3.3 Service worker: app-shell cache
- **PLAT-020** When building for the web, the system SHALL generate the service worker's shell list from `/`, every emitted bundle file except source maps, `/manifest.webmanifest`, `/favicon.ico` and the six listed icons, de-duplicated and without `/index.html`. (src: app/vite.config.ts:53-57; comment: app/vite.config.ts:53)
- **PLAT-021** When building for the web, the system SHALL name the cache `drivelens-shell-<app version>-<build time in base 36>`, so every build gets a new cache. (src: app/vite.config.ts:58)
- **PLAT-022** When the service worker installs, it SHALL fetch every shell URL, bypassing the HTTP cache, and store the responses. (src: app/vite.config.ts:69)
- **PLAT-023** When the service worker activates, it SHALL delete every other cache whose name starts with `drivelens-shell-` and take control of open pages. (src: app/vite.config.ts:70)
- **PLAT-024** When the page fetches something, the service worker SHALL leave these requests untouched: non-GET requests, requests to another origin (the user's API server, map tiles), requests with an `Authorization` header, and requests for `/health` or `/api/*`. Such requests are never answered from or stored in a cache. (src: app/vite.config.ts:72-78; comment: app/vite.config.ts:63-64, 76-77; doc: docs/install.md "6. Connect the web app")
- **PLAT-025** When a navigation request has a query parameter named `api`, `token` or `key` (case-insensitive), the service worker SHALL answer with the cached `/` shell. If `/` is not cached, it SHALL fetch `/` without parameters, so the original address is never sent over the network. (src: app/vite.config.ts:79-84; comment: app/vite.config.ts:79-80; doc: CHANGELOG.md v1.1.1)
- **PLAT-026** When any other navigation request is made, the service worker SHALL try the network first. It SHALL answer with the cached `/` shell when the response is not OK or the network fails. (src: app/vite.config.ts:85-88; comment: app/vite.config.ts:85)
- **PLAT-027** When a same-origin GET requests a path in the shell list, the service worker SHALL answer from the cache, falling back to the network. Other same-origin GETs SHALL pass through. (src: app/vite.config.ts:89-90)
- **PLAT-028** When the page posts the message `"skipWaiting"`, a waiting service worker SHALL activate. (src: app/vite.config.ts:71)

### 3.4 Service-worker registration and updates
- **PLAT-030** When the web build starts in a secure context that supports service workers, the app SHALL register `/sw.js` with scope `/` after the `load` event. In the Tauri builds and in insecure contexts it SHALL register none. (src: app/src/pwa.ts:47-51, 66-78; comment: app/src/pwa.ts:2-3)
- **PLAT-031** When a new service worker is waiting while another one already controls the page, the app SHALL show the toast "A new version of DriveLens is available" with a "Reload" button. This applies whether the worker was found at registration or by a later update. The button SHALL post `skipWaiting`. At most one toast SHALL be shown at a time. (src: app/src/pwa.ts:37-45, 52-57; app/src/locales/en.ts:466-467)
- **PLAT-032** When the controlling service worker changes, the app SHALL reload the page once. (src: app/src/pwa.ts:58-59)
- **PLAT-033** When the page becomes visible again, the app SHALL ask the browser to check for an updated service worker, ignoring errors. (src: app/src/pwa.ts:60-61; comment: app/src/pwa.ts:60)

### 3.5 Installation (PWA)
- **PLAT-040** When the browser fires `beforeinstallprompt`, the app SHALL suppress the browser's own prompt and keep the event. `installMode()` SHALL then return `"prompt"` and change listeners SHALL be notified. (src: app/src/pwa.ts:17-21, 72)
- **PLAT-041** When the app runs in an iPhone / iPad browser tab with no kept prompt, `installMode()` SHALL return `"ios"`, which means manual "Share → Add to Home Screen" steps. iPadOS counts as iOS when it reports `MacIntel` with touch points. (src: app/src/pwa.ts:14-15, 20; app/src/locales/en.ts:465)
- **PLAT-042** When the app runs standalone (installed) or inside Tauri, or neither PLAT-040 nor PLAT-041 applies, `installMode()` SHALL return `""`. (src: app/src/pwa.ts:12-13, 17-21)
- **PLAT-043** When `promptInstall()` is called with a kept prompt, the app SHALL show it once, forget it, notify listeners and resolve to whether the user accepted. Without a kept prompt it SHALL resolve to `false`. (src: app/src/pwa.ts:22-29)
- **PLAT-044** When the browser fires `appinstalled`, the app SHALL forget the kept prompt and notify listeners. (src: app/src/pwa.ts:73)
- **PLAT-045** When Settings is shown, the install card SHALL appear only while `installMode()` is not `""`. It SHALL show an "Install" button only in mode `"prompt"`, and the iOS steps text in mode `"ios"`. The card is rendered by `app-shell`. (src: app/src/main.ts:520-531; app/src/locales/en.ts:462-465; doc: docs/install.md "6. Connect the web app")

### 3.6 Theme color and root classes
- **PLAT-050** When the web build runs, the app SHALL set every `theme-color` meta to `#07080a` when `<html data-theme>` is `dark` and to `#f3f4f7` otherwise. It SHALL remove their `media` attributes and repeat this whenever `data-theme` changes. (src: app/src/pwa.ts:31-35, 74-76)
- **PLAT-051** When the app starts, it SHALL add these classes to `<html>`:
  - `web` when not running in Tauri;
  - `standalone` when `display-mode: standalone` matches or `navigator.standalone` is true;
  - `ios` on iPhone / iPad;
  - `touch` when the device has a coarse pointer and no fine pointer;
  - `android` on Android.

  (src: app/src/pwa.ts:66-71; app/src/platform.ts:15-17, 85-90)

### 3.7 External links
- **PLAT-055** When the user clicks a link whose URL uses `http`, `https`, `mailto` or `tel`, points to another origin and has no `download` attribute, the app SHALL cancel the default navigation and open the URL externally. The click is caught in the capture phase.
  - In Tauri: through the opener plugin in the system browser, falling back to `window.open(url, "_blank", "noopener")` if that fails.
  - In a browser: with `window.open(url, "_blank", "noopener")`.

  Same-origin links SHALL not be intercepted. (src: app/src/platform.ts:60-75; app/src-tauri/src/lib.rs:5; comment: app/src/platform.ts:2-3)

### 3.8 Hosting headers (official web app)
- **PLAT-060** When Cloudflare Pages serves the web app, every response SHALL carry these headers:
  - the Content-Security-Policy `default-src 'self'; connect-src 'self' https:; img-src 'self' data: blob: https://tiles.openfreemap.org https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` and `X-Frame-Options: DENY`.

  (src: app/web-public/_headers:3-8; comment: app/web-public/_headers:1-2)
- **PLAT-061** When Cloudflare Pages serves the web app, `/assets/*` SHALL be cacheable for one year as immutable. `/sw.js`, `/index.html` and `/manifest.webmanifest` SHALL be `no-cache`, and the manifest SHALL have the type `application/manifest+json`. (src: app/web-public/_headers:10-21)

### 3.9 Tauri shells
- **PLAT-070** When the Tauri app is built, it SHALL embed `app/dist/` produced by `npm run build`. Its product name is `DriveLens`, its identifier `com.zzflsxygod.drivelens` and its version `1.3.1`. It opens one resizable window of 420 × 820. (src: app/src-tauri/tauri.conf.json:3-19)
- **PLAT-071** When the Tauri app loads, it SHALL apply the CSP `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost https: http:; img-src 'self' data: blob: https://tiles.openfreemap.org https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; worker-src 'self' blob:; child-src 'self' blob:; base-uri 'self'; form-action 'none'`. (src: app/src-tauri/tauri.conf.json:21-33; doc: CHANGELOG.md v1.1.2)
- **PLAT-072** When the Tauri app runs, it SHALL grant the main window only `core:default`, registering and removing app listeners, `app:allow-exit` and `opener:default`. (src: app/src-tauri/capabilities/default.json:15-21)
- **PLAT-073** When the Tauri app starts, the Rust shell SHALL register only the opener plugin. On Windows release builds it SHALL not open a console window. (src: app/src-tauri/src/lib.rs:3-8; app/src-tauri/src/main.rs:2-4)
- **PLAT-074** When the Tauri app is bundled, it SHALL use these settings: `targets: all`; Android `minSdkVersion` 24; iOS minimum 14.0; WebView2 installed through the embedded bootstrapper on Windows; an NSIS installer in Simplified Chinese and English without a language selector. (src: app/src-tauri/tauri.conf.json:36-64)

### 3.10 Android shell
- **PLAT-080** When the Android app runs, it SHALL draw edge-to-edge and report the system-bar and display-cutout insets to the page in CSS pixels:
  - The page receives them through `window.__dlInsets(json)` on every inset change and through `DriveLensAndroid.insets()` at startup, and stores them in `--a-sat`, `--a-sar`, `--a-sab` and `--a-sal`.
  - While the keyboard is visible, the bottom inset SHALL be reported as 0, the WebView's bottom margin SHALL equal the keyboard height, and `<html>` SHALL have the class `ime`.

  (src: app/src-tauri/gen/android/app/src/main/java/com/zzflsxygod/drivelens/MainActivity.kt:22-55; app/src/platform.ts:19-27, 91-92; comment: MainActivity.kt:22-27)
- **PLAT-081** When the app theme is dark, the Android status and navigation bars SHALL use light icons; when it is light, dark icons. They SHALL update whenever `data-theme` changes. (src: MainActivity.kt:60-66; app/src/platform.ts:29-32, 93-94)
- **PLAT-082** When `shareImage(base64, name, title)` is called, the Android app SHALL take these steps:
  1. delete the earlier files in `cacheDir/share`;
  2. write the PNG there under a sanitized name;
  3. open the system share sheet with `ACTION_SEND`, `image/png`, a `FileProvider` content URI and the given title.

  It SHALL return `""` on success, or an error message. (src: MainActivity.kt:68-79; app/src-tauri/gen/android/app/src/main/res/xml/file_paths.xml:4-7)
- **PLAT-083** When `saveImage(base64, name)` is called on Android 10 or later, the Android app SHALL store the PNG through `MediaStore` in `Pictures/DriveLens/` and return `""` or an error message. Below Android 10 it SHALL return `"unsupported"`, and the share card then falls back to the share sheet. (src: MainActivity.kt:81-94; app/src/journey2.ts:183-187)
- **PLAT-084** When a file name is passed to the bridge, the Android app SHALL replace every run of characters other than letters, digits, `.`, `_` and `-` with `_`, cut the name to 80 characters, and use `DriveLens.png` if the result is empty. (src: MainActivity.kt:97)
- **PLAT-085** When the Android back button or back gesture is used, the app SHALL run `inAppBack()` (`app-shell`), and exit the app when that returns `false`. (src: app/src/platform.ts:53-58, 95; doc: CHANGELOG.md v1.2.1)
- **PLAT-086** When the Android app is installed, it SHALL request only the `INTERNET` permission, disallow app-data backup, run in portrait only and use a single task. (src: app/src-tauri/gen/android/app/src/main/AndroidManifest.xml:3, 9, 18-19; doc: CHANGELOG.md v1.1.2; doc: CHANGELOG.md v0.14.2)
- **PLAT-087** When the Android app makes network requests, the OS SHALL permit cleartext http and SHALL trust only system certificate authorities, not user-installed ones. (src: app/src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml:9-15; comment: network_security_config.xml:2-8)
- **PLAT-088** When the app checks for native sharing, `canNativeShare()` / `canNativeSave()` SHALL be true only when `window.DriveLensAndroid` provides `shareImage` / `saveImage`. (src: app/src/platform.ts:79-83)

### 3.11 License file
- **PLAT-090** When `third-party-licenses.txt` is generated, it SHALL contain:
  - a header with the app version and the AGPL source link;
  - for each npm package whose modules ended up in the bundle (once per `name@version`, ordered by package path): name, version, license field and repository, followed by the full text of its `LICENSE` / `LICENCE` / `COPYING` / `NOTICE` files (excluding `.spdx`), or a note when there is none;
  - a final section crediting the demo routes (OpenStreetMap, ODbL 1.0) and elevation (Copernicus DEM via Open-Meteo, CC BY 4.0).

  (src: app/vite.config.ts:120-155; comment: app/vite.config.ts:120-124)
- **PLAT-091** When the license file is linked, the web build SHALL link to `/third-party-licenses.txt`, and the Tauri builds to `<__WEB_ORIGIN__>/third-party-licenses.txt`. (src: app/src/links.ts:17)

### 3.12 Built targets
- **PLAT-095** When app files change on `main` or a `v*` tag is pushed, CI SHALL build the web bundle. It SHALL check that `sw.js`, `manifest.webmanifest` and `_headers` exist; on tags or a manual `target=production` it SHALL deploy to the Pages production branch, and on a manual `target=preview` it SHALL deploy to the Pages `preview` branch with `VITE_DRIVELENS_CHANNEL=preview`. (src: .github/workflows/web.yml; see ops-delivery OPS-050–OPS-055)
- **PLAT-096** When started by hand, CI SHALL build these native packages. Neither build runs automatically while they are paused.
  - Windows: an NSIS `.exe` and a `.msi`.
  - Android: a universal APK and an AAB for `aarch64`, `armv7` and `x86_64`.

  (src: .github/workflows/windows.yml:3-11, 53-60; .github/workflows/android.yml:3-9, 95-97; comment: scripts/release.conf:3-9)

## 4. Key design decisions

- **D-1 One code base, two build modes.** The PWA files (manifest, service worker, head tags, `web-public`) exist only in the web build. The Tauri build gets none of them (comment: app/vite.config.ts:11-16; comment: app/src/vite-env.d.ts:3).
- **D-2 The hosted web app is the supported distribution.** Native builds are paused (since v0.15.0), and self-hosting the web app is unofficial (doc: README.md "Quick start (server)"; comment: .github/workflows/android.yml:4; comment: scripts/release.conf:5; doc: docs/install.md "Appendix: LAN-only use").
- **D-3 The service worker caches the app shell only.** API calls carry the user's token to the user's own cross-origin server and are never intercepted or cached; neither are map tiles (comment: app/vite.config.ts:63-64, 76-77; doc: docs/install.md "6. Connect the web app"; doc: SECURITY.md "Privacy promise").
- **D-4 Navigations that carry credential-like parameters are answered from the cache.** An installed app answers such an address from its local cache without sending it over the network, so it cannot end up in a request log (comment: app/vite.config.ts:79-80; doc: CHANGELOG.md v1.1.1).
- **D-5 Network-first navigation, an explicit update toast and an update check on return to the foreground.** New versions show up, and installed PWAs that stay open for days still update (comment: app/vite.config.ts:85; comment: app/src/pwa.ts:60).
- **D-6 External links always open in the system browser, never inside the app's webview** (comment: app/src/platform.ts:2-3; comment: app/src-tauri/src/lib.rs:5).
- **D-7 Different `connect-src` per target.** The web CSP allows `https:` (every user talks to a different self-hosted server, and http would be mixed content anyway) (comment: app/web-public/_headers:2). The Tauri CSP also allows `http:`. Confirmed: Rationale for Tauri: LAN or Tailscale servers without TLS, as stated for the Android network config (comment: network_security_config.xml:2-6).
- **D-8 Android permits cleartext at the OS level, but https is the app's default.** LAN and Tailscale addresses cannot be listed in the network config. The connection test enforces "https by default", and user-installed CAs are not trusted (comment: network_security_config.xml:2-8).
- **D-9 A small JavaScript bridge in `MainActivity` for Android-only needs:** insets, status-bar icon color, share sheet and saving to Pictures (comment: MainActivity.kt:22-27; doc: CHANGELOG.md v0.14.0).
- **D-10 The license list is built from the modules actually bundled,** so dev-only tools are never listed (comment: app/vite.config.ts:121-122).
- **D-11 MapLibre's worker is a same-origin asset,** so the CSP needs only `worker-src 'self'` (comment: app/src/map.ts:11-12).
- **D-12** *(confirmed from code)* **`theme-color` follows the in-app theme rather than the system scheme.** The `media` attributes are removed at runtime (src: app/src/pwa.ts:31-35). Rationale: the browser chrome should match a manually chosen theme.

## 5. Constraints

- A secure context (https) is required for the service worker, installation, push, clipboard and Web Share. Over http on a LAN, those features are missing (src: app/src/pwa.ts:48; doc: docs/install.md "Appendix: LAN-only use").
- The service worker must be served at `/sw.js` with scope `/`, so the app must be hosted at an origin root (src: app/src/pwa.ts:51).
- Map tiles may only come from `tiles.openfreemap.org` and `tile.openstreetmap.org` in both targets (src: app/web-public/_headers:4; app/src-tauri/tauri.conf.json:25).
- No inline or third-party scripts: `script-src 'self'` in both targets (src: app/web-public/_headers:4; app/src-tauri/tauri.conf.json:27).
- Android 7.0 (API 24) or later; saving to Pictures needs Android 10 or later. The iOS minimum is set to 14.0 (src: app/src-tauri/tauri.conf.json:46-51; MainActivity.kt:83).
- Portrait only, both in the PWA manifest and in the Android manifest (src: app/vite.config.ts:44; AndroidManifest.xml:18).
- Node.js: CI uses Node 22 for the web build and Node 20 for the native builds. The install guide asks for 22.12+ or 20.19+ (src: .github/workflows/web.yml:36; .github/workflows/android.yml:32; doc: docs/install.md "Appendix: LAN-only use").

## 6. Non-goals

- Official support for self-hosting the web app (doc: README.md "Quick start (server)"; doc: docs/install.md "Appendix: LAN-only use").
- Offline data: the cache holds only the app itself, never API responses (doc: docs/install.md "6. Connect the web app").
- Push notifications in the Tauri apps (src: app/src/notify.ts:49).
- No telemetry, analytics or tracking in any target (doc: README.md "Privacy"; doc: SECURITY.md "Privacy promise").
- Confirmed (owner decision: web first, `NATIVE_BUILDS=0`): No iOS, macOS or Linux native packages are produced. The capability file lists those platforms and an iOS minimum version is set, but only an Android project exists under `app/src-tauri/gen/`, and only Windows and Android workflows exist (src: app/src-tauri/capabilities/default.json:7-13; app/src-tauri/tauri.conf.json:46-48).

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | On a first visit the page has no controlling service worker yet. When the new worker activates it calls `clients.claim()` (src: app/vite.config.ts:70). The page reloads on every `controllerchange` (src: app/src/pwa.ts:58-59), so it reloads once shortly after the first load. `main.ts` acknowledges this reload (comment: app/src/main.ts:953). | The reload is a side effect of claiming, not an update the user accepted. A first-time user filling in the setup wizard while the shell is being precached could lose their input. Possible. | Reload only after the user accepted an update (a controller existed before, or after `skipWaiting`), not on the first install. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (one reload on the very first visit). |
| CB-2 | Tauri builds link "Third-party licenses" to the hosted web app's file (src: app/src/links.ts:17). That file lists the npm packages of the current web build, not those of the installed native app. The native build's own `dist/third-party-licenses.txt` is generated but not linked (src: app/vite.config.ts:166). The Rust crates compiled into the Tauri binary are not listed in any generated file (comment: scripts/third-party-licenses.sh:3-4). | The license notice shown by a native app may not match the software it contains. Possible; native builds are paused. | Native apps show the license list of their own bundle, including the Rust crates of the Tauri shell. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Dormant while native builds are paused (`NATIVE_BUILDS=0`). |

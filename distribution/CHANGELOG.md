# Changelog

User-facing changes in DriveLens. "Server" means the drivelens-api Docker image; when a version says
*no server update needed*, only the app changed. Downloads: [Releases](https://github.com/zzflsxygod/drivelens-releases/releases).
The API upgrades its own `drivelens` schema on start; no manual SQL is needed after the one-time `setup.sql`.

## v0.16.0 — 2026-10-20
- **Notifications** (web app): Settings → Notifications. A **trip summary** when a drive ends (distance, time, energy, from → to) and a **monthly report** reminder on the 1st; each can be turned off separately, and tapping a notification opens that trip or report. Includes a "send test notification" button. iPhone / iPad: iOS 16.4+, added to the Home Screen.
- Server 0.12.0: sends the notifications (detects finished drives every minute, read-only). It creates two new tables in the `drivelens` schema by itself; no configuration needed (see the install guide, section 7).
- The web app is offered only at https://drivelens-app.oharuru.com (no more web zip in the releases).

## v0.15.1 — 2026-10-20
- Public home for DriveLens: this repository (install guide, setup files, changelog, issue tracker).
- The install guide no longer needs the source code: the server runs the prebuilt image `ghcr.io/zzflsxygod/drivelens-api`.
- App: install-guide link in the setup screen and a new "Help & feedback" section in Settings (install guide in your language, releases, feedback).
- Web app: `?demo` opens demo mode directly (https://drivelens-app.oharuru.com/?demo).
- No server update needed.

## v0.15.0 — 2026-10-20
- **Web app (PWA)** at https://drivelens-app.oharuru.com: works in any modern browser and can be installed to the home screen (also on iPhone / iPad). Share cards are downloaded or shared with the system share sheet; cover photos are picked from files.
- The setup screen explains the web requirements (https, CORS) and tells apart blocked cross-origin requests, http addresses, certificate / connection errors and being offline.
- Server 0.11.0: `DRIVELENS_CORS_ORIGINS` (allows the official web app and the Windows / Android apps by default). No database changes.

## v0.14.2 — 2026-10-20
- Demo mode: the bar with the Exit button stays fixed at the top while scrolling.
- Sticky month headers are no longer partly hidden under the top bar.
- Android: portrait only.

## v0.14.1 — 2026-10-20
- All dropdowns and menus stay inside the screen: they align to the nearest edge, open up or down depending on the space, scroll inside when long and follow rotation / keyboard.

## v0.14.0 — 2026-10-19
- **Android app** (APK / AAB): edge-to-edge layout, back gesture, saving and sharing share cards, photo picker for covers.

## v0.13.1 — 2026-10-19
- Demo mode keeps its data completely separate from your real server (selected car, caches, battery baseline).
- Server 0.10.1: journey suggestions work without a car filter again.

## v0.13.0 — 2026-10-19
- **Demo mode**: try every screen with a fictional "Demo Car" and Tokyo-area sample data, offline, without a server.

## v0.12.0 – v0.12.5 — 2026-10-19
- Unified glass-style controls (back button, page headers, pills, edit chips) with animations.
- Sliding segmented switches with direction-aware transitions (Drives / Journeys).
- Month switcher pill; page titles in the sticky header; flicker-free month changes in the report.
- Overlay scrollbar that no longer narrows the layout; consistent spacing between sections.

## v0.11.0 – v0.11.2 — 2026-10-19
- **Languages: English, 中文, 日本語** (follows the system by default, can be changed in Settings).
- Install guide in English and Japanese.
- New list toolbar (segmented control, round icon buttons, popover menus) and a matching car selector.

## v0.10.0 — 2026-10-19
- **Self-hosting for every TeslaMate user**: one `setup.sql` (read-only account + `drivelens` schema); the API creates and upgrades its tables automatically and disables only the affected features if something is missing.
- First-run setup screen with a connection test that explains what's wrong (wrong token, unreachable, not a DriveLens server, too old).
- Protection against token guessing: 10 wrong tokens from one IP within 10 minutes → temporarily refused (HTTP 429).

## v0.9.0 – v0.9.1 — 2026-10-19
- **Battery health**: degradation curve on the home screen and a detail page; baseline is the factory rated range (or the highest seen), adjustable per car; never above 100%.
- Monthly report: footprint map and 12-month trends.

## v0.8.0 — 2026-10-16
- New visual style: soft gradients, glass cards and a floating bottom bar (light and dark).

## v0.7.0 – v0.7.4 — 2026-10-16
- **Journeys, part 2**: cover image (map snapshot or your own photo, stored as a small JPEG), notes, share card (1080×1350), weather for each drive (Open-Meteo), energy by speed band.
- Continuous speed-coloured routes at every zoom level, also on covers and share cards.

## v0.6.0 – v0.6.3 — 2026-10-16
- **Journeys**: combine drives into trips, with automatic suggestions that can be dismissed.
- Infinite scrolling lists with sticky month headers and "jump to month"; scroll position is kept when going back.
- Back-to-top button; tapping the active tab scrolls to the top.

## v0.5.0 – v0.5.1 — 2026-10-16
- **Monthly report**: overview with changes vs. last month, energy and cost split (home / Supercharger / other), daily chart and calendar, records.
- The app checks the server version and hides features the server doesn't support yet instead of failing.

## v0.4.0 — 2026-10-16
- Manual charging costs per session, per-currency statistics, default currency based on location.

## v0.3.0 – v0.3.2 — 2026-10-16
- Home screen: car status, battery, range, odometer, software version, last drive and charge, monthly and total statistics; fast loading with cached data.
- Charging curve (power and state of charge).

## v0.1.0 – v0.2.0 — 2026-10-15
- First version: charging sessions, drives and route maps (MapLibre + OpenFreeMap), light / dark theme, map label language, custom place names.

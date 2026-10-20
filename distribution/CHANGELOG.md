# Changelog

User-facing changes in DriveLens. "Server" means the drivelens-api Docker image; when a version says
*no server update needed*, only the app changed. Downloads: [Releases](https://github.com/zzflsxygod/drivelens-releases/releases).
The API upgrades its own `drivelens` schema on start; no manual SQL is needed after the one-time `setup.sql`.

## v1.0.0 — 2026-10-20
**DriveLens 1.0.0, the first stable release.**

DriveLens is a companion app for [TeslaMate](https://github.com/teslamate-org/teslamate). Open the web app at **https://drivelens-app.oharuru.com** on any phone or computer and add it to your home screen (PWA). It talks directly to a small read-only API on your own server, so your token and data never pass through any DriveLens service. You can also [try the demo](https://drivelens-app.oharuru.com/?demo) without a server.

**Highlights**
- **Overview:** battery level and range, odometer, software version, outside / inside temperature, current location on a map, this month at a glance.
- **Drives and charging:** endless lists with month headers, route maps coloured by speed, charging curves, weather per drive, energy by speed band, your own place names and charging costs (any currency).
- **Journeys:** group drives into trips (with automatic suggestions), cover photo, notes and a share card.
- **Monthly reports:** distance, energy, charging cost, home vs. Supercharger split, daily breakdown, footprint map, 12-month trends; battery health curve.
- **Maps:** OpenFreeMap basemaps in light and dark, place labels in your language.
- **Push notifications:** a trip summary when a drive ends and a monthly-report reminder on the 1st, each switchable (Android, desktop, iPhone / iPad on iOS 16.4+ from the home screen).
- **Demo mode:** every feature with a fictional car, entirely in your browser.
- **Languages and themes:** English, 中文, 日本語; light and dark themes that follow your system or can be set in Settings; the new instrument-style “Telemetry” design.
- **Secure access guidance:** the setup screen and install guide explain how to give your server an https address with Cloudflare Tunnel or `tailscale serve` (Tailscale).
- **New in this version:** the “Support DriveLens” card at the bottom of Settings ([Buy Me a Coffee](https://buymeacoffee.com/zzflsxygod)).

**Server / install**
- Server: drivelens-api **0.12.0** (no update needed if you already run it). Public image `ghcr.io/zzflsxygod/drivelens-api` for amd64 and arm64.
- New installs: [install guide](https://github.com/zzflsxygod/drivelens-releases/blob/main/docs/install.md) ([中文](https://github.com/zzflsxygod/drivelens-releases/blob/main/docs/install.zh.md) · [日本語](https://github.com/zzflsxygod/drivelens-releases/blob/main/docs/install.ja.md)), with `deploy/setup.sql` (one-time read-only database account) and `deploy/docker-compose.drivelens.yml`. TeslaMate's own tables are never modified.

**Support:** DriveLens is free to use and built by one person. If it helps you, [buy me a coffee](https://buymeacoffee.com/zzflsxygod) ☕

**中文摘要：** DriveLens 1.0.0 是第一个正式版。网页版 https://drivelens-app.oharuru.com ，包含首页概览、行程与充电、旅程、月度报告、地图、演示模式、推送通知（行程小结 / 月报提醒）、中英日三语、浅色 / 深色主题和全新的 Telemetry 界面；安装指南介绍了用 Cloudflare Tunnel 或 `tailscale serve` 提供 https 的方法。设置页底部新增「支持 DriveLens」（Buy Me a Coffee）。服务器保持 0.12.0，无需更新。

**日本語の概要：** DriveLens 1.0.0 は最初の正式版です。ウェブ版 https://drivelens-app.oharuru.com で、概要、走行と充電、旅程、月次レポート、地図、デモモード、プッシュ通知（走行サマリー / 月次レポートのお知らせ）、日中英の 3 言語、ライト / ダークテーマ、新しい Telemetry デザインを利用できます。インストールガイドでは Cloudflare Tunnel や `tailscale serve` で https 化する方法を説明しています。「設定」の一番下に「DriveLens を応援する」（Buy Me a Coffee）を追加しました。サーバーは 0.12.0 のままで更新は不要です。

## v0.17.4 — 2026-10-20
- Home: the three tiles on the vehicle card (odometer, software, outside / inside temperature) always stay on one line, even on small phones; temperatures are shown in whole degrees (e.g. `20° / 22°`) and long values shrink slightly to fit.
- No server update needed.

## v0.17.3 — 2026-10-20
- Settings: once your server is set up, the **Server** section folds into one compact row (status dot, host name, app / server version). Tap it to change the address or token, test the connection or check the server version. It opens by itself when the server can't be reached or isn't set up.
- Settings order: Display, Journeys and Notifications come first; Server and Demo mode moved down, just above Help & feedback.
- No server update needed.

## v0.17.2 — 2026-10-20
- Setup screen: clearer note on why the server address must be https: the web app runs on https, so browsers block any http address, including LAN and Tailscale IPs. Tailscale users can get a free https address with `tailscale serve`; the note links to the new guide section.
- Install guide: step-by-step Tailscale setup for the web app (MagicDNS + HTTPS Certificates, `tailscale serve --bg 8080`, the `https://<machine>.<tailnet>.ts.net` address, Chrome's local network prompt).
- No server update needed.

## v0.17.1 — 2026-10-20
- Settings > Display: the setting labelled "Map theme" is now called **Theme** — it always switched the whole app (and the map follows it). Options: Follow system (default) / Light / Dark.
- No server update needed.

## v0.17.0 — 2026-10-20
- **New look**: a cleaner, instrument-style design across every screen (home, drives, journeys, charges, monthly report, battery, settings, setup and the share card). Light and dark are both fully designed and still follow your system setting (or the theme chosen in Settings).
- Numbers use a monospaced font so values line up; line icons replace the emoji; calmer basemap in light mode and restyled map controls; higher text contrast.
- Settings are grouped into sections (Server, Display, Journeys, Notifications, Help & feedback).
- The web app shows "new version available" as before; tap Reload to switch.
- No server update needed.

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

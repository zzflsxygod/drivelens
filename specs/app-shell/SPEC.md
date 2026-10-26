# app-shell — Application shell, navigation and Settings screen

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `app/src/main.ts` (boot, tabs, car selection, theme, Settings screen, banners, feature gates, sign-out
> handling, deep links), `app/src/nav.ts`, `app/src/platform.ts` (back-button part: `setRootBack`, `inAppBack`,
> `initBackButton`), `app/src/links.ts`, `app/index.html`, `CHANGELOG.md`, `app/src/locales/en.ts` (visible strings).
> In this document, "the system" means the DriveLens app shell: the code that starts the app, owns the header, the
> bottom navigation and the back stack, chooses which screen is shown, and composes the Settings screen.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

The app has no router and no framework. The shell is the one place that wires the feature modules together: it runs
the start-up sequence, decides between the setup wizard and the main UI, switches between the four tabs, keeps the
browser / Android back button consistent with what is on screen, reacts to server-status changes, and renders the
Settings screen from sections owned by other modules. It serves every DriveLens user on the web/PWA build and on the
Tauri (Windows / Android) builds.

## 2. Responsibility boundaries

### 2.1 In scope
- Start-up order and the choice of the first screen (setup wizard, `?view=` deep link, Home).
- Bottom navigation (tabs `home`, `drives`, `charges`, `settings`) and re-tap behaviour.
- Car selector (header car pill + hidden `#car` select) and the remembered car.
- Theme application (`data-theme` on `<html>`).
- In-app back stack: browser-history integration (`nav.ts`), the in-app back step (`inAppBack`), the root back
  handler and the Tauri Android back button.
- Deep links (`?view=…`) and notification-tap routing.
- Global server banner (`#srv-banner`), server re-checks, and application of feature gates to shell-owned entry points.
- Settings screen composition and the shell-owned Settings controls: Display, Journeys, Server section, demo cards,
  Help & feedback, Support and Install cards.
- Reaction to sign-out / revocation (`leftServer`, `drivelens-signed-out`).
- Publishing the header height (`--hdr-h`), the demo strip in the header, pull-to-refresh on Home.
- Public links (`links.ts`).

### 2.2 Out of scope
- Home screen content and the home snapshot cache → `app-home`.
- Drive detail, Charges list, charge detail, place-rename and cost dialogs, infinite lists → `app-records`.
- Drives tab list, select mode, journeys, suggestions, `restoreDismissed` → `app-journeys`.
- Monthly report, battery page, home battery card → `app-insights`.
- Settings storage, request layer, setup wizard, connection test, `/health` check and feature levels, URL privacy
  guard, device auth, Settings › Devices section and Sign-out card → `app-connection`.
- Settings › Notifications section, service-worker push handling → `app-notifications`.
- Popovers, sheets, control upgrades, motion, back-to-top, overlay scrollbar, icons, `DriveMap`, CSS tokens →
  `app-ui-kit`.
- Translation tables and formatting helpers → `app-i18n`.
- Demo dataset, demo server, `enterDemo` / `exitDemo`, `?demo` handling → `app-demo`.
- Platform detection, Android insets / system bars / share bridge, external-link handling, service worker, install
  prompt (`installMode`, `promptInstall`) → `app-platforms`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `app-connection` — `api`, `loadSettings` / `saveSettings` / `realServer`, `SIGNED_OUT_EVENT`, `testConnection`,
    `renderResult`, `showSetupWizard`, `normalizeUrl`, `checkServer` / `serverReady` / `onServerInfo` / `serverInfo` /
    `globalBanner` / `lacks` / `featureText` / `tooOldText` / `serverLabel` / `APP_VERSION`, `canWrite`,
    `saveConnection`, `forgetServer`, `isLeaving`, `initDeviceAuth`, `onMeChange`, `revokeOldDevice`, `mountDevices`,
    `signOutCardHTML`, `bindSignOut`, `thisDeviceText`, `defaultCurrency`, `CURRENCIES`, and the `drivelens-server-error`
    window event dispatched by `api()`.
  - `app-ui-kit` — `popMenu`, `closeMenus`, `hasOpenMenu`, `initUI`, `initSheets`, `focusField`, `initBackToTop`,
    `backToTop`, `isJumped`, `initOverlayScrollbar`, `ICON`, `ic`, `DriveMap`, `effectiveTheme`.
  - `app-i18n` — `t`, `langSetting`, `currentLang`, date / number formatters.
  - `app-demo` — `isDemo`, `enterDemo`, `exitDemo`, `skey`, `DEMO_CREDIT` (and its import-time fetch interception).
  - `app-platforms` — `initPlatform`, `initWeb`, `isWeb`, `installMode`, `promptInstall`, `onInstallChange`; build-time
    constants `__WEB_BUILD__`, `__WEB_ORIGIN__`.
  - `app-notifications` — `mountNotifications`, `initNotificationClicks`.
  - `app-home`, `app-records`, `app-journeys`, `app-insights` — the screen renderers the tabs and deep links open.
  - External: Tauri `@tauri-apps/api/app` (`onBackButtonPress`, `exit`), browser `history`, `sessionStorage`,
    `localStorage`, `matchMedia`, `ResizeObserver`, `MutationObserver`.
- **Used by:**
  - `app-journeys` — receives the `Ctx` object (`view`, `setMap`, `showDrive`, `showCharge`, `carQ`, `carId`, feature
    checks, `canWrite`); imports `navPage` / `navRoot`.
  - `app-insights` — receives the `ReportNav` callbacks and the back action for the battery page.
  - `app-connection` — uses `installGuideUrl` (setup wizard); calls the `leftServer` callback after sign-out.
  - `app-platforms` / `app-ui-kit` — `platform.ts` uses `popPage` from `nav.ts`.
- **Provided interface:**

  | Kind | Name | Purpose |
  |------|------|---------|
  | DOM | `header`, `#title`, `#car` (hidden select), `#carpill`, `#srv-banner`, `main#view`, `nav button[data-tab]` | Page skeleton (`app/index.html`) |
  | URL param | `view` = `charges`, `settings`, `drives`, `drive:<id>`, `charge:<id>`, `report[:YYYY-MM]`, `battery`, `journey:<id>`, `journeys` | Deep link / notification target |
  | URL param | `from=push` | Opened from a notification |
  | Export (`nav.ts`) | `navPage(key, back)`, `navRoot()`, `popPage()`, `initHistory(back)` | Back stack |
  | Export (`platform.ts`) | `setRootBack(fn)`, `inAppBack()` | In-app back step |
  | Export (`links.ts`) | `PUBLIC_REPO`, `installGuideUrl()`, `RELEASES_URL`, `ISSUES_URL`, `SOURCE_URL`, `THIRD_PARTY_URL` | Public links |
  | localStorage | `drivelens-last-car` (demo: namespaced via `skey`) | Remembered car |
  | localStorage | `drivelens-settings` fields `uiLang`, `theme`, `labelLang`, `currency`, `journeyGap`, `suggestionsOff` (written through `app-connection`) | Preferences |
  | sessionStorage | `drivelens-left-notice` | Notice shown by the wizard after sign-out |
  | CSS variable | `--hdr-h` on `<body>` | Real header height |
  | Body class | `demo` | Demo mode chrome |
  | Build env | `VITE_DONATE_URL`, `VITE_DONATE_WEB_ONLY` | Support card |

## 3. External behavior

### 3.1 Start-up
- **SHELL-001** When the app bundle starts, the system SHALL import the URL privacy guard before any other application module, so `api` / `token` / `key` query parameters are handled before other code runs. (src: app/src/main.ts:14; comment: app/src/main.ts:14)
- **SHELL-002** When the app bundle starts in demo mode, the system SHALL have installed the demo fetch layer before the first API request. (src: app/src/main.ts:20; src: app/src/demo.ts:82; comment: app/src/main.ts:20)
- **SHELL-003** When the app starts, the system SHALL set the theme, then mount the demo strip (demo mode only), start header-height tracking, initialise sheets, platform glue, web/PWA glue, the root back handler, the back-to-top button, the UI enhancer, the overlay scrollbar and the navigation tabs, and only then choose the first screen. (src: app/src/main.ts:44-46, 906-959)
- **SHELL-004** When the app starts and no server URL is stored and demo mode is off, the system SHALL show the setup wizard; when the wizard finishes, it SHALL start the server check, load the car list and show Home. (src: app/src/main.ts:956-958; src: app/src/api.ts:18-21)
- **SHELL-005** When the app starts with a stored server URL (or in demo mode), the system SHALL start the server check (`/health`, then device-auth initialisation), load the car list and open the screen named by the `view` query parameter, or Home when there is none. (src: app/src/main.ts:955, 959)
- **SHELL-006** When the setup wizard is shown at start-up, the system SHALL pass it the notice stored in `sessionStorage` key `drivelens-left-notice` and delete that key. (src: app/src/main.ts:957)
- **SHELL-007** When the app runs outside Tauri (web / PWA), the system SHALL enable the browser-history back stack after the first screen was chosen; Tauri builds SHALL NOT use it. (src: app/src/main.ts:960-961; comment: app/src/nav.ts:2)

### 3.2 Tabs
- **SHELL-010** When the app starts, the system SHALL render four bottom-navigation buttons `home`, `drives`, `charges`, `settings` with the icons `home`, `route`, `bolt`, `gear` and the translated labels `nav.home`, `nav.drives`, `nav.charges`, `nav.settings` (English: Home, Drives, Charging, Settings). (src: app/src/main.ts:923-924; src: app/index.html:15-20; src: app/src/locales/en.ts:127-130)
- **SHELL-011** When the user taps a tab, the system SHALL mark only that tab active and render its root screen: Home (`app-home`), the Drives tab (`app-journeys` `showDrivesTab`), the Charges list (`app-records`) or Settings. (src: app/src/main.ts:189, 909, 925-930)
- **SHELL-012** When the user taps the already active tab with a real (trusted) tap while the page is scrolled down or a list is month-jumped, the system SHALL run "back to top" (`app-ui-kit`) and SHALL NOT re-render the tab. (src: app/src/main.ts:926-927; doc: CHANGELOG.md v0.6.0 – v0.6.3)
- **SHELL-013** When a tab button receives a programmatic click, the system SHALL re-render that tab's root screen, also when it is already active. (src: app/src/main.ts:927-929)
- **SHELL-014** When the Home, Charges or Settings root screen is rendered, the system SHALL clear the detail-page levels of the back stack and destroy the currently shown map. (src: app/src/main.ts:216, 404, 686; src: app/src/nav.ts:25-26)

### 3.3 Car selection
- **SHELL-020** When the car list is loaded (`GET /api/cars`), the system SHALL fill the hidden `#car` select with one option per car, labelled with `name`, else `marketing_name`, else `Car <id>`, and SHALL keep the previous selection when that car is still in the list. (src: app/src/main.ts:157-166, 169)
- **SHELL-021** When at least one car is known, the system SHALL show the header car pill with the selected car's name (the first car when none is selected); when no car is known or loading the list fails, it SHALL hide the pill. (src: app/src/main.ts:165, 171-180)
- **SHELL-022** When exactly one car is known, the system SHALL show the pill without a chevron and SHALL ignore taps on it. (src: app/src/main.ts:175-177, 182; src: app/src/style.css:225)
- **SHELL-023** When two or more cars are known and the user taps the pill, the system SHALL open a popover menu with one entry per car (name, plus the model as subtitle when it differs from the name) and the current car checked. (src: app/src/main.ts:170, 181-186)
- **SHELL-024** When the user picks a different car, the system SHALL store its id under the last-car key (`drivelens-last-car`, demo-namespaced in demo mode) and re-render the active tab. (src: app/src/main.ts:185, 567, 931)
- **SHELL-025** When a screen needs the current car, the system SHALL use the selected car; else the remembered car while the list loads in the background; else the first car of a freshly loaded list. (src: app/src/main.ts:576-592)
- **SHELL-026** When the remembered car is not in the loaded list (removed, or another server), the system SHALL select the first car, remember it and re-render the active tab. (src: app/src/main.ts:581-587; comment: app/src/main.ts:584)

### 3.4 Theme
- **SHELL-030** When the app starts, the system SHALL set `<html data-theme>` to the stored `theme` when it is `light` or `dark`, and otherwise to the operating system's `prefers-color-scheme`. (src: app/src/main.ts:46; src: app/src/map.ts:25-29)
- **SHELL-031** When the operating system colour scheme changes, the system SHALL update `data-theme` to the new effective theme. (src: app/src/main.ts:45)
- **SHELL-032** When the user changes Settings › Theme, the system SHALL store it and apply it at once to the page and to the map on screen. (src: app/src/main.ts:44, 453; doc: CHANGELOG.md v0.17.1)

### 3.5 Back navigation
- **SHELL-040** When an in-app back step runs, the system SHALL do exactly one of the following, in this order: close the open popover menu; close the topmost sheet as if its backdrop was tapped (and remove it if it is still present); hide the open journey menu `#j-menu`; leave select mode (`#selmode.active`); press the visible page back button in `#view`; leave a detail page that is still loading; run the root back handler. (src: app/src/platform.ts:38-51; doc: CHANGELOG.md v1.2.1)
- **SHELL-041** When the root back handler runs while the setup wizard is shown, the system SHALL report that nothing is left to go back to. (src: app/src/main.ts:912-914)
- **SHELL-042** When the root back handler runs on a tab other than Home, or while Home is not rendered, the system SHALL switch to the Home tab. (src: app/src/main.ts:915-917; doc: CHANGELOG.md v1.2.1)
- **SHELL-043** When the root back handler runs on the rendered Home tab, the system SHALL report that nothing is left. (src: app/src/main.ts:918)
- **SHELL-044** When the Android back button is pressed in the Tauri app and the in-app back step reports that nothing is left, the system SHALL exit the app. (src: app/src/platform.ts:53-58; doc: CHANGELOG.md v1.2.1)
- **SHELL-045** When the browser-history back stack is enabled, the system SHALL keep the number of history entries above the root equal to the UI depth: 1 for a tab other than Home, plus 1 per detail page, plus 1 per open sheet, open popover menu, open journey menu and active select mode; in setup mode only open sheets SHALL count. (src: app/src/nav.ts:33-39, 54-61; comment: app/src/nav.ts:4-5)
- **SHELL-046** When the UI gets deeper, the system SHALL push history entries for the same URL that differ only in `history.state.dl`. (src: app/src/nav.ts:59; comment: app/src/nav.ts:6-7)
- **SHELL-047** When the UI gets shallower through an in-app action (page back button, cancel, backdrop, Esc, tab switch), the system SHALL remove the surplus history entries with `history.go(-n)`. (src: app/src/nav.ts:47-52, 60; comment: app/src/nav.ts:7-8)
- **SHELL-048** When the browser reports a backward move of n entries that the app did not start, the system SHALL run n in-app back steps, and SHALL stop and clear the detail-page levels as soon as a step reports that nothing is left. (src: app/src/nav.ts:69-76)
- **SHELL-049** When the browser reports a forward move, the system SHALL return to the previous history position and SHALL NOT re-open any screen. (src: app/src/nav.ts:77; comment: app/src/nav.ts:77)
- **SHELL-050** When a history move started by the app produces no `popstate` within 1.5 s, the system SHALL resume syncing from the current `history.state.dl`. (src: app/src/nav.ts:47-52; comment: app/src/nav.ts:49)
- **SHELL-051** When a detail page is rendered with a key that is already on the stack, the system SHALL cut the stack back to that level and replace its back action; a new key SHALL add one level. (src: app/src/nav.ts:18-24)
- **SHELL-052** When the user clicks a page back button inside `#view`, the system SHALL remove one detail-page level. (src: app/src/nav.ts:79-83)
- **SHELL-053** When the browser-history back stack is enabled, the system SHALL set `history.scrollRestoration` to `manual`. (src: app/src/nav.ts:67; comment: app/src/nav.ts:67)

### 3.6 Deep links and notification targets
- **SHELL-060** When the app starts with a stored server and `?view=<v>`, the system SHALL open: `charges` → Charges tab; `settings` → Settings tab; `drives` → Drives tab; `drive:<id>` → that drive's detail with the Drives tab marked active; `charge:<id>` → that charge's detail with the Charges tab marked; `report` or `report:<month>` → the monthly report; `battery` → the battery page of the current car; `journey:<id>` → that journey with the Drives tab marked; `journeys` → the journey list with the Drives tab marked; any other value → Home. (src: app/src/main.ts:934-951)
- **SHELL-061** When a `report:` target carries a month that does not match `^\d{4}-(0[1-9]|1[0-2])$`, the system SHALL open the current month. (src: app/src/main.ts:945; comment: app/src/main.ts:945; doc: CHANGELOG.md v1.1.2)
- **SHELL-062** When a `journey:` or `journeys` target is opened, the system SHALL wait for the running server check before rendering it. (src: app/src/main.ts:947-948)
- **SHELL-063** When a notification is tapped while the app is open (service-worker message or `drivelens-open` event), a server URL is configured and the setup wizard is not shown, the system SHALL close an open popover menu, remove an open sheet and open the target as in SHELL-060. (src: app/src/main.ts:952; src: app/src/notify.ts:186-192)
- **SHELL-064** When the page was opened with `from=push` and a service worker controls it, the system SHALL replace the address with the bare path, so a later reload does not reopen the target. (src: app/src/main.ts:953-954; comment: app/src/main.ts:953)
- **SHELL-065** When the app reads its address, the system SHALL NOT take a server URL or token from it. (comment: app/src/main.ts:933; doc: README.md "Privacy")

### 3.7 Server banner and feature gates
- **SHELL-070** When the server status changes, the system SHALL show `#srv-banner` with the text from `app-connection` (`globalBanner`: server unreachable, or below the minimum API level) and hide it when there is no such text. (src: app/src/main.ts:845-848, 864-865; src: app/src/version.ts:58-62)
- **SHELL-071** When a screen asks the shell to show a specific banner text (`showBanner`), the system SHALL show that text instead of the global text until the banner is closed or retried. (src: app/src/main.ts:844, 857)
- **SHELL-072** When the user taps the banner's Retry button, the system SHALL show "Checking…", re-check the server and, if no global banner text remains, re-render the active tab. (src: app/src/main.ts:850-854)
- **SHELL-073** When the user taps the banner's close button, the system SHALL hide the banner and drop the screen-specific text. (src: app/src/main.ts:855)
- **SHELL-074** When an API request fails with HTTP 404, 502 or 503 (window event `drivelens-server-error`), the system SHALL re-check the server at most once per 10 s, and SHALL show the "too old" banner for API level 7 when the server answers with the legacy plain-text health response. (src: app/src/main.ts:881-885; src: app/src/api.ts:88-89; comment: app/src/api.ts:88)
- **SHELL-075** When the window gains focus more than 5 minutes after the last re-check made by SHELL-074 or SHELL-075, the system SHALL re-check the server. (src: app/src/main.ts:886)
- **SHELL-076** When the server status changes, and when Home paints its month card, the system SHALL hide every `a[data-report]` link while the server is known to lack the monthly report (API level below 6), and refresh the Settings server-version label. (src: app/src/main.ts:765, 858-865; src: app/src/version.ts:10, 52)
- **SHELL-077** When the shell hands context to the Drives / Journeys screens, the system SHALL expose feature availability as functions evaluated at call time (journeys, suggestion dismissal, paging, journeys phase 2, `canWrite`) together with the server's explanation texts. (src: app/src/main.ts:826-840)

### 3.8 Settings screen composition
- **SHELL-080** When the Settings tab is shown, the system SHALL render, in this order: the demo card (demo mode only); Display; Journeys; the Notifications slot; the Install-as-app slot; the Server section (followed by the Try-demo card when demo mode is off); the Devices slot; the Sign-out card; Help & feedback; the Support card. (src: app/src/main.ts:406-437; doc: CHANGELOG.md v0.17.3)
- **SHELL-081** When the Settings tab is shown, the system SHALL mount the Notifications section (`app-notifications`), the Devices section and the sign-out action (`app-connection`), and SHALL pass `leftServer` as the callback for leaving the server. (src: app/src/main.ts:438-441)

### 3.9 Display and Journeys preferences
- **SHELL-090** When the user changes Language (System default, 中文, English, 日本語), the system SHALL store `uiLang` as `auto`, `zh`, `en` or `ja` (storing `auto` explicitly) and reload the page. (src: app/src/main.ts:411-413, 447-452; comment: app/src/main.ts:450-451)
- **SHELL-091** When the user changes Theme (Follow system, Light, Dark), the system SHALL store `theme` as `auto`, `light` or `dark`. (src: app/src/main.ts:414-416, 446, 453)
- **SHELL-092** When the user changes Map label language, the system SHALL store `labelLang` as `ja`, `zh`, `en` or `local`, or remove `labelLang` for "Same as app language". (src: app/src/main.ts:417-419, 446, 468-472)
- **SHELL-093** When Settings is shown, the Default currency selector SHALL list `JPY CNY USD EUR HKD TWD KRW GBP AUD CAD SGD CHF`, preselect the stored currency or else the device-locale currency, and store `currency` on change. (src: app/src/main.ts:420, 465-467; src: app/src/api.ts:103-115)
- **SHELL-094** When Settings is shown, the journey-suggestion gap selector SHALL offer 30, 60, 90, 120, 180 and 240 minutes, preselect the stored `journeyGap` or 60, and store `journeyGap` on change. (src: app/src/main.ts:426, 454-456)
- **SHELL-095** When the user toggles "Show journey suggestions", the system SHALL store `suggestionsOff` as the inverse of the checkbox. (src: app/src/main.ts:428, 457-459)
- **SHELL-096** When the device can write, the system SHALL show "Restore dismissed suggestions"; tapping it SHALL show `…` and then the result text returned by `app-journeys` `restoreDismissed`. On a read-only device the button SHALL NOT be shown. (src: app/src/main.ts:429, 460-464)
- **SHELL-097** When any preference is saved, the system SHALL merge the changed field into the current stored settings and keep all other fields. (src: app/src/main.ts:450, 453, 456, 459, 467, 469-471; src: app/src/api.ts:24-28)

### 3.10 Settings › Server section
- **SHELL-100** When Settings is shown in demo mode, the Server section SHALL contain only the version line (app version, server label, Check button). (src: app/src/main.ts:349-351)
- **SHELL-101** When Settings is shown outside demo mode, the Server section SHALL be a collapsible card: a header row (status dot, host of the stored URL or "No server set", state text, app and server versions) and a body (version line, API URL field, "this device" text, credential field of type password, "Save & test connection" button, message area). (src: app/src/main.ts:352-367)
- **SHELL-102** When Settings is shown, the Server card SHALL start expanded when no URL or token is stored and collapsed otherwise. (src: app/src/main.ts:394-397, 443; doc: CHANGELOG.md v0.17.3)
- **SHELL-103** When the server becomes unreachable or is not configured, and the user has not opened or closed the card during this Settings visit, the system SHALL expand the card. (src: app/src/main.ts:372, 392; doc: CHANGELOG.md v0.17.3)
- **SHELL-104** When the server status is painted, the header row SHALL show "Not set" (no URL or token), "Connected" (status ok or legacy), "Can't connect" (unreachable) or "Checking…", and the server version as `v<version>` (ok), `<0.5.1` (legacy) or `—`. (src: app/src/main.ts:384-391; src: app/src/locales/en.ts:56-59)
- **SHELL-105** When the card is collapsed, the system SHALL set `aria-expanded="false"` and take the body's inputs and buttons out of the tab order; when expanded, it SHALL restore them. (src: app/src/main.ts:373-378)
- **SHELL-106** When the user taps Check, the system SHALL show "Checking…", re-check the server and repaint the section. (src: app/src/main.ts:442)
- **SHELL-107** When Settings is shown, the credential field SHALL be empty (the saved token is never displayed), with a placeholder that says to fill it only to change the connection when a server is stored. (src: app/src/main.ts:364; src: app/src/locales/en.ts:512-513; doc: CHANGELOG.md v1.2.0)
- **SHELL-108** When the user presses "Save & test" with an empty credential field and a URL that, normalised, differs from the stored server, the system SHALL show `set.credNeeded` and SHALL NOT test. (src: app/src/main.ts:480-482; doc: CHANGELOG.md v1.2.0)
- **SHELL-109** When the user presses "Save & test" otherwise, the system SHALL run the connection test with the typed credential, or with the stored credentials when the field is empty, and show the result. (src: app/src/main.ts:479-484)
- **SHELL-110** When the connection test fails, the system SHALL keep the stored connection unchanged. (src: app/src/main.ts:485; comment: app/src/main.ts:485)
- **SHELL-111** When the connection test succeeds, the system SHALL set the URL field to the tested URL, clear the credential field, first revoke the old device on its old server when a typed credential produced a different token, save the new connection, re-check the server and device auth, re-render Settings if it is still shown, and reload the car list. (src: app/src/main.ts:486-491; comment: app/src/main.ts:487)

### 3.11 Demo-mode chrome
- **SHELL-120** When demo mode is active, the system SHALL add class `demo` to `<body>` and append a status strip (`role="status"`) as the last row inside the sticky header, with the text "Demo mode · fictional data" and an Exit button that leaves demo mode. (src: app/src/main.ts:334-344; comment: app/src/main.ts:334-335; doc: CHANGELOG.md v0.14.2)
- **SHELL-121** When Settings is shown in demo mode, the system SHALL show first a demo card that explains demo mode, names where exiting returns to (the stored server URL, or the setup wizard when none is stored), notes that map tiles need the internet, offers "Exit demo", and shows the demo data credit. (src: app/src/main.ts:315-323, 408)
- **SHELL-122** When Settings is shown outside demo mode, the system SHALL show a "Try demo mode" card whose button enters demo mode. (src: app/src/main.ts:368-369, 473-474)
- **SHELL-123** When Settings is shown in demo mode, the system SHALL NOT offer the "Save & test" action. (src: app/src/main.ts:351, 475)

### 3.12 Help, support and install cards
- **SHELL-130** When Settings is shown, the Help & feedback card SHALL link to: the install guide in the UI language (`docs/install.md`, `docs/install.zh.md` or `docs/install.ja.md` on GitHub `main`), the releases page, the new-issue chooser, the source repository, and the third-party license list (`/third-party-licenses.txt` in the web build, `<web origin>/third-party-licenses.txt` in Tauri builds); every link SHALL open with `target="_blank"` and `rel="noopener noreferrer"`. (src: app/src/main.ts:506-512; src: app/src/links.ts:6-17; doc: CHANGELOG.md v1.1.2)
- **SHELL-131** When the build-time `VITE_DONATE_URL` starts with `https://`, the system SHALL show a Support card whose button label is "Buy me a coffee" (buymeacoffee.com; the project's donation page is Buy Me a Coffee), "Ko-fi" (ko-fi.com), "GitHub Sponsors" (github.com) or "Support the developer"; it SHALL hide the card when the URL is missing or not https, and in non-web builds when `VITE_DONATE_WEB_ONLY` is `1`. (src: app/src/main.ts:497-519)
- **SHELL-132** When the install mode is `prompt`, the system SHALL show an "Install as an app" card with an Install button that opens the browser's install prompt; when it is `ios`, the card SHALL show the manual Share → Add to Home Screen text; otherwise the card SHALL be absent. The card SHALL re-render when install availability changes while Settings is shown. (src: app/src/main.ts:520-531; src: app/src/locales/en.ts:462-465)

### 3.13 Leaving the server
- **SHELL-140** When the Devices section or the Sign-out card reports that this device left the server, the system SHALL store the optional notice in `sessionStorage` key `drivelens-left-notice` and reload the page at its bare path, so no in-memory data of the old server survives. (src: app/src/main.ts:869-874; comment: app/src/main.ts:870)
- **SHELL-141** When the window event `drivelens-signed-out` fires while the app is not already leaving and demo mode is off, the system SHALL forget the server (`app-connection` `forgetServer`) and then reload into the setup wizard with the notice "This device was disconnected …". (src: app/src/main.ts:875-878; src: app/src/locales/en.ts:562; doc: CHANGELOG.md v1.2.0)
- **SHELL-142** When the device-auth identity changes, the system SHALL refresh the "this device" text in the Server section. (src: app/src/main.ts:879)

### 3.14 Header, layout and gestures
- **SHELL-150** When the header changes size, the system SHALL set the CSS variable `--hdr-h` on `<body>` to the header's rendered height in whole pixels (via `ResizeObserver`, or window `resize` when it is unavailable). (src: app/src/main.ts:324-333; comment: app/src/main.ts:324-326)
- **SHELL-151** When `<body>` has class `setup-mode`, the system SHALL hide the header, the bottom navigation, the server banner and the demo strip. (src: app/src/style.css:114)
- **SHELL-152** When the Home tab is active and the page is scrolled to the top, a downward touch drag SHALL grow a hint of up to 70 px that reads "Pull to refresh" and, beyond 60 px, "Release to refresh"; releasing beyond 60 px SHALL re-render Home. (src: app/src/main.ts:888-904; src: app/src/locales/en.ts:118-119)

## 4. Key design decisions
- **D-1 Imperative screens, no router.** Each screen renders HTML into `#view`; the back stack is a list of detail-page keys plus counted overlays. Rationale: "The app renders its screens imperatively, so instead of a router this keeps the browser history *as deep* as the UI." (comment: app/src/nav.ts:4-5). Consequence: screen state is not addressable by URL except through `?view=`.
- **D-2 One back step = one UI level.** Back closes the topmost overlay first, then a detail page, then returns to Home, then leaves the app. Rationale: users expect the Android / browser back button to stay inside the app. (doc: CHANGELOG.md v1.2.1; comment: app/src/platform.ts:38)
- **D-3 Nothing private in the address.** History entries reuse the same URL and only change `history.state.dl`; credentials are never read from the URL. (comment: app/src/nav.ts:6-7; comment: app/src/main.ts:933; doc: README.md "Privacy")
- **D-4 Language change reloads.** Changing the UI language reloads the page instead of re-rendering each view. (comment: app/src/main.ts:451; comment: app/src/i18n.ts:37)
- **D-5 Leaving a server is a full reload.** Sign-out and revocation reload into the setup wizard so no in-memory data of the old server survives. (comment: app/src/main.ts:870)
- **D-6 Server section folds once configured.** It opens by itself only when the server is unreachable or not set up. (doc: CHANGELOG.md v0.17.3)
- **D-7 Settings order.** Display, Journeys and Notifications come first; Server and Demo mode sit just above Help & feedback. (doc: CHANGELOG.md v0.17.3)
- **D-8 Measured header height.** The real header height is published as `--hdr-h` instead of a hard-coded guess, so sticky elements line up. (comment: app/src/main.ts:324-326)
- **D-9 Demo strip inside the header.** The strip is a row of the sticky header, not a separate sticky element, so it cannot drift. (comment: app/src/main.ts:334-335; doc: CHANGELOG.md v0.14.2)
- **D-10 Feature checks are late-bound.** The shell passes functions (not booleans) to feature screens, so a server check that finishes later changes what they show. Confirmed from code. (src: app/src/main.ts:826-840)
- **D-11 Source and licenses are linked from the app.** The source link satisfies AGPL-3.0 §13. (comment: app/src/links.ts:14; doc: CHANGELOG.md v1.1.2)

## 5. Constraints
- Journey-suggestion gap choices: 30, 60, 90, 120, 180, 240 minutes; default 60. (src: app/src/main.ts:426, 455)
- Server re-check after a 404/502/503 failure: at most once per 10 s; focus re-check after more than 5 min. (src: app/src/main.ts:883, 886)
- History traversal watchdog: 1.5 s. (src: app/src/nav.ts:50)
- Pull-to-refresh threshold 60 px, hint height capped at 70 px. (src: app/src/main.ts:897, 903)
- Report deep-link months must match `^\d{4}-(0[1-9]|1[0-2])$`. (src: app/src/main.ts:945)
- The browser-history integration needs `history.pushState`; it is only enabled on non-Tauri builds. (src: app/src/nav.ts:65; src: app/src/main.ts:961)
- The Android back button integration needs the Tauri app API (`@tauri-apps/api/app`). (src: app/src/platform.ts:53-58)
- The Support card requires an `https://` donation URL at build time. (src: app/src/main.ts:498, 514)

## 6. Non-goals
- URL routing or shareable screen URLs beyond the `?view=` targets. (comment: app/src/nav.ts:4-7)
- Re-opening screens on browser Forward. (comment: app/src/nav.ts:77)
- Accepting server credentials through the URL. (comment: app/src/main.ts:933; doc: CHANGELOG.md v1.1.1)
- Rendering screen content; the shell only dispatches to feature modules (see 2.2).
- Showing the saved token in Settings. (doc: CHANGELOG.md v1.2.0)

## 7. Current behavior vs. intended behavior
| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | Trip notifications carry `?view=drive:<id>&car=<car_id>` (src: api/src/push.rs:203). The service worker forwards only `view` to an open window (src: app/vite.config.ts:107-110), and `openView` never reads `car` (src: app/src/main.ts:934-951). The drive opens, but the car selector keeps the last-used car, so Back from the drive shows another car's list on multi-car servers. | The server adds `car` deliberately; nothing consumes it. Possible. | Opening a notification target selects the car named by `car` before showing the drive. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor, multi-car only (X-6). |
| CB-2 | `applyFeatureGates` toggles the `month-card` class on elements selected by `.month-card[data-report]` (src: app/src/main.ts:861). Once the class is removed (server lacks the report), the selector no longer matches, so a later status change cannot add it back until Home is re-rendered. | A toggle that can only switch one way. Low impact (hover/press styling only). Possible. | The gate is reversible when the server status changes. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic. |
| CB-3 | `lastCheck` starts at 0 and the start-up server check does not update it (src: app/src/main.ts:881, 886, 955), so the first window `focus` event after start-up triggers an extra `/health` check even if one just ran. | The 5-minute throttle suggests checks should be spaced. Likely, minor. | The start-up check also counts as the last check. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (one extra `/health` request). |
| CB-4 | `app/index.html` declares `lang="zh-CN"` and Chinese tab labels (首页, 行程, 充电, 设置) (src: app/index.html:2, 16-19); they are replaced at run time (src: app/src/main.ts:924; src: app/src/i18n.ts:43). | Leftover from the Chinese-only versions before v0.11.0 (doc: CHANGELOG.md v0.11.0 – v0.11.2). Cosmetic; visible only before the script runs. Possible. | Neutral or language-independent placeholders. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (visible only before the script runs). |

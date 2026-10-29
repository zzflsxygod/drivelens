# app-journeys — Drives tab, journeys and share cards (client)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `app/src/journey.ts`, `app/src/journey2.ts`, the journey context and Journeys settings in `app/src/main.ts`
> (`:189`, `:426-429`, `:454-464`, `:826-840`, `:947-948`), visible strings in `app/src/locales/en.ts`, `CHANGELOG.md`.
> In this document, "the system" means the web/Tauri app's Drives tab (drive list with select mode, Journeys segment),
> journey detail and editing pages, cover handling, share card, weather and speed-band views.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Give the user one place to browse their drives and to group them into journeys (trips): create a journey from selected
drives or from an automatic suggestion, see a journey's route, elevation, timeline, totals, weather and energy by speed,
give it a cover and share it as an image card (doc: `README.md` "Features"; `CHANGELOG.md` v0.6.0, v0.7.0). Read-only
devices can view everything but get no editing entry points (doc: `CHANGELOG.md` v1.2.0).

## 2. Responsibility boundaries

### 2.1 In scope
- The Drives tab: the "Drives | Journeys" segment control, the drive list cards and the select mode used to create journeys.
- Journey list, suggestion cards (create, dismiss, collapse, open as preselection), journey detail page, name/note dialog,
  "Add / remove drives" page, delete.
- Cover from a photo or from the current map, share card rendering and the share/save/copy dialog.
- Weather chips and table, speed-band view, elevation chart.
- Local fallback storage of dismissed suggestions and the "restore dismissed suggestions" action.
- Feature gating by server API level for these screens (levels 8, 9, 10, 11) and read-only hiding.

### 2.2 Out of scope
- Server behavior of `/api/journeys*` → `api-journeys`.
- The infinite list component (paging, month headers, month jump, scroll restore) → `app-records` (`infinite.ts`).
- Drive and charge detail pages opened from here → `app-records`.
- `DriveMap` (MapLibre wrapper, speed colouring, stop markers) → `app-ui-kit`.
- Popover placement (`trackPopover`), bottom-sheet keyboard handling (`focusField`) → `app-ui-kit`.
- History/back stack (`navPage`, `navRoot`, `inAppBack`) and deep links (`?view=journey:<id>`, `?view=journeys`) → `app-shell`.
- Settings screen layout (the Journeys section is rendered by `app-shell`; this module provides `restoreDismissed`).
- Request layer, error mapping, settings storage, server feature levels → `app-connection`.
- Android share/save bridge → `app-platforms`. Translations → `app-i18n`. Demo-mode answers → `app-demo`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-journeys` — all `/api/journeys*` endpoints; `api-records` — `GET /api/drives` (drive list).
  - `app-connection` — `api()` (`app/src/api.ts:53-94`), `loadSettings`/`saveSettings` (settings keys below), `fmtMoney`,
    `canWrite()` (passed in `Ctx`), feature levels via `lacks()` (`app/src/version.ts:10`, `:52`).
  - `app-records` — `infiniteList` (`app/src/journey.ts:112-126`), `ctx.showDrive`, `ctx.showCharge`.
  - `app-ui-kit` — `DriveMap`, `SPEED_STOPS` (`app/src/map.ts:61`), `trackPopover`, `ICON`, `ic`, `focusField`.
  - `app-shell` — `navPage`/`navRoot` (`app/src/nav.ts`), back handling of `#j-menu` and `#selmode` (`app/src/platform.ts:43-46`, `app/src/nav.ts:35`), the `Ctx` object (`app/src/main.ts:826-840`).
  - `app-platforms` — `canNativeShare`, `canNativeSave`, `nativeShareImage`, `nativeSaveImage` (`app/src/platform.ts:79-83`).
  - `app-i18n` — `t()`, date/number formatting.
  - Browser APIs: `createImageBitmap`, canvas, `navigator.share`/`canShare`, `navigator.clipboard` + `ClipboardItem`, `URL.createObjectURL`.
- **Used by:**
  - `app-shell` — `showDrivesTab` for the Drives tab (`app/src/main.ts:189`), `showJourney`/`showJourneys` for deep links (`app/src/main.ts:947-948`), `restoreDismissed` from Settings (`app/src/main.ts:463`).
- **Provided interface:**
  - Exports: `showDrivesTab(ctx)`, `showDriveList(ctx, mode?, preselect?, restore?)`, `showJourneys(ctx)`, `showJourney(ctx, id)`, `restoreDismissed(ctx)`, type `Ctx`, `JourneyRow` (`app/src/journey.ts:15-35`, `:67`, `:72`, `:169`, `:253`, `:408`); `journey2.ts` helpers `loadCover`, `mapSnapshot`, `photoToCover`, `saveCover`, `resetCover`, `loadWeather`, `weatherChip`, `weatherTable`, `loadBands`, `bandsHTML`, `renderCard`, `shareDialog` (`app/src/journey2.ts:16-206`).
  - Settings keys (in the app settings object): `journeyGap`, `speedColor`, `speedColorMax`, `suggestionsOff`, `suggestionsCollapsed`, `dismissedDrives` (`app/src/api.ts` Settings).
  - Back-stack keys: `journey:<id>`, `jedit:<id>` (`app/src/journey.ts:254`, `:370`).

## 3. External behavior

### 3.1 Feature gating
- **AJRN-001** When the server's API level is known and below 8, the system SHALL show the Drives tab with the title "Drives", without the segment control and without the Select button. (src: `app/src/journey.ts:59`, `:77-79`; `app/src/main.ts:833`; `app/src/version.ts:10`)
- **AJRN-002** When the server's API level is not known, the system SHALL treat all journey features as available. (src: `app/src/version.ts:52`; comment: `app/src/version.ts:51`)
- **AJRN-003** When the journey list is opened while journeys are unavailable (e.g. through a deep link), the system SHALL show an error card with the "server too old" text instead of the list. (src: `app/src/journey.ts:172`; `app/src/main.ts:834`)
- **AJRN-004** When the API level is below 9, the system SHALL remember dismissed suggestions only on this device. (src: `app/src/journey.ts:398-405`; `app/src/main.ts:835`)
- **AJRN-005** When the API level is below 10, the system SHALL load the drive list without keyset paging and without month totals. (src: `app/src/journey.ts:113-114`; `app/src/main.ts:836`)
- **AJRN-006** When the API level is below 11, the journey detail SHALL omit the share button, the cover menu, the cover hero, the "Energy by speed" and "Weather & efficiency" sections, and SHALL show the note "Covers, share card, weather and energy by speed: <server too old text>". (src: `app/src/journey.ts:264`, `:292-303`, `:319-320`, `:337`; `app/src/locales/en.ts:408`)

### 3.2 Drives tab
- **AJRN-010** When the Drives tab is opened, the system SHALL show the segment used last in this app session ("Drives" on first use); the choice is not persisted across reloads. (src: `app/src/journey.ts:66-67`)
- **AJRN-011** When the user taps a segment, the system SHALL switch between the drive list and the journey list. (src: `app/src/journey.ts:58-65`)
- **AJRN-012** When the drive list is shown, the system SHALL request `/api/drives` filtered by the selected car and render each drive as a card with "start → end", start time, duration, a journey badge (name) when the drive belongs to a journey, distance (km), battery % start → end and Wh/km, under month headers with drive count, km and duration. (src: `app/src/journey.ts:84-90`, `:112-117`, `:53`)
- **AJRN-013** When the user taps a drive card outside select mode, the system SHALL open that drive's detail; its back action SHALL return to the drive list at the previous scroll position. (src: `app/src/journey.ts:118-120`; doc: `CHANGELOG.md` v1.2.1 "Lists keep their scroll position")

### 3.3 Drive list: place search (api_level ≥ 16)

- **AJRN-014** When the server supports drive place search (`driveSearch`, api_level ≥ 16), the system SHALL show a search button in the drive-list toolbar; on older servers the button SHALL be hidden. (src: `app/src/journey.ts` `canSearch` / `lacks("driveSearch")`; issue #18)
- **AJRN-015** When the search button is tapped, the system SHALL show an inline search input under the toolbar (not a new bottom tab; no separate Clear text button). The input's native clear control (×), Escape with a non-empty query, or emptying the field SHALL clear the query and restore the unfiltered list; Escape or the search icon with an empty query SHALL hide the bar. (src: `app/src/journey.ts` search bar)
- **AJRN-016** When the user types in the search input, the system SHALL debounce (~300 ms), trim the query, and reload the drive infinite list with `q=<query>` on `GET /api/drives`, using a distinct cache key. Empty query SHALL omit `q`. (src: `app/src/journey.ts` `mountList`; depends: `api-records` REC-033)
- **AJRN-017** Place search SHALL apply only to the Drives segment (not Journeys). While a non-empty search is active, month jump SHALL be hidden/disabled (`allowJump: false`). Switching to Journeys leaves search (segment remounts the journeys view). (src: `app/src/journey.ts` `allowJump: !q`; `app/src/infinite.ts` `allowJump`)
- **AJRN-018** When a search returns no drives, the system SHALL show the empty-state message for no place matches (`drives.noSearch`). (src: `app/src/journey.ts` `empty`; `app/src/locales`)

### 3.4 Select mode and creating a journey
- **AJRN-020** When journeys are available and the device can write, the system SHALL show a Select button in the list toolbar; otherwise no Select button is shown. (src: `app/src/journey.ts:77-80`; comment: `:77`)
- **AJRN-021** When the user taps Select, the system SHALL enter select mode: the button becomes a "✕ Cancel" pill, the tip "Select drives to merge (drives already in a journey can't be picked)" appears, and loaded cards show check boxes without losing the scroll position. Tapping Cancel SHALL leave select mode and clear the selection. (src: `app/src/journey.ts:91-98`, `:128-136`; `app/src/locales/en.ts:371`)
- **AJRN-022** When a drive already belongs to a journey, the system SHALL show its card disabled in select mode and ignore taps on it. (src: `app/src/journey.ts:84`, `:121`)
- **AJRN-023** When in select mode, the system SHALL show an action bar with "<n> selected", the total km of the selected loaded drives, and a "Merge into journey" button that is disabled while nothing is selected. (src: `app/src/journey.ts:99-101`)
- **AJRN-024** When the user taps "Merge into journey", the system SHALL open the name dialog with the default name "<start of earliest selected drive> → <end of latest selected drive>" (`?` for unknown parts; "New journey" when no selected drive is loaded) and a hint with the count and time range; on save it SHALL `POST /api/journeys` with `{name, note, drive_ids}`, leave select mode and open the new journey's detail. (src: `app/src/journey.ts:103-110`; `app/src/locales/en.ts:375-376`)
- **AJRN-025** When the browser or Android back button is pressed in select mode, the system SHALL leave select mode instead of leaving the screen. (src: `app/src/platform.ts:45-46`; `app/src/nav.ts:35`; doc: `CHANGELOG.md` v1.2.1)

### 3.5 Name / note dialog
- **AJRN-030** When the name/note dialog is open, the system SHALL limit the name input to 200 characters and the note to 2000, submit on Enter (not while an IME is composing), close on Cancel or a backdrop tap, and show the error "Name can't be empty" inline when the trimmed name is empty. (src: `app/src/journey.ts:141-157`; `app/src/locales/en.ts:14`)
- **AJRN-031** When saving, the system SHALL send the trimmed name and the trimmed note; editing a journey sends `""` for an empty note (clears it on every server version; v1.2.3+), creating one sends `null`, and show a server error message inline without closing the dialog. (src: `app/src/journey.ts:156-160`)
- **AJRN-032** When the dialog has a delete action, the first tap on "Delete journey" SHALL only change the label to "Delete? (the drives themselves are kept)", and the second tap SHALL delete. (src: `app/src/journey.ts:161-165`; `app/src/locales/en.ts:380-381`)

### 3.6 Journey list
- **AJRN-040** When the Journeys segment is shown, the system SHALL request `GET /api/journeys?limit=200` filtered by the selected car and show "My journeys" with the count, then one card per journey with name, drive count, start – end time, "start → end" place, km, duration and kWh. (src: `app/src/journey.ts:176-184`; `app/src/locales/en.ts:382-384`)
- **AJRN-041** When there are no journeys, the system SHALL show "No journeys yet. In Drives, tap “Select” and merge a few drives — or create one from a suggestion above." (src: `app/src/journey.ts:184`; `app/src/locales/en.ts:385`)
- **AJRN-042** When loading the list fails, the system SHALL show the error with a Retry button. (src: `app/src/journey.ts:54-55`, `:186`)
- **AJRN-043** When the user taps a journey card, the system SHALL open its detail page. (src: `app/src/journey.ts:185`)

### 3.7 Suggestions
- **AJRN-050** When the suggestions setting is off or the device is read-only, the system SHALL show no suggestions. (src: `app/src/journey.ts:189`)
- **AJRN-051** When loading suggestions, the system SHALL call `GET /api/journeys/suggestions?gap_min=<journeyGap setting, default 60>&car_id=<current car>`; `charge_gap_min` is not sent, so the server default applies. (src: `app/src/journey.ts:174-175`, `:190`)
- **AJRN-052** When suggestions arrive, the system SHALL drop those that contain a drive dismissed on this device and show at most 5. (src: `app/src/journey.ts:192-193`)
- **AJRN-053** When the "collapsed" setting is on, the system SHALL show one row "<n> journey suggestions ›"; otherwise a "Suggested journeys" heading with the rule "gap < <gap> min or a charging stop" and a "Hide" link. Toggling SHALL persist `suggestionsCollapsed`. (src: `app/src/journey.ts:195-207`; `app/src/locales/en.ts:386-389`)
- **AJRN-054** When a suggestion is shown, the system SHALL display its name with a server suffix `（往返）` replaced by the localized " (round trip)", its time range, drive count, km, charge count (if any), a "Dismiss" button and a "Create" button. (src: `app/src/journey.ts:49-50`, `:199-205`; `app/src/locales/en.ts:390-396`)
- **AJRN-055** When the user taps "Create", the system SHALL `POST /api/journeys` with the localized name and the suggestion's drive ids and open the new journey; on failure it SHALL show "Failed — retry" and the error inline on the card. (src: `app/src/journey.ts:208-218`; doc: `CHANGELOG.md` v1.0.1)
- **AJRN-056** When the user taps "Dismiss", the system SHALL dismiss the drives on the server if the server supports it (API level ≥ 9) and the call succeeds, otherwise remember them on this device (keeping the newest 2000 ids), then fade the card out and reload the suggestions after 200 ms. (src: `app/src/journey.ts:219-224`, `:397-405`; comment: `:397`)
- **AJRN-057** When the user taps a suggestion card outside its buttons, the system SHALL open the drive list in select mode with the suggestion's drives preselected. (src: `app/src/journey.ts:225-227`)
- **AJRN-058** When loading suggestions fails, the system SHALL hide the section without an error. (src: `app/src/journey.ts:228`)

### 3.8 Journeys settings (rendered by `app-shell`)
- **AJRN-060** When the user picks a suggestion gap in Settings, the system SHALL offer 30, 60, 90, 120, 180 and 240 minutes and store it as `journeyGap` (default 60). (src: `app/src/main.ts:426`, `:454-456`)
- **AJRN-061** When the user toggles "Show journey suggestions", the system SHALL store `suggestionsOff`. (src: `app/src/main.ts:428`, `:457-459`)
- **AJRN-063** When the user edits the speed-color upper limit in Settings, the system SHALL show a numeric text field (`inputmode=numeric`) with a "km/h" suffix, accept an integer, clamp it to 30–250 on change/blur (empty or non-integer restores the last saved value, or 120 when none), store it as `speedColorMax` (default 120), and use it for the map colour expression and legend on both journey and drive detail maps. (src: `app/src/main.ts` settings; `app/src/map.ts` `speedColorMax` / `clampSpeedColorMax`; issue #19)
- **AJRN-062** When the user taps "Restore dismissed suggestions" (shown only on devices that can write), the system SHALL clear the local dismissed list and, if the server supports dismissals, call `DELETE /api/journeys/suggestions/dismissed`; it SHALL report "Restored <n>" (server + local count), "Restored (this device)", "No dismissed suggestions", "Restored on this device (sync isn't enabled on the server)" or "Sync isn't enabled on the server, and there are no dismissed suggestions on this device". (src: `app/src/journey.ts:408-414`; `app/src/main.ts:429`, `:460-464`; `app/src/locales/en.ts:430-434`)

### 3.9 Journey detail
- **AJRN-070** When a journey is opened, the system SHALL register a back level `journey:<id>` whose back action returns to the journey list, request `GET /api/journeys/{id}`, and on failure show the error with Back and Retry. (src: `app/src/journey.ts:254-261`)
- **AJRN-071** When the journey has a cover and the server supports level 11, the system SHALL show a hero with the cover as background (skeleton until it is loaded), the name, "<start> – <end> · <n> drives[ · <n> charges]", km, kWh, Wh/km and costs; otherwise a title with the same meta line. (src: `app/src/journey.ts:289`, `:292-300`, `:421-424`)
- **AJRN-072** When the journey has a note, the system SHALL show it under the title. (src: `app/src/journey.ts:302`)
- **AJRN-073** When the path is loaded (`GET /api/journeys/{id}/path`), the system SHALL draw one map line per member drive that has at least 2 points, plus a marker per stop with coordinates (charging stop or plain stop, titled "<address> · stopped <duration>"); when no drive has a track it SHALL show "No track data". (src: `app/src/journey.ts:347-359`; `app/src/locales/en.ts:427`)
- **AJRN-074** When the user switches between "Color by speed" and "Single color", the system SHALL recolour the route, show/hide the speed legend (slow → "Fast (km/h 0–{max})" with `max` = `speedColorMax`) and store `speedColor` (default on). The control and legend SHALL come from the shared `speedColorToolsHtml` / `bindSpeedColorToggle` helpers. (src: `app/src/journey.ts`; `app/src/map.ts`)
- **AJRN-075** When the path is loaded, the system SHALL draw an elevation profile over cumulative km from the points that have elevation, with gridlines, the peak labelled "Max <v> m", a dashed line at each stop (km of the last point of the drive before the stop) and a dot for charging stops; with fewer than 2 elevation points it SHALL show "No elevation data". When the path was downsampled it SHALL add "Many track points; showing a sample (<shown>/<total>)". (src: `app/src/journey.ts:234-251`, `:361-362`; `app/src/locales/en.ts:397-399`, `:428`)
- **AJRN-076** When the detail is shown, the system SHALL show a grid with total distance, driving time, stopped time, total time, energy used, average efficiency, energy charged en route, charging cost (per currency, joined with " + ") and max speed. (src: `app/src/journey.ts:52`, `:308-318`)
- **AJRN-077** When the detail is shown, the system SHALL show a timeline in time order: each drive; after each drive, the charging sessions of the following stop (place, cost, times, duration and "stopped <stop duration>") or, without a charge, a "Stop <duration> · <place>" row; then any charges not assigned to a stop. (src: `app/src/journey.ts:265-287`)
- **AJRN-078** When the user taps a drive or charge in the timeline, the system SHALL open its detail page with a back action that returns to this journey. (src: `app/src/journey.ts:262`, `:325-326`)
- **AJRN-079** When loading the path, weather or speed bands fails, the system SHALL show the error in that section with a Retry button that reloads the whole journey page. (src: `app/src/journey.ts:363-365`, `:471-472`, `:478`)

### 3.10 Editing
- **AJRN-080** When the device can write, the system SHALL show a ✎ (edit title and note) next to the name and the buttons "Add / remove drives" and "Delete journey"; "Delete journey" SHALL open the edit dialog, where deletion is confirmed as in AJRN-032. (src: `app/src/journey.ts:290-291`, `:323`, `:327-334`)
- **AJRN-081** When the user saves the edit dialog, the system SHALL `PATCH /api/journeys/{id}` with `{name, note}` and re-render the page; when the user deletes, it SHALL `DELETE /api/journeys/{id}` and show the journey list. (src: `app/src/journey.ts:327-329`)
- **AJRN-082** When the user opens "Add / remove drives", the system SHALL register a back level `jedit:<id>` and list the journey's drives (selected) and the server's candidates (drives within 24 hours) in time order, with candidates that belong to another journey disabled and badged. (src: `app/src/journey.ts:369-381`, `:386`; `app/src/locales/en.ts:429`)
- **AJRN-083** When the user saves the drive selection, the system SHALL `PUT /api/journeys/{id}/drives` with the selected ids and reopen the detail; on failure it SHALL show the error in the action bar. Save SHALL be disabled when no drive is selected. (src: `app/src/journey.ts:382-392`)

### 3.11 Cover (level 11, devices that can write)
- **AJRN-090** When the device can write, the system SHALL show a ⋯ menu with "Use a photo as cover", "Use current map as cover" and — only when a cover exists — "↺ Restore default cover"; the menu SHALL close on a tap outside it. (src: `app/src/journey.ts:295-296`, `:425-435`; `app/src/locales/en.ts:405-407`)
- **AJRN-091** When the user picks "Use current map as cover", the system SHALL wait until the map style, tiles and route are rendered (up to 3 waits of 4 s, then one idle of up to 1.5 s), capture the map as a JPEG (quality 0.82, at most 1080 px wide), `PUT` it as the cover and re-render; when no image can be captured it SHALL show "The map hasn't finished loading; try again shortly". (src: `app/src/journey.ts:436-441`; `app/src/journey2.ts:20-35`; `app/src/locales/en.ts:435-436`)
- **AJRN-092** When the user picks a photo, the system SHALL decode it with EXIF orientation applied, scale the long edge to at most 1600 px, encode a JPEG on a white background starting at quality 0.82, lower the quality in steps of 0.08 (not below ~0.5) and then shrink by 20 % (not below 400 px wide) until the data is about 500 KB or less, upload it and re-render; an undecodable file SHALL show "Couldn't read this image (JPEG, PNG, WebP and other common formats are supported)". (src: `app/src/journey.ts:442-451`; `app/src/journey2.ts:36-51`; `app/src/locales/en.ts:342`)
- **AJRN-093** When the user picks "Restore default cover", the system SHALL `DELETE` the cover and re-render. (src: `app/src/journey.ts:452-453`)
- **AJRN-094** When a cover cannot be loaded, the system SHALL show the hero without an image. (src: `app/src/journey2.ts:16-18`; `app/src/journey.ts:421-424`)

### 3.12 Share card (level 11, all devices)
- **AJRN-100** When the server supports level 11, the system SHALL show the share button on the journey detail, also on read-only devices. (src: `app/src/journey.ts:293-294`)
- **AJRN-101** When the user taps share, the system SHALL show "Generating…", take a fresh snapshot of the live map (≤ 1080 px wide, quality 0.9) and use the saved cover only if no snapshot is available. (src: `app/src/journey.ts:455-460`; comment: `:459`)
- **AJRN-102** When rendering the card, the system SHALL draw a 1080×1350 image in the current light/dark theme: the top 760 px hold the image (cover-fit) or, without an image, the route drawn with a green start and red end dot; below come the journey name, "<date or date range> · <n> days · <n> drives[ · <n> charges]", "from → to", four cells (Distance km, Energy kWh, Efficiency Wh/km, Charging cost), and a "DriveLens" mark; long texts are shortened with "…". (src: `app/src/journey2.ts:111-162`; `app/src/journey.ts:461-467`; `app/src/locales/en.ts:354-359`)
- **AJRN-103** When computing the card's day count, the system SHALL count calendar days in local time from the first start to the last end, inclusive. (src: `app/src/journey.ts:461-465`)
- **AJRN-104** When naming the file, the system SHALL use `DriveLens-<name>.png`, with `\ / : * ? " < > |` and whitespace runs replaced by `_` and the name cut to 40 characters. (src: `app/src/journey.ts:469`)
- **AJRN-105** When the share dialog opens, the system SHALL show a preview and the buttons Close, "Copy image" (only outside the Android app and when `ClipboardItem` exists), "Share…" (in the Android app, or when the browser has `navigator.canShare`) and "Save image"; a backdrop tap SHALL close it. (src: `app/src/journey2.ts:166-181`; `app/src/locales/en.ts:360-363`)
- **AJRN-106** When the user taps "Save image" in the Android app, the system SHALL save the PNG to `Pictures/DriveLens` and show "Saved to Pictures/DriveLens/<file>"; below Android 10 it SHALL open the system share sheet instead; on another error it SHALL show "Sharing failed: <error>". Outside the Android app it SHALL download the PNG and show "Saved as <file> (Downloads folder)". (src: `app/src/journey2.ts:182-192`; `app/src-tauri/gen/android/app/src/main/java/com/zzflsxygod/drivelens/MainActivity.kt:81-83`; `app/src/locales/en.ts:194`, `:364`)
- **AJRN-107** When the user taps "Copy image", the system SHALL write the PNG to the clipboard and show "Copied to the clipboard — paste it straight into a chat", or "Copy failed: <error>". (src: `app/src/journey2.ts:193-197`; `app/src/locales/en.ts:365-366`)
- **AJRN-108** When the user taps "Share…", the system SHALL use the Android share sheet in the app, or the Web Share API with the PNG file in a browser; when the browser cannot share files it SHALL show "This device can't share images directly; use “Save image” or “Copy image”"; a user cancel SHALL show nothing. (src: `app/src/journey2.ts:198-205`; `app/src/locales/en.ts:367-368`)

### 3.13 Weather and energy by speed (level 11)
- **AJRN-110** When weather data arrives, the system SHALL add a chip to each drive in the timeline with a rain icon and "<temp>°C · <mm> mm" when precipitation ≥ 0.1 mm, otherwise a sun icon and "<temp>°C"; drives without a temperature get no chip. (src: `app/src/journey.ts:473-476`; `app/src/journey2.ts:59-60`)
- **AJRN-111** When showing "Weather & efficiency", the system SHALL list drives of at least 1 km with start time, weather, a bar proportional to Wh/km and the Wh/km value, and the note "Weather at each drive's start time and place (Open-Meteo). Units: Wh/km"; with no such drive it SHALL show "No drives to analyze". (src: `app/src/journey2.ts:63-67`, `:78-83`; `app/src/locales/en.ts:343`, `:345`)
- **AJRN-112** When at least 4 listed drives have a temperature, the system SHALL add "Drives below <median>°C averaged <x> Wh/km; the rest <y> Wh/km", with distance-weighted averages. (src: `app/src/journey2.ts:68-77`; `app/src/locales/en.ts:344`)
- **AJRN-113** When the server marks the weather as partial, the system SHALL add "Some weather data couldn't be fetched; it will be retried next time". (src: `app/src/journey.ts:477`; `app/src/locales/en.ts:440`)
- **AJRN-114** When speed bands arrive and their total distance is below 0.5 km, the system SHALL show "Not enough track data"; otherwise a share bar and one row per band with the localized label (City / Suburban / Highway; the server label only for unknown keys), the range (<40, 40–80, >80 km/h), km, share %, kWh and a Wh/km bar, plus a note naming the method (power, mixed or distance). (src: `app/src/journey2.ts:87-102`; `app/src/locales/en.ts:346-353`)

### 3.14 Read-only devices
- **AJRN-120** When the device is read-only, the system SHALL hide select mode, suggestions, the edit pen, "Add / remove drives", "Delete journey", the cover menu and the Settings "Restore dismissed suggestions" button, and keep viewing and the share card. (src: `app/src/journey.ts:30-31`, `:77`, `:189`, `:290-296`, `:323`; `app/src/main.ts:429`; doc: `CHANGELOG.md` v1.2.0)

### 3.15 Server error texts (mapped by `app-connection`)
- **AJRN-130** When the server answers `503` because the journey tables are missing, the system SHALL show "Journeys aren't enabled on the server: run deploy/setup.sql there and restart drivelens-api (see the install guide)"; for a missing cover column or weather table, "Covers / weather aren't enabled on the server: …". (src: `app/src/api.ts:82-85`; `app/src/locales/en.ts:135-136`)

## 4. Key design decisions

- **D-1 Journeys live inside the Drives tab.** Drives and Journeys are two segments of one tab, and select mode exists only to create journeys (comment: `app/src/journey.ts:2`, `:77`; doc: `CHANGELOG.md` v0.12.0 "Sliding segmented switches … (Drives / Journeys)"). Why the last segment is kept only in memory is not stated (confirmed from code: a fresh start opens the Drives segment; owner rule: no new bottom tabs, which is why journeys live in this tab).
- **D-2 Dismissals sync through the server, with a local fallback.** Server-side dismissal syncs across devices; when the server lacks it (level < 9, or the table is missing) the ids are kept in local settings (comment: `app/src/journey.ts:397`, `:401`).
- **D-3 Server suggestion names are localized on the client.** The server ends round-trip names with `（往返）` and returns Chinese band labels; the app replaces them with translated text (comment: `app/src/journey.ts:49`; `app/src/journey2.ts:89`).
- **D-4 Share card from the live map.** The card uses a fresh map snapshot so it shows the current route rendering; a saved cover is only a fallback (comment: `app/src/journey.ts:459`).
- **D-5 Covers are compressed on the device.** Photos become JPEGs of about 500 KB or less with EXIF orientation applied, well under the server's ~1 MB limit (comment: `app/src/journey2.ts:36`; doc: `CHANGELOG.md` v0.7.0 "stored as a small JPEG").
- **D-6 Native share/save on Android, web APIs elsewhere.** The Android app saves to `Pictures/DriveLens` via MediaStore and shares through the system sheet; browsers download, copy to the clipboard or use Web Share (comment: `app/src/journey2.ts:165`, `:169`, `:183`).
- **D-7 Optimistic feature gating.** Features are hidden only when the server is known to be too old; unknown levels are treated as supported and 404s are handled where they occur (comment: `app/src/version.ts:51`).
- **D-8 Read-only devices see no edit entry points.** Rather than failing on `403`, the UI hides create/edit/delete/cover/dismiss controls (comment: `app/src/journey.ts:30`; doc: `CHANGELOG.md` v1.2.0).

## 5. Constraints

- Feature levels: journeys 8, dismiss 9, paging 10, journey2 (cover, share card, weather, speed bands) 11. (src: `app/src/version.ts:10`)
- Name ≤ 200 characters, note ≤ 2000 (input `maxlength`, matching the server limits). (src: `app/src/journey.ts:144-145`)
- Journey list: one request with `limit=200`, no paging. (src: `app/src/journey.ts:176`)
- Suggestions: ≤ 5 shown; local dismissed list ≤ 2000 ids. (src: `app/src/journey.ts:193`, `:404`)
- Suggestion gap choices: 30, 60, 90, 120, 180, 240 minutes. (src: `app/src/main.ts:426`)
- Map cover ≤ 1080 px wide (JPEG 0.82); photo cover long edge ≤ 1600 px, target ≤ ~500 KB, width ≥ 400 px when shrinking. (src: `app/src/journey2.ts:20`, `:37`, `:47-48`)
- Share card: 1080×1350 PNG; file name part ≤ 40 characters. (src: `app/src/journey2.ts:113`; `app/src/journey.ts:469`)
- Map snapshots need `preserveDrawingBuffer` on the map canvas. (comment: `app/src/journey2.ts:19`; src: `app/src/map.ts:82`)
- Android save to Pictures needs Android 10+. (src: `app/src-tauri/gen/android/app/src/main/java/com/zzflsxygod/drivelens/MainActivity.kt:81-83`)

## 6. Non-goals

- Changing TeslaMate drives; journeys only group them in DriveLens. (doc: `app/src/locales/en.ts:376`)
- Creating journeys without user confirmation. Confirmed (current scope).
- Paging through more than 200 journeys. Confirmed as an accepted limit for now (see CB-3)
- Showing cover thumbnails in the journey list. Confirmed from code: the list endpoint returns no cover data, which keeps the list light.
- Sharing a link to a journey; the share card is an image only. Confirmed (current scope): there are no public URLs; the server is private to the owner.

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | Clearing the note in the edit dialog sends `note: null` (src: `app/src/journey.ts:159`, `:328`), which the server treats like an absent field (see `api-journeys` CB-1), so the old note stays. | The dialog offers to clear the note; the demo server clears it (src: `app/src/demo/server.ts:472`). Likely; the cause is on the server side. | Saving an empty note removes it. **Review:** real issue, verified at 9b1c39c. **Fixed in v1.2.3 / API 0.14.1:** the server clears on `null` (api-journeys CB-1), and the app now sends `""` for an empty note, so clearing also works with servers before 0.14.1 (X-8). |
| CB-2 | The share card prints "© OpenFreeMap © OpenStreetMap" whenever a non-PNG image was drawn (src: `app/src/journey2.ts:161`). A photo cover is a JPEG (src: `app/src/journey2.ts:44`), so when it is used as the fallback image the user's photo gets map attribution. | Attribution belongs to map imagery only. Possible; it happens only when no live map snapshot is available. | Map attribution only for map snapshots. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic. |
| CB-3 | The journey list loads only the newest 200 journeys (src: `app/src/journey.ts:176`); the count shown is the number loaded, and older journeys cannot be reached. | The drive list pages, the journey list does not. Possible; may be an accepted limit. | Page the journey list, or document the 200 limit. **Review:** not a bug. Accepted limit for now (200 journeys is years of trips); add paging when someone reaches it. |
| CB-4 | On a cold start with a remembered car (e.g. deep link `?view=journeys`), `ctx.carId()` returns the remembered car before the car selector is filled (src: `app/src/main.ts:577-589`), while the list uses `ctx.carQ()`, which is empty at that moment (src: `app/src/main.ts:50`; `app/src/journey.ts:176`). With several cars the list can show all cars' journeys while suggestions show one car. | Two sources for the "current car" can disagree for a moment. Possible, multi-car installs only. | Both requests use the same car. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor, multi-car cold start only (X-7). |

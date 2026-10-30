# app-home — Home screen

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `app/src/main.ts` (`Summary` types, `costSum`, `STATE_CLS`, `COLORS`, `colorLabel`, `HomeCache`, `LAST_CAR_KEY`, `readHomeCache`, `writeHomeCache`, `currentCarId`, skeleton helpers, `heroHTML`, `deg`, `heroTiles`, `heroSkeleton`, `monthHTML`, `totalsHTML`, `lastDriveHTML`, `lastChargeHTML`, `showHome`, `applyFeatureGates`, pull-to-refresh handlers); `app/src/locales/en.ts` (visible strings).
> In this document, "the system" means the DriveLens app's Home tab (首页), as rendered by `showHome()`.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Home is the app's first screen. It shows one car at a glance: state, state of charge, range, odometer, software version,
temperatures, location on a map, this month at a glance, the latest drive and charge, and all-time totals
(doc: README.md "Features" → Home). It must appear instantly from cached data and then refresh in the background
(doc: CHANGELOG.md v0.3.0 – v0.3.2 "fast loading with cached data").

## 2. Responsibility boundaries

### 2.1 In scope

- Choosing which car to show when Home opens (`currentCarId`) and remembering it.
- The Home layout and its sections: hero (vehicle card), location map, this month, latest drive, latest charge, all-time totals.
- The per-car Home snapshot cache in `localStorage`, the "cached data" indicator, and the three background requests.
- Per-section loading skeletons, error boxes with Retry, the refresh button and pull-to-refresh.
- Hiding the monthly-report entry points when the server is too old (`applyFeatureGates`, Home part).

### 2.2 Out of scope

- The battery health card shown in the `sec-battery` slot and the battery page → `app-insights` (`batteryCardHTML`, `showBattery`, `openBattery`).
- The monthly report page opened from the month card → `app-insights` (`openReport`).
- Drive and charge detail pages opened from the latest-drive / latest-charge cards → `app-records`.
- The car selector pill, tab bar, theme and banners → `app-shell`.
- `DriveMap` → `app-ui-kit`; date / number formatting → `app-i18n`; money formatting `fmtMoney` → `app-records`.
- The request layer `api()`, server feature levels (`lacks`, `serverReady`), clearing caches on server switch → `app-connection`.
- Server data → `api-summary`, `api-records`.

### 2.3 Interfaces and dependencies

- **Depends on:**
  - `api-summary` — `GET /api/cars/{id}/status`, `GET /api/cars/{id}/last-activity`, `GET /api/cars/{id}/stats?tz=…&currency=…` (src: app/src/main.ts:774-785).
  - `api-records` — `GET /api/cars` (car list, via `loadCars`) (src: app/src/main.ts:157-166).
  - `app-connection` — `api()`, `defaultCurrency()`, `lacks`, `serverReady`, `canWrite` (indirectly), `clearServerCaches` (removes this module's keys).
  - `app-insights` — `batteryCardHTML`, `openBattery`, `openReport`, `nowMonth` (src: app/src/main.ts:764, 787-799).
  - `app-records` — `showDrive`, `showCharge`, `costBadge`, `fmtMoney` (src: app/src/main.ts:757-758, 677, 554).
  - `app-ui-kit` — `DriveMap`, `ic` icons; `app-shell` — `navRoot`, car selector `carSel`, `syncCarPill`, `loadCars`, tab bar; `app-i18n` — `t`, `ago`, `fmtDateTime`, `fmtDur`, `fmtNum`, `monthLabel`; `app-demo` — `skey` (storage namespace).
  - Browser APIs: `localStorage`, `IntersectionObserver`, `Intl.DateTimeFormat` (device time zone), touch events.
- **Used by:** `app-shell` (Home tab, refresh after car change, root back target, `openView` default); `app-records`, `app-journeys`, `app-insights` (`currentCarId()` to pick the car, `showHome` as back target) (src: app/src/main.ts:217, 814, 832).
- **Provided interface (storage keys owned):**
  - `drivelens-last-car` — id of the last car shown (demo mode: `drivelens-demo~last-car`) (src: app/src/main.ts:567; app/src/demo.ts:22).
  - `drivelens-home-<carId>` — JSON `{status?, activity?, stats?, savedAt?}` (demo mode: `drivelens-demo~home-<carId>`) (src: app/src/main.ts:565, 568-574).

## 3. External behavior

### 3.1 Opening Home and choosing the car

- **HOME-001** When Home opens, the system SHALL immediately render the section layout with skeleton placeholders (hero, map, this month, battery slot, latest drive, latest charge, totals) before any network answer. (src: app/src/main.ts:689-700)
- **HOME-002** When the car selector already has a value, the system SHALL show that car. (src: app/src/main.ts:578)
- **HOME-003** When the selector is empty and a last-shown car id is stored, the system SHALL show that car at once without waiting for `/api/cars`. In the background it SHALL load the car list; if the stored car is not on this server, it SHALL switch to the first car, store that id, and re-render the active tab. (src: app/src/main.ts:579-589; comment: app/src/main.ts:584)
- **HOME-004** When neither applies, the system SHALL wait for `/api/cars` and show the first car. (src: app/src/main.ts:590-591)
- **HOME-005** When no car can be determined, the system SHALL replace Home with the message "No car found (check Settings)". (src: app/src/main.ts:705; doc: app/src/locales/en.ts:120)
- **HOME-006** When a car is shown, the system SHALL store its id as the last-shown car. (src: app/src/main.ts:706)
- **HOME-007** When Home is left (another screen renders) before a request answers, the system SHALL discard that answer instead of painting it. (src: app/src/main.ts:687-688, 704, 775, 779, 783)

### 3.2 Cached snapshot

- **HOME-010** When Home opens for a car with a stored snapshot, the system SHALL paint every section that has cached data before any request completes. (src: app/src/main.ts:708, 769-770)
- **HOME-011** When a cached snapshot was shown and at least one of the three requests is still pending, the system SHALL show "Showing cached data from {time ago} · updating…", where the time is the snapshot's `savedAt`. When all three requests have finished (successfully or not), it SHALL hide that line. (src: app/src/main.ts:712-717; doc: app/src/locales/en.ts:121)
- **HOME-012** When a request succeeds, the system SHALL merge its result into the car's snapshot in `localStorage` with `savedAt` = now and repaint the affected sections. (src: app/src/main.ts:572-574, 774-784)
- **HOME-013** When `localStorage` is full or unavailable, the system SHALL keep working without caching. (src: app/src/main.ts:570, 573)
- **HOME-014** When demo mode is active, the system SHALL read and write snapshot and last-car keys under the demo namespace, so demo data and real data never mix. (src: app/src/main.ts:567-568; comment: app/src/demo.ts:18-21; doc: CHANGELOG.md v0.13.1)

### 3.3 Background requests and errors

- **HOME-020** When Home opens for a car, the system SHALL request `/api/cars/{id}/status`, `/api/cars/{id}/last-activity` and `/api/cars/{id}/stats?tz=<device time zone>&currency=<app default currency>` independently and in parallel. (src: app/src/main.ts:772-786)
- **HOME-021** When the device time zone cannot be determined, the system SHALL send `tz=UTC`. (src: app/src/main.ts:773)
- **HOME-022** When a request fails, the system SHALL show an error box with the message ("Couldn't load car status: …", "Couldn't load recent drives/charges: …" or "Couldn't load statistics: …") and a Retry button that repeats only that request. It shows the status error in the hero section, the activity error in the latest-drive section and the statistics error in the this-month section. (src: app/src/main.ts:719-725, 777, 781, 785; doc: app/src/locales/en.ts:123-125)
- **HOME-023** When a section that failed has cached data, the system SHALL keep the cached content and put the error box at its top; when it has no cached data, the system SHALL remove its skeletons and show only the error box. (src: app/src/main.ts:722-723, 726)
- **HOME-024** When the server supports insights (API level ≥ 12), the system SHALL request `/api/cars/{id}/battery?summary=true` after the server check has finished, and fill the battery slot with the card from `app-insights`; tapping the card SHALL open the battery page. When the request fails, the slot SHALL stay empty. (src: app/src/main.ts:787-795, 799)

### 3.4 Hero (vehicle card)

- **HOME-030** When status data is available, the system SHALL show the car name (`name`, else `Car <id>`), and below it the model (`marketing_name`, else `Model <model>`) followed by the localized exterior colour (for known TeslaMate colour codes, raw value otherwise) and the wheel type. (src: app/src/main.ts:605-610, 557-558)
- **HOME-031** When the latest state is `online` and the latest position's speed is greater than 0, the system SHALL show the state badge "Driving"; otherwise "Online", "Asleep" or "Offline" for those states, and "Unknown" for anything else. Each badge SHALL include " · <time since the state began>" when known. (src: app/src/main.ts:600-602, 612; doc: app/src/locales/en.ts:79-83, 97)
- **HOME-032** When showing the battery, the system SHALL show the battery level in % (or "—"), the rated range in km with 0 decimals, "Est. {estimated range} km", and a gauge filled to the battery level. The gauge SHALL be styled "low" below 20 % and "mid" below 50 %. (src: app/src/main.ts:603-604, 613-617; doc: app/src/locales/en.ts:98)
- **HOME-033** When showing the hero tiles without TPMS, the system SHALL show three tiles in one row. Odometer: whole km with thousands separators. Software: the first word of the version string. Outside / inside temperature: whole degrees, where `-0` shows as `0`. Missing values SHALL show as "—". (src: `app/src/main.ts` `heroTiles`; doc: CHANGELOG.md v0.17.4)
- **HOME-034** When the hero is shown (also as a skeleton), the system SHALL show a refresh button that reloads the whole Home screen. (src: app/src/main.ts:611, 634, 701, 731)
- **HOME-035** When the server supports TPMS (`tpms`, api_level ≥ 16), tire-pressure warning is enabled, and status includes a `tpms` snapshot with at least one wheel, the system SHALL show the hero tiles as a **2×2 grid** with a fourth tile labeled `tpms.row` plus a muted `bar` unit (warn icon before the label when low; reading age via `ago` right-aligned in the label row when a date is present). Inside that tile the four pressures SHALL be arranged by wheel position (top: front left / front right; bottom: rear left / rear right), 1 decimal, monospace, with an accessible name per wheel. When the feature is off, the server lacks `tpms`, or there is no data, the system SHALL keep the original three-tile row (no empty fourth tile). (src: `app/src/main.ts` `showTpmsTile` / `tpmsTileHTML` / `heroTiles`; issue #24)
- **HOME-036** When tire-pressure warning is enabled (default on) and any wheel pressure is below the configured threshold (default 2.5 bar, range 1.5–4.0), the system SHALL (1) paint low wheel numbers and the TPMS tile border in the Telemetry warn color with a non-color cue (alert icon on the tile label), and (2) show a warning banner on the hero naming each low wheel and its value. The feature SHALL be hidden when the server lacks `tpms`. (src: `app/src/main.ts` `tpmsWarnHTML` / `tpmsTileHTML` / settings `tpmsWarn` / `tpmsWarnBar`; issue #24)

### 3.5 Location map

- **HOME-040** When the latest position has coordinates, the system SHALL show a map section titled with the current location name from last-activity (or "Last location" if unknown) and the time since that position. (src: app/src/main.ts:734-741; doc: app/src/locales/en.ts:122)
- **HOME-041** When the map section is shown, the system SHALL create the map only once the section is within 200 px of the viewport, with a single pin at the latest position. (src: app/src/main.ts:742-751; comment: app/src/main.ts:742)
- **HOME-042** When the latest position has no coordinates, the system SHALL leave the map section empty. (src: app/src/main.ts:737)
- **HOME-043** When new status or activity data arrives while the map already exists, the system SHALL update only the section title, not the map. (src: app/src/main.ts:739-740)

### 3.6 This month

- **HOME-050** When statistics are available, the system SHALL show "This month · {month}" with a "Monthly report" link and six tiles: Driven (km, 0 decimals), Energy used (kWh, 1 decimal), Charged (kWh, 1 decimal), Charging cost, Drives, Charges. (src: app/src/main.ts:640-651; doc: app/src/locales/en.ts:102-109)
- **HOME-051** When the server returns per-currency costs, the system SHALL show one formatted amount per currency, one per line, or "—" when there are none. When the server returns only the legacy single total, it SHALL show that total in the app's default currency. (src: app/src/main.ts:552-554)
- **HOME-052** When the "Monthly report" link or the month tiles are tapped, the system SHALL open the monthly report for that month (or the current month if the server sent none). (src: app/src/main.ts:642-643, 764)
- **HOME-053** When the server lacks the monthly report (API level < 6), the system SHALL hide the "Monthly report" link and make the month tiles non-interactive. (src: app/src/main.ts:765, 859-861)

### 3.7 Latest drive and latest charge

- **HOME-060** When a last drive exists, the system SHALL show a card with "start → end" place names, start date-time · duration, distance (km, 1 decimal), battery start % → end %, and efficiency (Wh/km, 0 decimals). Tapping it SHALL open the drive detail page, whose back action returns to Home. (src: app/src/main.ts:662-671, 757)
- **HOME-061** When no drive exists, the system SHALL show "No drives yet". (src: app/src/main.ts:664; doc: app/src/locales/en.ts:116)
- **HOME-062** When a last charge exists, the system SHALL show a card with the place name and cost badge, start date-time · duration, "+{kWh}" (2 decimals) and battery start % → end %. Tapping it SHALL open the charge detail page, whose back action returns to Home. (src: app/src/main.ts:672-681, 758)
- **HOME-063** When no charge exists, the system SHALL show "No charging sessions yet". (src: app/src/main.ts:674; doc: app/src/locales/en.ts:35)
- **HOME-064** When showing place names on these cards, the system SHALL show them as plain text (no rename entry point on Home). (src: app/src/main.ts:667, 677)

### 3.8 All-time totals

- **HOME-070** When statistics are available, the system SHALL show "All time" with Total distance (km, 0 decimals), Drives / charges (counts), Total charged (kWh, 0 decimals) and Total charging cost (per currency, as HOME-051). (src: app/src/main.ts:652-661; doc: app/src/locales/en.ts:110-114)

### 3.9 Refresh

- **HOME-080** When the user on a touch device pulls down at least 60 px from the top of the Home tab and releases, the system SHALL reload Home. While pulling, it SHALL show "Pull to refresh", which changes to "Release to refresh" past 60 px; the hint height is capped at 70 px. (src: app/src/main.ts:888-904; doc: app/src/locales/en.ts:118-119)
- **HOME-081** When the selected car changes, the system SHALL store it as the last-shown car and re-render the active tab. (src: app/src/main.ts:931)

## 4. Key design decisions

- **D-1 Cache first, then three independent requests.** Home paints the last snapshot at once. It then loads status, activity and statistics in parallel, so one slow or failing section does not block the others. (comment: app/src/main.ts:769, 772; doc: CHANGELOG.md v0.3.0 – v0.3.2) This is why the server splits these endpoints (`api-summary` D-1).
- **D-2 Show a remembered car without waiting.** The last car id is stored so Home can start before `/api/cars` answers; a stale id is corrected in the background. (comment: app/src/main.ts:576, 584)
- **D-3 Lazy WebGL map.** The location map is created only when it is near the viewport, to save work on load. (comment: app/src/main.ts:742)
- **D-4 "Driving" is derived on the client.** TeslaMate's states are only `online`, `offline` and `asleep` (testdata/schema.sql), so "Driving" = online with speed > 0. (src: app/src/main.ts:600) Rationale (confirmed from code: TeslaMate has no "driving" state, so the client derives it from the last position's speed).
- **D-5 Hero tiles always fit on one line.** A CSS variable `--n` (length of the longest value, at least 8) lets the three tiles shrink together; temperatures are whole degrees. (comment: app/src/main.ts:624, 626-627; doc: CHANGELOG.md v0.17.4)
- **D-6 Separate storage namespace for demo mode.** Keys pass through `skey()`, so demo data never mixes with a real server's cache. (comment: app/src/demo.ts:18-21)

## 5. Constraints

- Requires API level ≥ 3 (split home endpoints); the app treats lower levels as unsupported (`MIN_API_LEVEL = 3`). (src: app/src/version.ts:8; comment: api/src/main.rs:301)
- Monthly-report entry points need API level ≥ 6; the battery card needs API level ≥ 12. When the level is unknown, features are assumed present. (src: app/src/version.ts:10, 52)
- Statistics use the device's IANA time zone and the app's default currency (`Settings` currency, else derived from the device locale). (src: app/src/main.ts:773, 782; app/src/api.ts:107-115)
- Snapshot keys `drivelens-home-*` and `drivelens-last-car` are removed when the user switches server or signs out (owned by `app-connection`). (src: app/src/auth.ts:89-95)

## 6. Non-goals

- Editing on Home: place names and costs are edited from the detail pages (`app-records`). (src: app/src/main.ts:667, 677) Confirmed (current scope).
- Live updates: Home refreshes only when opened, via the refresh button, pull-to-refresh or a car change; there is no polling. (src: app/src/main.ts:685-786, 888-904) Confirmed (current scope): no polling, to keep the load on the self-hosted server and the TeslaMate database low.
- Use of the combined `/api/cars/{id}/summary` endpoint. (src: app/src/main.ts:774-782)

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `errorBox` places the box with `fresh[k] \|\| !hasCache(k)`. `k` is a section key (`"hero"`, `"drive"`, `"month"`), but `fresh` is keyed by request (`status`, `activity`, `stats`), so `fresh[k]` is always `undefined`. (src: app/src/main.ts:709, 722) | The first operand can never be true. Possible; the effect is only where the error box sits within the section. | Use the matching request key, or drop the dead operand. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (dead operand). |
| CB-2 | The hero shows `name`, else `Car <id>`. The car selector pill shows `name`, else `marketing_name`, else `Car <id>`. A car without a name therefore shows as "Car 1" on Home and by its marketing name in the pill. (src: app/src/main.ts:609, 169) | Two different fallbacks for the same car name. Possible, minor. | The same fallback chain in both places. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic. |
| CB-3 | The map title shows `location.name ?? "Last location"`. The server can send `""` for an unnamed place (`api-records` CB-3), which gives an empty title instead of "Last location". (src: app/src/main.ts:738) | The fallback text is never used for empty names. Likely only for places with no address data. | Fall back to "Last location" for empty names too. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor; the server-side cause is api-records CB-3. |
| CB-4 | Below API level 6 the "Monthly report" link is hidden, but the month tiles keep their click handler: `applyFeatureGates()` only removes the `month-card` class. Tapping a tile opens the report page, which shows the "server too old" message. (src: `app/src/main.ts` `[data-report]` click binding, `applyFeatureGates`, `openReport`) | HOME-053 says the tiles become non-interactive. Possible; minor, the report page explains the cause. | **Review:** real issue, verified at 9bd5dd2. **[OWNER DECISION NEEDED]** Make the tiles non-interactive below level 6 as HOME-053 says (code change), or change HOME-053 to the current behavior (the tile opens the "server too old" report page)? Recommendation: change HOME-053; the report page already explains what to update. |

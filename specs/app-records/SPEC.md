# app-records — Record lists, drive and charge detail pages, place and cost editing

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `app/src/infinite.ts`; `app/src/main.ts` (`esc`, `n`, `carQ`, `place`, `renameDialog`, `costBadge`, `costDialog`, `bindPlaces`, `showDrive`, `showCharges`, `chargeChart`, `showCharge`); `app/src/api.ts` (record types, `setAlias`, `resetAlias`, `setCost`, `resetCost`, `CURRENCIES`, `localeCurrency`, `defaultCurrency`, `fmtMoney`); `app/src/locales/en.ts` (visible strings).
> In this document, "the system" means the DriveLens app's infinite record list component, the Charges tab, the drive and charge detail pages, and the place-rename and charging-cost dialogs.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Users browse every drive and charging session that TeslaMate recorded, open one to see its route or charging curve,
give places their own names and enter what a charging session really cost (doc: README.md "Features" → Drives and
charging, Your names and costs). The lists must scroll endlessly, group by month, jump to a month, and keep their
place when the user comes back from a detail page (doc: CHANGELOG.md v0.6.0 – v0.6.3, v1.2.1).

## 2. Responsibility boundaries

### 2.1 In scope

- `infiniteList()`: the infinite list with keyset paging, month headers and month totals, month jump, first-page cache, error / retry, scroll restore. It is used by the Charges tab here and by the Drives tab in `app-journeys`.
- The Charges tab list and its cards and month headers.
- The charge detail page and its SVG charging-curve chart.
- The drive detail page (route map and figures).
- Place names that open a rename dialog (`place`, `bindPlaces`, `renameDialog`) on the detail pages.
- The charging-cost badge and the cost dialog.
- The client helpers for these writes (`setAlias`, `resetAlias`, `setCost`, `resetCost`) and money formatting (`fmtMoney`, `CURRENCIES`, `localeCurrency`, `defaultCurrency`) in `api.ts`.

### 2.2 Out of scope

- The Drives tab list (cards, month headers, select mode, journeys) → `app-journeys`; it uses this module's `infiniteList`.
- The request layer `api()`, error-message mapping, settings storage, `canWrite()`, feature levels (`lacks`) → `app-connection`.
- Back stack (`navPage`, `navRoot`), tab bar, car selector, global banner (`showBanner`), deep links (`openView`) → `app-shell`; choosing the current car (`currentCarId`) → `app-home`.
- `DriveMap`, popover menu (`popMenu`), sheets (keyboard-safe modals, Esc), back-to-top button, icons → `app-ui-kit`.
- Date, duration and month formatting (`fmtDateTime`, `fmtDur`, `fmtTime`, `monthLabel`) → `app-i18n`.
- Storage namespace for demo mode (`skey`) → `app-demo`.
- Server behavior of the endpoints → `api-records`.

### 2.3 Interfaces and dependencies

- **Depends on:**
  - `api-records` — `GET /api/drives/{id}`, `GET /api/drives/{id}/path`, `GET /api/charges` (with `paged`, `limit`, `before`, `car_id`), `GET /api/charges/{id}`, `GET /api/cars/{id}/months`, `PUT/DELETE /api/addresses/{id}/alias`, `PUT/DELETE /api/charges/{id}/cost` (src: app/src/main.ts:195, 220, 286; app/src/infinite.ts:98-101, 150; app/src/api.ts:96-101).
  - `app-connection` — `api()`, `canWrite()`, `lacks("paging" | "costs")`, `featureText`, `loadSettings().currency`.
  - `app-shell` — `navPage`, `navRoot`, `showBanner`, car selector value (`carQ`).
  - `app-home` — `currentCarId()` (selected or remembered car) (src: app/src/main.ts:576-592).
  - `app-ui-kit` — `DriveMap`, `popMenu`, `closeMenus`, `ICON`, `ic`, `focusField`, `setJumpedPeek` / `setJumpedReset` (back-to-top).
  - `app-i18n` — `t`, `fmtDateTime`, `fmtDur`, `fmtTime`, `monthLabel`.
  - `app-demo` — `skey` for list cache keys.
  - Browser APIs: `localStorage`, `IntersectionObserver`, `Intl.DateTimeFormat`, `Number.prototype.toLocaleString`.
- **Used by:**
  - `app-journeys` — `infiniteList` for the drive list; `showDrive` / `showCharge` via its context (src: app/src/journey.ts:112-126; app/src/main.ts:826-840).
  - `app-home` — `showDrive`, `showCharge`, `costBadge`, `fmtMoney`.
  - `app-insights` — `showDrive`, `showCharge` from the report (src: app/src/main.ts:819-821); `fmtMoney`, `defaultCurrency`.
  - `app-shell` — Charges tab, deep links `?view=drive:<id>` / `charge:<id>` (src: app/src/main.ts:909, 943-944).
- **Provided interface:**
  - `infiniteList<T>(opts)` → `{state, rebind(), leave()}`; `getState`, `dropState`, `MonthRow` (src: app/src/infinite.ts:13-47, 171-176).
  - Storage keys `drivelens-list-<listKey>` (first page; demo: `drivelens-demo~list-<listKey>`) (src: app/src/infinite.ts:45).
  - `fmtMoney(v, cur?, unit?)`, `CURRENCIES`, `localeCurrency()`, `defaultCurrency()` (src: app/src/api.ts:103-126).

## 3. External behavior

### 3.1 Infinite list: loading and paging

- **AREC-001** When a list is opened on a server with keyset paging (API level ≥ 10, or level unknown), the system SHALL request pages of 50 with `paged=true`, passing the previous page's `next_cursor` as `before`, until the server returns `next_cursor: null`. (src: app/src/infinite.ts:42, 98-101, 109, 117; app/src/main.ts:221; app/src/version.ts:52)
- **AREC-002** When the server is known to lack paging (API level < 10), the system SHALL make one request with `limit=100` and treat the list as complete. (src: app/src/infinite.ts:99, 110; comment: app/src/infinite.ts:6)
- **AREC-003** When the bottom sentinel comes within 600 px of the viewport, the system SHALL load the next page. After a successful load it SHALL keep loading while the sentinel stays within 600 px below the screen. (src: app/src/infinite.ts:128, 165-166)
- **AREC-004** When a load is in progress, the system SHALL not start a second one, and SHALL show three skeleton cards at the end of the list. (src: app/src/infinite.ts:44, 92, 103)
- **AREC-005** When all items are loaded, the system SHALL show "No earlier records" below a non-empty list, or an empty state with the list's empty message when there are no items. (src: app/src/infinite.ts:92; doc: app/src/locales/en.ts:141)
- **AREC-006** When a page request fails, the system SHALL show the error message (with `<`, `>`, `&` removed) and a Retry button, and SHALL not retry automatically. (src: app/src/infinite.ts:121-125; comment: app/src/infinite.ts:126-127)
- **AREC-007** When the list has been replaced by another screen, the system SHALL stop observing, stop loading and ignore late answers. (src: app/src/infinite.ts:111, 165, 168-169)

### 3.2 Infinite list: month headers

- **AREC-010** When rendering items, the system SHALL insert a month header before the first item of each calendar month (in the device's local time zone, by the item's date). (src: app/src/infinite.ts:43, 75-81)
- **AREC-011** When the server supports `/months` (paging level) and a car is selected, the system SHALL request `/api/cars/{carId}/months?tz=<device time zone>` once per list state and pass that month's server totals to the header renderer. If the request fails, headers SHALL use totals computed from the loaded items. (src: app/src/infinite.ts:148-151; app/src/main.ts:221)
- **AREC-012** When no server totals are available, the system SHALL recompute all month headers from the loaded items after each page. (src: app/src/infinite.ts:87-90, 119)

### 3.3 Infinite list: month jump

- **AREC-020** When paging is supported, the system SHALL show a month-jump button in the list toolbar; without paging, the button SHALL be hidden. (src: app/src/infinite.ts:61-67, 147)
- **AREC-021** When the month-jump button is tapped, the system SHALL show a menu "Jump to month" with "Latest" and every month (from server totals, else from loaded items), with a checkmark on the active choice. (src: app/src/infinite.ts:140-146; doc: app/src/locales/en.ts:139-140)
- **AREC-022** When a month is picked, the system SHALL clear the list, scroll to the top and load items starting at that month and going back in time. The cursor is the start of the following month in local time, as an ISO timestamp without an id part. (src: app/src/infinite.ts:131-137; comment: app/src/infinite.ts:133)
- **AREC-023** When a month jump is active, the system SHALL show a button "↑ Show records after {month}" at the top. Tapping it, choosing "Latest", tapping the active tab, or pressing back-to-top SHALL reload the list from the newest records. (src: app/src/infinite.ts:93-95, 163-164; app/src/totop.ts:11-14; app/src/main.ts:927; doc: app/src/locales/en.ts:142)

### 3.4 Infinite list: first-page cache and scroll restore

- **AREC-030** When a list's first page (not a month jump) loads, the system SHALL store `{items, next}` in `localStorage` under `drivelens-list-<key>` (demo: `drivelens-demo~list-<key>`). (src: app/src/infinite.ts:45, 107, 112-113)
- **AREC-031** When a list opens without a restorable state, the system SHALL show the cached first page at once and replace it when the network answers. (src: app/src/infinite.ts:114-115, 157-160)
- **AREC-032** When the user returns from a detail page to a list opened with `restore`, the system SHALL re-render the items it had loaded in memory and scroll back to the saved position. (src: app/src/infinite.ts:48, 154-156, 175; doc: CHANGELOG.md v0.6.0 – v0.6.3, v1.2.1)
- **AREC-033** When the page is reloaded, the system SHALL have no restorable state: in-memory list states do not survive a reload. (src: app/src/infinite.ts:21)

### 3.5 Charges tab

- **AREC-040** When the Charges tab opens, the system SHALL show the title "Charging" and an infinite list of the selected car's completed charging sessions (`/api/charges?…&car_id=<selected>`; all cars if none is selected), keyed `charges:<carId|all>`. (src: app/src/main.ts:215-221; doc: app/src/locales/en.ts:449)
- **AREC-041** When rendering a charge card, the system SHALL show the place name and the cost badge, start date-time · duration, a bar from the start to the end battery level, "+{kWh}" with 2 decimals, and battery start % → end %. (src: app/src/main.ts:229-238)
- **AREC-042** When rendering a month header on the Charges tab, the system SHALL show the month label and "{n} sessions · {kWh} kWh" (kWh with 0 decimals), from server totals when available, else from loaded items. It SHALL append " · " and the loaded sessions' costs summed per currency, joined with " + " (no conversion). (src: app/src/main.ts:223-228; doc: app/src/locales/en.ts:36)
- **AREC-043** When a charge card is tapped, the system SHALL save the list's scroll position, scroll to the top and open the charge detail page; its back action SHALL return to the restored list. (src: app/src/main.ts:239-241)
- **AREC-044** When the Charges tab has no sessions, the system SHALL show "No charging sessions yet". (src: app/src/main.ts:222; doc: app/src/locales/en.ts:35)

### 3.6 Charge detail page

- **AREC-050** When a charge detail page opens, the system SHALL register it in the back stack as `charge:<id>`, show "Loading…", and request `/api/charges/{id}`. (src: app/src/main.ts:282-286)
- **AREC-051** When the data arrives, the system SHALL show: a back button; the place name as the title; start – end date-time; tiles for Energy added and Energy used (kWh, 2 decimals), Cost, Duration, Battery (start % → end %) and Outside temp (°C, 1 decimal); the "Charging curve" chart; and, when the session has coordinates, a small map with a "Charging location" pin. (src: app/src/main.ts:287-311; app/src/map.ts:170)
- **AREC-052** When showing the Cost tile, the system SHALL label it "Cost", plus " · manual" or " · TeslaMate" according to `cost_source`. It SHALL show the amount in the session's currency (or the app default), the unit price "{price}/kWh" when both cost and energy added are known, and the manual note if any. (src: app/src/main.ts:294-297; doc: app/src/locales/en.ts:16, 47-48)
- **AREC-053** When the request fails, the system SHALL replace the page with the error message. (src: app/src/main.ts:154, 312)

### 3.7 Charging curve chart

- **AREC-060** When drawing the chart, the system SHALL use each point's `power_kw` if present, else `charger_power` when it is > 0. The chart SHALL show power as a filled area on the left axis (kW) and battery % as a line on the right axis (0–100 %), with gridlines at 0, 50 % and 100 % and the start and end times under the axis. (src: app/src/main.ts:245-276)
- **AREC-061** When choosing the kW axis maximum, the system SHALL use at least 5 kW and round the peak up to a multiple of 50 above 100 kW, of 10 above 20 kW, and of 2 otherwise. (src: app/src/main.ts:254-255)
- **AREC-062** When fewer than 2 points have valid dates, or there is neither power > 0 nor any battery level, the system SHALL show "No charging curve data" instead of a chart. (src: app/src/main.ts:247-251; doc: app/src/locales/en.ts:37)
- **AREC-063** When power data exists, the legend SHALL read "Power kW (peak {max})" and "Battery %". (src: app/src/main.ts:268, 277; doc: app/src/locales/en.ts:39-41)
- **AREC-064** When no point has power, the system SHALL add the note "No power data; showing battery level only". When any point's power was estimated (`power_source` `"voltage_current"` or `"energy_delta"`), it SHALL add the note that the power is estimated from voltage × current or energy added. (src: app/src/main.ts:267, 278; doc: app/src/locales/en.ts:42-43)

### 3.8 Drive detail page

- **AREC-070** When a drive detail page opens, the system SHALL register it in the back stack as `drive:<id>`, show "Loading…", and request `/api/drives/{id}` and `/api/drives/{id}/path` in parallel. (src: app/src/main.ts:191-195)
- **AREC-071** When the data arrives, the system SHALL show: a back button; "start place → end place" as the title; start – end date-time; when the path has at least two points, the shared speed-colour / single-colour toggle and legend (`speedColorToolsHtml`, defaulting `speedColor` to on) and a map built from `lines` (coordinates + per-point `speed` from `GET /api/drives/{id}/path`) with start and end pins; when the path is shorter, "No track data" instead of the map; and tiles for Distance (km, 1 decimal), Duration, Energy (kWh, 2 decimals), Efficiency (Wh/km, 0 decimals), Top speed (km/h) and Battery (start % → end %). Missing values SHALL show "—". (src: app/src/main.ts `showDrive`; app/src/map.ts; issue #20)
- **AREC-072** When no back target is given, the system SHALL make the back button return to the Drives tab. (src: app/src/main.ts:191)
- **AREC-073** When either request fails (for example HTTP 404 for an unknown or still-running drive), the system SHALL replace the page with the error message. (src: app/src/main.ts:212)

### 3.9 Place names and the rename dialog

- **AREC-080** When a place on a drive or charge detail page has an address id and the device can write, the system SHALL show the place name with a pencil mark and the hint "Tap a place name to rename it". Tapping the name SHALL open the rename dialog. (src: app/src/main.ts:53-56, 147-150, 198-199, 289-290; doc: app/src/locales/en.ts:17)
- **AREC-081** When a place has no address id, or the device is read-only, the system SHALL show the place name as plain text without the pencil, the hint or the dialog. (src: app/src/main.ts:54, 199, 290; doc: CHANGELOG.md v1.2.0 "Read-only devices")
- **AREC-082** When the rename dialog opens, the system SHALL show "Rename place", a text field (max 200 characters) pre-filled and selected with the current name, the hint that the name applies to every drive and charge at this location and that TeslaMate's data is not changed, and the buttons Cancel and Save, plus "Restore default name" when the place already has an alias. (src: app/src/main.ts:58-75; doc: app/src/locales/en.ts:19-21)
- **AREC-083** When Save is pressed (or Enter in the field) with an empty name after trimming, the system SHALL show "Name can't be empty" and not call the server. (src: app/src/main.ts:83-88; doc: app/src/locales/en.ts:14)
- **AREC-084** When Save is pressed with a non-empty name, the system SHALL send `PUT /api/addresses/{id}/alias` with the trimmed name. When "Restore default name" is pressed, it SHALL send `DELETE /api/addresses/{id}/alias`. On success it SHALL close the dialog and re-render the detail page; on failure it SHALL show the error message inside the dialog and keep it open. (src: app/src/main.ts:76-80, 86, 90; app/src/api.ts:96-97)
- **AREC-085** When the backdrop or Cancel is tapped, the system SHALL close the dialog without saving. (src: app/src/main.ts:81-82) Esc also cancels (comment: app/src/sheets.ts:2; doc: CHANGELOG.md v1.0.1).

### 3.10 Charging cost badge and dialog

- **AREC-090** When a session has a cost, the system SHALL show a cost badge with the formatted amount, styled differently for a manual cost. Without a cost, it SHALL show no badge. (src: app/src/main.ts:93-95)
- **AREC-091** When the device can write, the system SHALL make the Cost tile of the charge detail page tappable (with a pencil and the tooltip "Tap to enter or edit the cost"). On a read-only device the tile SHALL not react to taps. (src: app/src/main.ts:294-295, 307-308; doc: app/src/locales/en.ts:46)
- **AREC-092** When the Cost tile is tapped and the server lacks manual costs (API level < 5), the system SHALL show the global banner saying the server is too old for this feature instead of the dialog. (src: app/src/main.ts:307-308; app/src/version.ts:10, 56)
- **AREC-093** When the cost dialog opens, the system SHALL show "Charging cost", the session's place · date-time · kWh, an Amount field, a currency picker, an optional note field (max 500 characters), and an explanation: "TeslaMate recorded {amount}." or "TeslaMate has no cost for this session.", followed by "A manually entered cost takes priority; TeslaMate's data is not changed.". (src: app/src/main.ts:97-121; doc: app/src/locales/en.ts:22-26)
- **AREC-094** When the session already has a manual cost, the system SHALL pre-fill the amount, currency and note with it and offer "Delete manual cost"; otherwise the amount and note SHALL start empty. (src: app/src/main.ts:98-99, 109, 113, 117)
- **AREC-095** When choosing the pre-selected currency, the system SHALL use the manual currency, else the server's location-based `default_currency`, else the app's default currency. The picker SHALL list that currency first, then JPY, CNY, USD, EUR, HKD, TWD, KRW, GBP, AUD, CAD, SGD, CHF without duplicates. (src: app/src/main.ts:99-100, 110; app/src/api.ts:103)
- **AREC-096** When the amount or currency changes and the amount is ≥ 0 and the session's energy added is known, the system SHALL show the unit price "{price}/kWh". (src: app/src/main.ts:125-129)
- **AREC-097** When Save is pressed (or Enter in the amount field) with an amount that is not a number ≥ 0 and < 1e9, the system SHALL show "Please enter a valid amount" and not call the server. (src: app/src/main.ts:136-138, 142; doc: app/src/locales/en.ts:28)
- **AREC-098** When Save is pressed with a valid amount, the system SHALL send `PUT /api/charges/{id}/cost` with `{amount, currency, note}` (note trimmed, empty → `null`). "Delete manual cost" SHALL send `DELETE /api/charges/{id}/cost`. On success it SHALL close the dialog and re-render the charge page; on failure it SHALL show the error inside the dialog. (src: app/src/main.ts:131-144; app/src/api.ts:99-101)
- **AREC-099** When the server answers that the manual-cost table is missing (HTTP 503 mentioning `charge_costs`), the system SHALL show "Manual costs aren't enabled on the server: run deploy/setup.sql there and restart drivelens-api (see the install guide)". (src: app/src/api.ts:80-81; doc: app/src/locales/en.ts:134)

### 3.11 Money formatting

- **AREC-110** When formatting an amount, the system SHALL show "—" for a missing amount. It SHALL use the given currency (default: the app's default currency) with 0 decimals for JPY, KRW and TWD and 2 decimals otherwise, en-US digit grouping, and the symbol prefix ¥, CN¥, $, €, £, ₩, HK$, NT$, A$, C$ or S$ where known; else it SHALL append the ISO code ("12.00 CHF"). (src: app/src/api.ts:116-126)
- **AREC-111** When formatting a per-kWh price, the system SHALL use 1 decimal for the zero-decimal currencies (e.g. "¥36.4/kWh"). (src: app/src/api.ts:119, 123)
- **AREC-112** When no currency is set in Settings, the system SHALL derive the default currency from the device locale: by region first (e.g. `en-GB` → GBP), then by language (`ja` → JPY, `zh-Hant` → TWD, `zh` → CNY, …), else USD. (src: app/src/api.ts:104-115)

## 4. Key design decisions

- **D-1 One list component for drives and charges.** Keyset paging, sticky month headers, month jump, first-page cache and scroll restore live in `infinite.ts` and are shared. (comment: app/src/infinite.ts:5-6; doc: CHANGELOG.md v0.6.0 – v0.6.3)
- **D-2 Graceful degradation on old servers.** Without paging (API level < 10) the list loads 100 items once, the month-jump button is hidden, and month totals come from loaded items. (comment: app/src/infinite.ts:6; src: app/src/infinite.ts:99, 147, 150)
- **D-3 No retry loop on errors.** After an error the list waits for an explicit Retry, so a persistent error such as 401 or offline does not cause a tight request loop. (comment: app/src/infinite.ts:126-127)
- **D-4 Month jump by cursor, not by date filter.** A jump starts the keyset cursor at the beginning of the following month, so paging further back works unchanged. (comment: app/src/infinite.ts:133; src: api/src/main.rs:105)
- **D-5 Show what TeslaMate recorded next to the manual value.** The cost dialog states TeslaMate's own cost and that a manual cost takes priority without changing TeslaMate's data. (doc: app/src/locales/en.ts:24-26)
- **D-6 Edit entry points hidden on read-only devices.** Rename and cost controls are not rendered when `canWrite()` is false, instead of failing on save. (comment: app/src/main.ts:54; comment: app/src/auth.ts:43; doc: CHANGELOG.md v1.2.0)
- **D-7 Costs never converted.** Month headers and badges show amounts in their own currency; mixed currencies are joined with " + ". (src: app/src/main.ts:224-226) Rationale (confirmed, design: no exchange rates); matches the server's per-currency approach (`api-records` D-4).

## 5. Constraints

- Page size 50 with paging; 100 in one request without. (src: app/src/infinite.ts:42, 99)
- Prefetch margin 600 px. (src: app/src/infinite.ts:128, 165)
- Rename field: max 200 characters. Note field: max 500 characters. Amount: 0 ≤ amount < 1e9. These match the server limits. (src: app/src/main.ts:64, 113, 138; api/src/main.rs:492, 526, 534)
- The currency picker offers the initial currency plus 12 fixed currencies; the server accepts any 3-letter code. (src: app/src/api.ts:103; api/src/main.rs:529-532)
- Month grouping uses the device's local time zone on the client and the device's IANA zone for `/months`. (src: app/src/infinite.ts:43, 149)
- List caches use the keys `drivelens-list-*`; `app-connection` removes them when the user switches server or signs out. (src: app/src/auth.ts:89-95)
- Feature levels: paging and `/months` = 10, manual costs = 5, charge `power_kw` = 4. (src: app/src/version.ts:10)

## 6. Non-goals

- Editing TeslaMate data: aliases and costs are overlays kept by drivelens-api. (doc: app/src/locales/en.ts:20, 26)
- Renaming places from list cards or from Home (only from detail pages). (src: app/src/main.ts:231, 667, 677) Confirmed from code.
- Persisting list scroll state across reloads. (src: app/src/infinite.ts:21) Confirmed from code: scroll state is kept for the session only.
- Currency conversion. Confirmed (current scope) (see D-7).

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | When server month totals are available, headers are rendered once, when a month's first item is appended, and are not refreshed after later pages (`refreshHeaders` runs only without server totals). The Charges header's cost sum comes from loaded items only. For a month that spans a page boundary, the cost sum therefore covers only the items loaded up to that page, while the count and kWh in the same header are full-month server totals. (src: app/src/infinite.ts:79, 119; app/src/main.ts:224-227) | One header mixes complete and partial figures, and the cost part never catches up. Likely. | Header costs updated as more items of that month load, or a server-side per-month cost total. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor. |
| CB-2 | The charge detail Battery tile prints `${start_battery_level}% → ${end_battery_level}%` without a fallback, so a missing value shows as "null%". Every other battery display uses `?? "—"`. (src: app/src/main.ts:299 vs 207, 236) | Inconsistent with the rest of the UI. Likely. | "—" for a missing level. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor. |
| CB-3 | The drive detail map drew the route in one plain colour (coordinates only). **Fixed with #20 / this PR:** drive detail uses `lines` with per-point speed and the shared speed-colour toggle (same `speedColor` setting as journeys). | — | — |
| CB-4 | The Charges list builds its request path from the selector's current value (`carQ()`), but its cache key and `/months` request use `currentCarId()`. That id can come from the remembered last car while the selector is still empty (`api-records` `/api/cars` not yet answered). On a cold start straight into this tab (e.g. `?view=charges`), a multi-car account can therefore load all cars' sessions under a single car's key and month totals. (src: app/src/main.ts:217, 220-221, 50, 578-589) | The list content and its key / totals can refer to different car filters. Possible; only multi-car accounts on a cold start into the tab. The same pattern exists in the Drives tab (`app-journeys`, src: app/src/journey.ts:76, 113). | Path, key and totals from the same car id. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor, multi-car cold start only (X-7). |

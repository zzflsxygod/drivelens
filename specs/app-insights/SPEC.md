# app-insights — Monthly report, trends, footprint and battery health (app)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `app/src/report.ts`, `app/src/insights.ts`, and in `app/src/main.ts`: `openReport` (802-823), `openBattery` (799), `carInfo` (798), the home battery card (787-795), the report entry links in the home month card (642-643, 764), the feature gate for report links (859-861) and the `report` / `battery` deep links (945-946). Visible strings: `app/src/locales/en.ts`.
> In this document, "the system" means the DriveLens app (web / Tauri) screens and helpers for the monthly report, 12-month trends, footprint map, battery health page and home battery card.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Show the owner how a month went (distance, energy, cost, home vs. Supercharger, daily pattern, highlights), how the last 12 months compare, where they drove, and how healthy the battery is. Battery health is shown with the same method as TeslaMate's dashboard when the server supports it, and with the older range-based estimate otherwise. The screens must stay usable with older servers by hiding or explaining features the server lacks. (doc: README.md "Features"; doc: CHANGELOG.md v0.5.0, v0.9.0, v1.1.0)

## 2. Responsibility boundaries

### 2.1 In scope
- Monthly report page: month switcher, overview, efficiency & cost, charge-type split, daily bars / calendar, records.
- Report extras: footprint map and 12-month trends.
- Battery page in two variants: the TeslaMate method (`tm`) and the range-based fallback.
- Home battery card (`#sec-battery` on the Home screen).
- Device-local overrides: new capacity (kWh) and the legacy 100 % range baseline (km), including the one-time km → kWh migration.
- Entry functions `openReport(month, carId?)` and `openBattery(id)`.

### 2.2 Out of scope
- All server calculations (aggregation, classification, battery formulas) → `api-insights`.
- The rest of the Home screen, including the "this month" card that links here → `app-home`.
- Tab switching, the back stack (`navPage`), deep-link dispatch (`openView`), the shared `map` slot and `destroyMap` → `app-shell`.
- Drive and charge detail pages opened from records → `app-records`.
- `api()` request layer, `defaultCurrency()`, `fmtMoney()`, server level checks (`lacks`, `serverReady`, `checkServer`, `featureText`) → `app-connection`.
- `DriveMap`, icons (`ic`), CSS tokens such as `--mix-home` → `app-ui-kit`.
- Translations and formatting helpers (`t`, `monthLabel`, `fmtNum`, `fmtMonthDay`, `weekdays`) → `app-i18n`.
- Storage-key namespacing for demo mode (`skey`) and the demo data → `app-demo`.
- The push notification that opens the report → `api-push` / `app-notifications`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-insights` — `GET /api/cars/{id}/report`, `/trends`, `/footprint`, `/battery`.
  - `app-connection` — `api()`, `defaultCurrency()`, `fmtMoney()`, `lacks()`, `serverReady()`, `checkServer()`, `featureText()`.
  - `app-shell` — `navPage("report" | "battery", showHome)`, `destroyMap`, the shared `map` variable, `currentCarId()`, `applyFeatureGates()`, `openView()`.
  - `app-records` — `showDrive(id, back)` and `showCharge(id, back)`.
  - `app-home` — hosts `#sec-battery` and the month card with `data-report`.
  - `app-ui-kit` — `DriveMap`, `ic()`, CSS variables for chart colours.
  - `app-i18n` — strings and date / number formatting.
  - `app-demo` — `skey()` for storage keys.
  - `ext:browser` — `localStorage`, `Intl.DateTimeFormat().resolvedOptions().timeZone`, `matchMedia("(prefers-reduced-motion: reduce)")`, inline SVG.
- **Used by:**
  - `app-home` — `batteryCardHTML()` and `openReport` / `openBattery` from the Home screen.
  - `app-shell` — deep links `?view=report:YYYY-MM` and `?view=battery`.
  - `app-notifications` — a monthly-report notification opens `/?view=report:YYYY-MM` (src: api/src/push.rs:215).
- **Provided interface (exports):**

| Export | File | Purpose |
|---|---|---|
| `showReport(view, carId, month, nav)` | report.ts:171 | Render the report page into `view` |
| `reportHTML(r)`, `reportSkeleton(month)` | report.ts:110, 93 | HTML of the report body / skeleton |
| `shiftMonth(m, by)`, `nowMonth()` | report.ts:34, 38 | Month arithmetic in device local time |
| `loadReportExtras(box, carId, month, setMap)` | insights.ts:303 | Footprint + trends below the report |
| `trendsHTML(ms, cur)` | insights.ts:280 | Trends section HTML |
| `batteryCardHTML(b, car, carId)` | insights.ts:94 | Home battery card |
| `showBattery(view, carId, back, car)` | insights.ts:144 | Battery page |
| `tmView`, `baseline`, `newKwhOverride`, `setNewKwhOverride`, `baselineOverride`, `setBaselineOverride` | insights.ts:42, 81, 29, 33, 72, 75 | Health view model and device overrides |

- **Storage keys (localStorage, per device):**

| Key | Value | Purpose |
|---|---|---|
| `drivelens-battery-new-kwh` | JSON object `{carId: kWh}` | New-capacity override |
| `drivelens-battery-baseline` | JSON object `{carId: km}` | Legacy 100 % range baseline |
| `drivelens-battery-kwh-migrated-<carId>` | `"1"` | The km baseline was converted to kWh |

In demo mode each key is renamed by `skey()` to `drivelens-demo~battery-…`. (src: app/src/insights.ts:28, app/src/insights.ts:32, app/src/insights.ts:71; src: app/src/demo.ts:15, app/src/demo.ts:22)

## 3. External behavior

### 3.1 Entry points and feature gates
- **AINS-001** When the user taps the "this month" card or its "open report" link on Home, the system SHALL open the report for that card's month (or the current month when the card has none) for the selected car. (src: app/src/main.ts:642-643, app/src/main.ts:764)
- **AINS-002** When the server's API level is below 6, the system SHALL hide the report links on Home. (src: app/src/main.ts:859-861; src: app/src/version.ts:10)
- **AINS-003** When the report is opened, the system SHALL wait for the running server check. If the server's level is then below 6, it SHALL show the "server too old" text, the message "The monthly report needs a newer drivelens-api on your server." and a Retry button that re-checks the server and opens the report again. (src: app/src/main.ts:805-812; src: app/src/locales/en.ts:126)
- **AINS-004** When the report is opened and no car id is given or found, the system SHALL show Home instead. (src: app/src/main.ts:814-815)
- **AINS-005** When the app starts with `?view=report:YYYY-MM`, the system SHALL open the report for that month. When the value after `report` is not a valid `YYYY-MM`, it SHALL open the current month. (src: app/src/main.ts:945; test: api/src/push.rs monthly_texts asserts the link `/?view=report:2026-09`)
- **AINS-006** When the app starts with `?view=battery`, the system SHALL open the battery page of the current car. (src: app/src/main.ts:946)
- **AINS-007** When the report or battery page is opened, the system SHALL register it as a detail page whose back action returns to Home. A drive or charge opened from a report record SHALL return to the report of the same month. (src: app/src/main.ts:799, app/src/main.ts:803, app/src/main.ts:817-820; doc: CHANGELOG.md v1.2.1)
- **AINS-008** When the server's API level is below 12, the report SHALL be shown without the footprint and trends sections. (src: app/src/main.ts:821)

### 3.2 Report loading and caching
- **AINS-010** When `showReport` gets a month that does not match `^\d{4}-(0[1-9]|1[0-2])$`, the system SHALL use the current device-local month instead. (comment and src: app/src/report.ts:172)
- **AINS-011** When a report is loaded, the system SHALL request `GET /api/cars/{id}/report?month=<YYYY-MM>&tz=<device IANA zone, or UTC>&currency=<defaultCurrency()>`. (src: app/src/report.ts:210-211; src: app/src/api.ts:115)
- **AINS-012** When a month was already loaded in this page session, the system SHALL render it at once from memory. It SHALL then refresh it in the background and re-render only if the response differs. (comment: app/src/report.ts:166-170; src: app/src/report.ts:163-164, app/src/report.ts:200-217)
- **AINS-013** When a month is not in memory, the system SHALL show a skeleton until the response arrives. (src: app/src/report.ts:202)
- **AINS-014** When an older request finishes after a newer one was started, the system SHALL ignore its result. (src: app/src/report.ts:173, app/src/report.ts:213, app/src/report.ts:219)
- **AINS-015** When the report request fails with HTTP 404, the system SHALL show the "server too old for this feature" text. For any other error it SHALL show "Couldn't load the monthly report: {e}". In both cases it SHALL offer a Retry button, and SHALL keep the cached content when there is one. (src: app/src/report.ts:218-224; src: app/src/locales/en.ts:340)
- **AINS-016** When the month changes and the user has not asked for reduced motion, the system SHALL slide the content in from the right for a later month and from the left for an earlier one, once per change. (src: app/src/report.ts:201-208; doc: CHANGELOG.md v0.12.0 "flicker-free month changes in the report")

### 3.3 Month switcher
- **AINS-020** When the report is shown, the switcher SHALL show the month label with a previous arrow (month − 1) and a next arrow (month + 1). Previous SHALL be disabled when `first_month` is known and the month is not after it. Next SHALL be disabled when the month is not before the current device-local month. (src: app/src/report.ts:97-108)
- **AINS-021** When the report data is known, the switcher subtitle SHALL read "{m} 1 – {days_elapsed} · month in progress" for the current month and "{m} 1 – {days_in_month}" otherwise. `{m}` is the short English month name when the UI language is English and the month number otherwise. (src: app/src/report.ts:100-101; src: app/src/locales/en.ts:304-305)

### 3.4 Overview
- **AINS-030** When a report is shown, the system SHALL show six tiles: distance, driving time (hours and minutes), drives, energy used, energy charged and charging cost. Each tile SHALL include the change against the previous month. (src: app/src/report.ts:125-132)
- **AINS-031** When a change is computed, the system SHALL show "–" if either value is missing or the previous value is 0. Otherwise it SHALL show the rounded percentage with ↑ or ↓, marked good for an increase in distance, time and drives, and good for a decrease in energy used, energy charged, cost, efficiency, cost per km and price per kWh. (src: app/src/report.ts:44-49, app/src/report.ts:126-131, app/src/report.ts:138-140)
- **AINS-032** When costs are shown, the system SHALL list every currency joined with " + ". The main currency SHALL be the default currency if present, else the currency with the largest amount. The cost change SHALL compare the main currency with the same currency of the previous month. (comment and src: app/src/report.ts:40-42; src: app/src/report.ts:112, app/src/report.ts:131)
- **AINS-033** When the month is in progress, the system SHALL show the note "Month in progress: compared with all of last month". (src: app/src/report.ts:133; src: app/src/locales/en.ts:318)
- **AINS-034** When the month has no drives and no charges, the system SHALL show "No drives or charges this month" and no further report sections. (src: app/src/report.ts:124, app/src/report.ts:134; src: app/src/locales/en.ts:319)

### 3.5 Efficiency, cost and charging split
- **AINS-040** When the month has data, the system SHALL show average efficiency (Wh/km), cost per km (main-currency cost ÷ distance) and average price per kWh (main-currency cost ÷ energy charged). Each SHALL show its change against the previous month, using the same currency. (src: app/src/report.ts:113-117, app/src/report.ts:137-141)
- **AINS-041** When the month has data, the system SHALL show two donut charts over the buckets home / Supercharger / other: one by energy and one by main-currency cost. The centre values SHALL be total kWh and total main-currency cost. (src: app/src/report.ts:51-57, app/src/report.ts:118, app/src/report.ts:142-146)
- **AINS-042** When the month has data, the system SHALL show a table row per bucket with the label and session count, energy, costs in all currencies, and the price per kWh in the main currency ("—" when either part is 0). (src: app/src/report.ts:147-150)

### 3.6 Daily view
- **AINS-050** When the month has data, the daily section SHALL offer "Bars" (default) and "Calendar", switchable without a new request. (src: app/src/report.ts:152-153, app/src/report.ts:195-198)
- **AINS-051** When "Bars" is shown, each day SHALL have a distance bar and an energy-charged bar, each on its own scale rounded up to a "nice" maximum. The legend SHALL show the kWh maximum, x labels SHALL show days 1, 5, 10, 15, 20, 25 and 30, and in the current month days after `days_elapsed` SHALL be shaded. (src: app/src/report.ts:59-73)
- **AINS-052** When "Calendar" is shown, the system SHALL draw a Monday-first month grid. Each day's colour intensity SHALL be its distance relative to the month's maximum, with the rounded km and a bolt icon on days with charging. In the current month, days after `days_elapsed` SHALL be marked as future. (src: app/src/report.ts:75-85)
- **AINS-053** When the daily section is shown, the summary line SHALL give the number of driving days and the average km per day. The divisor is `max(days_elapsed, 1)` for the current month and `days_in_month` otherwise. When any day has distance, the line SHALL also give the day with the most distance. (src: app/src/report.ts:119-120, app/src/report.ts:154; src: app/src/locales/en.ts:333-334)

### 3.7 Records
- **AINS-060** When records exist, the system SHALL show up to four cards: longest drive, top speed, most expensive charge and fastest peak charging. Tapping a card SHALL open the drive or charge detail. When there is no record at all, the system SHALL show "None". (src: app/src/report.ts:121-123, app/src/report.ts:155-160, app/src/report.ts:193-194)

### 3.8 Footprint (report extra, level ≥ 12)
- **AINS-070** When the report extras load, the system SHALL request `GET /api/cars/{id}/footprint?month=<YYYY-MM>&tz=<device zone>`, unless that car and month is already cached in memory, in which case it SHALL draw from the cache. (src: app/src/insights.ts:298, app/src/insights.ts:308, app/src/insights.ts:316-322)
- **AINS-071** When the footprint has lines, the system SHALL draw them on a `DriveMap` without speed colours and without start/end pins, and hand the map to the shell (`setMap`) so it is destroyed on navigation. The note SHALL read "{n} drives", followed by " · simplified ({a}/{b} points)" when `raw_points > points`. (src: app/src/insights.ts:309-315; src: app/src/main.ts:821; src: app/src/locales/en.ts:294-295)
- **AINS-072** When the footprint has no lines, the system SHALL show "No routes this month". When the request fails, it SHALL show "Couldn't load routes: {e}". (src: app/src/insights.ts:310, app/src/insights.ts:321; src: app/src/locales/en.ts:293, app/src/locales/en.ts:296)

### 3.9 Trends (report extra, level ≥ 12)
- **AINS-080** When the report extras load and the trends window already shown for the same car contains the month, the system SHALL only move the highlight to that month, with no request. (comment: app/src/insights.ts:301-302; src: app/src/insights.ts:323-326)
- **AINS-081** When a new window is needed, the system SHALL request `GET /api/cars/{id}/trends?month=<YYYY-MM>&tz=<device zone>&currency=<defaultCurrency()>`. It SHALL dim the old content to 55 % opacity while loading, and on failure show "Couldn't load trends: {e}". (src: app/src/insights.ts:327-330; src: app/src/locales/en.ts:297)
- **AINS-082** When trends are shown, the system SHALL show:
  - the 12-month distance, energy used and average efficiency (Σ kWh × 1000 ÷ Σ km);
  - bar charts for distance and energy used;
  - a line chart for efficiency ("Not enough data" with fewer than 2 values);
  - one cost bar chart per currency with its total (main currency in red, others in amber), or "No cost records";
  - a stacked "Charging mix" chart of the home / Supercharger / other energy shares.

  The selected month SHALL be highlighted with its value. (src: app/src/insights.ts:243-295; src: app/src/locales/en.ts:283-291)
- **AINS-083** When the trends main currency is chosen, the system SHALL use the default currency if any month has costs in it, else the first currency found. (src: app/src/insights.ts:281-282)

### 3.10 Home battery card
- **AINS-090** When Home is shown and the server's level is at least 12, the system SHALL wait for the server check, request `GET /api/cars/{id}/battery?summary=true` and render the battery card. If the request fails, the system SHALL show no card and no error. (src and comment: app/src/main.ts:787-795)
- **AINS-091** When the TeslaMate-method view model is available (AINS-110), the card SHALL show the health % in a ring, current and new capacity in kWh (an asterisk on "New" when the value is the device override), degradation %, cycles and the note "Same method as TeslaMate Battery Health". (src: app/src/insights.ts:94-103; doc: CHANGELOG.md v1.1.0; src: app/src/locales/en.ts:254)
- **AINS-092** When the TeslaMate view is not available and there are no range points or no baseline percentage, the card SHALL read "Not enough charging data yet (needs sessions that ended above 50%)". (src: app/src/insights.ts:104-105; src: app/src/locales/en.ts:214)
- **AINS-093** When the TeslaMate view is not available and range data exists, the card SHALL show:
  - the retention % in a ring;
  - the current range at 100 % against the baseline km;
  - the usable capacity from range × efficiency;
  - the first data month and the number of charges;
  - where the baseline comes from.

  (src: app/src/insights.ts:106-112)
- **AINS-094** When the user taps the battery card or its link, the system SHALL open the battery page for that car. (src: app/src/main.ts:793, app/src/main.ts:799)

### 3.11 Battery page — common
- **AINS-100** When the battery page opens, the system SHALL show "Loading…", then request `GET /api/cars/{id}/battery?tz=<device zone>` (without `summary` and without `new_kwh`). On failure it SHALL show the error message. (src: app/src/insights.ts:145-149)
- **AINS-101** When the response contains a `tm` object with a non-null `capacity_now_kwh` and a positive new capacity, the system SHALL show the TeslaMate-method page. Otherwise it SHALL show the range-based page. (src: app/src/insights.ts:42-57, app/src/insights.ts:150-151; doc: CHANGELOG.md v1.1.0)
- **AINS-102** When a scatter chart is drawn, the system SHALL need at least 2 points (else "Not enough data"):
  - the y range covers the 2nd–98th percentile of the points plus the medians and the reference line, padded by `max(2, 12 %)`;
  - points outside that range are not drawn;
  - a least-squares trend line is drawn unless disabled.

  (src: app/src/insights.ts:115-142; src: app/src/locales/en.ts:222)

### 3.12 Battery page — TeslaMate method (server level ≥ 14 with data)
- **AINS-110** When the view model is built, the system SHALL use new capacity = device override, else `tm.capacity_max_kwh`. It SHALL then compute on the device, with the same formulas as the API:
  - health = `min(100, now ÷ new × 100)`;
  - degradation = `max(0, 100 − now ÷ new × 100)`;
  - both rounded to 0.1;
  - cycles = `floor(tm.energy_added_kwh ÷ new)`.

  (comment: app/src/insights.ts:40; src: app/src/insights.ts:52-56)
- **AINS-111** When the TeslaMate page is shown, it SHALL contain these tiles:
  - health ("Now ÷ new capacity");
  - degradation (with "{v} kWh less" = `max(0, new − now)`);
  - current capacity (with "Average of the latest {now_samples} charge samples");
  - new capacity ("New (set)" plus "TeslaMate max {v} kWh" when the device override is used, else "Highest value recorded");
  - cycles (with total energy added);
  - rated consumption (kWh/100 km, labelled "From TeslaMate car data" or "Derived from charges").

  (src: app/src/insights.ts:207-215; src: app/src/locales/en.ts:255-264)
- **AINS-112** When the user enters a new capacity, the system SHALL accept a decimal comma or point. A value from 20 to 250 SHALL be saved rounded to 0.1 kWh for that car on this device, and the page re-rendered. An empty or out-of-range value SHALL show "Enter a value between 20 and 250 kWh" inline and focus the field. Reset SHALL remove the override. (src: app/src/insights.ts:216-220, app/src/insights.ts:226-235; src: app/src/locales/en.ts:266, app/src/locales/en.ts:277)
- **AINS-113** When the TeslaMate page is shown, the "Capacity by mileage" chart SHALL plot daily points against odometer, with half-month medians and a reference line at the new capacity and no trend line. It SHALL need more than one point and an odometer span over 100 km, else show "Not enough odometer data". (src: app/src/insights.ts:199-200, app/src/insights.ts:203, app/src/insights.ts:221; src: app/src/locales/en.ts:242)
- **AINS-114** When the TeslaMate page is shown, the "Capacity over time" chart SHALL plot daily points (at 12:00 UTC of the day), half-month medians (at the 8th or the 23rd), a reference line at the new capacity, and a trend line. (src: app/src/insights.ts:198, app/src/insights.ts:201-202, app/src/insights.ts:222)
- **AINS-115** When the TeslaMate page is shown, the footer SHALL explain the method and the 20–150 kWh sanity filter. (src: app/src/insights.ts:223; src: app/src/locales/en.ts:254, app/src/locales/en.ts:275-276)

### 3.13 Battery page — range-based fallback
- **AINS-120** When the baseline is computed, the system SHALL choose, in this order:
  - the device override (km);
  - otherwise the higher of the factory value and `max(initial_range100_km, current_range100_km)`.

  The factory value comes from matching `Model <car.model or "3"> <marketing_name>` against a Model 3 / Model Y table (Performance, Long Range / AWD, RWD), with Model 3 RWD 438 km as default. The percentage SHALL be `min(100, current ÷ baseline × 100)`, rounded to 0.1. (comment: app/src/insights.ts:60-62; src: app/src/insights.ts:63-70, app/src/insights.ts:81-92; doc: CHANGELOG.md v0.9.0 "never above 100%")
- **AINS-121** When the range-based page is shown, the tiles SHALL be:
  - retention % (with the unclamped value when it exceeds 100);
  - current range at 100 % with the value at the start of the records;
  - capacity from range × efficiency;
  - change per year = slope of a least-squares fit of range at 100 % over time (in years) ÷ baseline × 100.

  (src: app/src/insights.ts:152-170; src: app/src/locales/en.ts:228-234)
- **AINS-122** When the user enters a baseline, a value from 100 to 1000 km SHALL be saved rounded to a whole km for that car on this device. Other values SHALL show "Enter a value between 100 and 1000 km" inline. Reset SHALL remove the override. (src: app/src/insights.ts:171-175, app/src/insights.ts:183-192; src: app/src/locales/en.ts:239, app/src/locales/en.ts:248)
- **AINS-123** When the range-based page is shown, it SHALL contain three charts:
  - range at 100 % over time: monthly medians placed on the 15th, a reference line at the baseline, and a trend;
  - range at 100 % by odometer: needs an odometer span over 100 km, else "Not enough odometer data";
  - capacity estimate: points between 20 and 150 kWh exclusive; needs more than 2 points, else "Needs sessions that added ≥ 30%".

  (src: app/src/insights.ts:153-163, app/src/insights.ts:176-178; src: app/src/locales/en.ts:240-244)

### 3.14 Device-local overrides
- **AINS-130** When an override is read and the stored value for the car is not a positive number, or the JSON is unreadable, the system SHALL treat it as unset. (src: app/src/insights.ts:29-31, app/src/insights.ts:72-74)
- **AINS-131** When the TeslaMate view model is built and the car has a km baseline but no kWh override, and the server gives a rated consumption, the system SHALL compute `kWh = round(km × efficiency_kwh_100km ÷ 100, 0.1)`. If that value is from 20 to 250, it SHALL be stored as the kWh override and the "converted" flag set. The km baseline SHALL be removed in both cases. (comment: app/src/insights.ts:41; src: app/src/insights.ts:44-50; doc: CHANGELOG.md v1.1.0 "A full-range baseline (km) you set in an earlier version is converted to kWh automatically")
- **AINS-132** When the "converted" flag is set and a kWh override exists, the new-capacity box SHALL show "Your earlier full-range baseline was converted to kWh.". An explicit save or reset SHALL clear the flag. (src: app/src/insights.ts:34, app/src/insights.ts:51, app/src/insights.ts:217; src: app/src/locales/en.ts:268)
- **AINS-133** When the app is in demo mode, the overrides SHALL be stored under demo-only keys, so real and demo values never mix. (comment: app/src/demo.ts:18-21; doc: CHANGELOG.md v0.13.1)

## 4. Key design decisions

- **D-1 One persistent report shell.** The header, month pill and a sliding content area stay in place. A month change swaps only the content, with one directional slide. Seen months render from memory and refresh silently. (comment: app/src/report.ts:166-170; doc: CHANGELOG.md v0.12.0)
- **D-2 The client sends its own time zone and currency.** Every request carries the device IANA zone and the user's default currency, so the server aggregates in the user's local months and picks the main currency the user expects. Rationale: inferred from the parameters. Confirmed from code. (src: app/src/report.ts:210-211, app/src/insights.ts:304, app/src/insights.ts:328)
- **D-3 New capacity is applied on the device.** The kWh override is stored only on this device and applied in `tmView`. The server's `new_kwh` parameter is never sent. (comment: app/src/insights.ts:40; src: app/src/insights.ts:148; src: app/src/locales/en.ts:266 "saved on this device only") Why the server parameter is unused (for example so the home card and page stay consistent without extra requests) is not documented. Confirmed (current scope): the override is a per-device display setting; `new_kwh` stays available for other API clients.
- **D-4 Feature detection.** The report is gated on level 6 and the extras and home card on level 12. The TeslaMate method is detected by the presence of `tm` with data, not by level 14. (src: app/src/main.ts:789, app/src/main.ts:806, app/src/main.ts:821; src: app/src/insights.ts:43; comment: app/src/insights.ts:2-4)
- **D-5 Keep the range-based estimate as fallback.** With an older server, or too little charging data, the earlier range-based estimate is shown. (doc: CHANGELOG.md v1.1.0)
- **D-6 Validate the month before it reaches HTML.** Months from deep links and from callers are checked against `YYYY-MM` because they are interpolated into HTML. (comment: app/src/report.ts:172; comment: app/src/main.ts:945; doc: CHANGELOG.md v1.1.2 "safer rendering of values in … the report deep link")
- **D-7 Hand-written SVG charts.** All charts (bars, calendar, donuts, scatter, line, stacked) are inline SVG strings with CSS colour tokens; no chart library is used. Rationale (bundle size, theming) not documented. Confirmed (current scope): small bundle and theming through the Telemetry CSS tokens. (src: app/src/report.ts:51-85, app/src/insights.ts:115-142, app/src/insights.ts:243-278; src: app/package.json dependencies)
- **D-8 Reuse the trends window.** A 12-month window that already contains the new month is only re-highlighted, so stepping through months inside the window costs no requests. (comment: app/src/insights.ts:301-302)
- **D-9 Storage keys fixed at module load.** Override keys are computed once with `skey()`. Entering or leaving demo mode reloads the page, so the keys stay correct. (src: app/src/insights.ts:28, app/src/insights.ts:32, app/src/insights.ts:71; src: app/src/demo.ts:61-74)

## 5. Constraints

- Server API levels: report ≥ 6; footprint, trends and battery card ≥ 12; TeslaMate method needs a server that returns `tm` (level 14). (src: app/src/version.ts:10; comment: api/src/main.rs:302)
- New-capacity input 20–250 kWh at 0.1 kWh steps; baseline input 100–1000 km, whole km. (src: app/src/insights.ts:173, app/src/insights.ts:186, app/src/insights.ts:218, app/src/insights.ts:229)
- Months are computed in device local time (`nowMonth`, `shiftMonth`), and the server receives the device IANA zone, falling back to `UTC`. (src: app/src/report.ts:34-38, app/src/report.ts:210)
- Caches (report per car and month, footprint per car and month, last trends window) live in memory only and are lost on reload. (src: app/src/report.ts:164, app/src/insights.ts:298-299)
- Overrides are stored only in this browser / app installation. (src: app/src/locales/en.ts:239, app/src/locales/en.ts:266)
- Units are km and kWh only. (src: app/src/report.ts:126-130, app/src/insights.ts:98-101)

## 6. Non-goals

- Editing any report data on this screen. Costs and place names are edited in `app-records`. Confirmed (current scope).
- Syncing overrides across devices or to the server. (src: app/src/locales/en.ts:239, app/src/locales/en.ts:266 "saved on this device only")
- Currency conversion: each currency is shown separately. (src: app/src/report.ts:42, app/src/insights.ts:292)
- Miles or other unit systems. Confirmed (current scope): km / kWh / °C only, as TeslaMate stores them (no unit conversion found in `app/src`)
- Exporting reports (PDF, CSV). Confirmed (current scope) (no export code found)

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | When `/battery` fails, the error is appended below the "Loading…" text, which stays visible, and there is no Retry button. (src: app/src/insights.ts:145, app/src/insights.ts:149) | The report page replaces its skeleton and offers Retry (app/src/report.ts:218-224); here the loading text and the error show together. Confidence: likely. | Replace the loading text with the error and offer Retry. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor. |
| CB-2 | The footprint is cached per car and month for the whole page session and never refetched. The trends window is also reused without a refresh. (src: app/src/insights.ts:298-299, app/src/insights.ts:316-317, app/src/insights.ts:323-326) | The report numbers above refresh in the background on every visit (AINS-012). For the current month the map and trends can fall behind the report until the app is reloaded. Confidence: possible. | Refresh the current month's footprint and trends like the report. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (current month only, until reload). |
| CB-3 | The factory baseline table covers only Model 3 and Model Y. Any other model (for example Model S / X) gets "Model 3 RWD 438 km" unless a higher range was recorded. (src: app/src/insights.ts:63-70, app/src/insights.ts:83) | The source label then names the wrong car. This affects only the range-based fallback. Confidence: possible. | Table entries for other models, or a neutral label when the model is unknown. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: Model S / X fall back to a Model 3 label. |
| CB-4 | During the km → kWh migration the km baseline is deleted even when the converted value is outside 20–250 kWh and is therefore not stored. (src: app/src/insights.ts:46-49) | The user's manual baseline disappears without a replacement or a note. Confidence: possible (an implausible value may deliberately be dropped). | Keep the km value or tell the user it could not be converted. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: a manual km baseline whose kWh conversion is implausible is dropped silently. |
| CB-5 | The footprint title is "This month's routes" for every month, including past months. (src: app/src/insights.ts:310-311; src: app/src/locales/en.ts:292) | The report can show any past month. Confidence: possible (wording). | A month-neutral title such as "Routes". **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (wording). |

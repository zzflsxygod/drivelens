# api-insights — Monthly report, trends, footprint and battery health (server)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `api/src/report.rs`, `api/src/insights.rs`, plus the routes in `api/src/main.rs:882-885`, `third_party/teslamate/NOTICE`, `testdata/gen_battery_health.py`.
> In this document, "the system" means the drivelens-api handlers for `/api/cars/{id}/report`, `/api/cars/{id}/trends`, `/api/cars/{id}/footprint` and `/api/cars/{id}/battery`.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Turn the raw TeslaMate tables into per-month and long-term summaries for one car: a monthly report (totals, comparison with the previous month, home / Supercharger / other charging split, daily breakdown, records), 12-month trends, a map of all routes driven in a month (footprint), and battery health. Battery health uses the same method as TeslaMate's Grafana "Battery Health" dashboard, plus an older range-based estimate. The output is consumed by the app's report and battery screens (`app-insights`). (doc: README.md "Features"; doc: CHANGELOG.md v0.5.0, v0.9.0, v1.1.0)

## 2. Responsibility boundaries

### 2.1 In scope
- `GET /api/cars/{id}/report` — monthly report for one calendar month in the caller's time zone.
- `GET /api/cars/{id}/trends` — 12 monthly rows ending with a given month.
- `GET /api/cars/{id}/footprint` — thinned route polylines of all drives in a month.
- `GET /api/cars/{id}/battery` — range-based battery estimate plus the TeslaMate-method `tm` object.
- The charge-type classification (home / supercharger / other) used by the report and trends.
- Aggregation of charging costs per currency for the report and trends.

### 2.2 Out of scope
- Authentication, device scopes and failure limits → `api-auth`.
- Router, CORS, `ApiError` envelope (`500 {"error":"internal error"}`), `/health` and `API_LEVEL` → `api-core`.
- Existence and permissions of `drivelens.charge_costs` / `drivelens.address_aliases` and the `costs_ok` probe → `api-storage`.
- `LOC_CURRENCY` (currency guessed from the charge location) and the manual-cost / alias write endpoints → `api-records`.
- Home "this month" statistics (`/api/cars/{id}/stats`) → `api-summary`.
- Monthly-report push reminder (links to `/?view=report:YYYY-MM`) → `api-push`.
- Rendering, month navigation, device-local new-capacity / baseline overrides → `app-insights`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-core` — `AppState`, `ApiError`, the `TS` timestamp format (`YYYY-MM-DDTHH24:MI:SSZ`, `api/src/main.rs:121`), route registration.
  - `api-auth` — every route here sits behind the auth middleware (`api/src/main.rs:915`).
  - `api-storage` — `costs_ok()` decides whether `drivelens.charge_costs` is joined (`api/src/main.rs:57-65`); `drivelens.address_aliases` is joined unconditionally in report and trends.
  - `api-records` — `LOC_CURRENCY` SQL expression (`api/src/main.rs:69-83`).
  - `ext:TeslaMate DB` — tables `cars`, `drives`, `charging_processes`, `charges`, `positions`, `addresses`, `geofences` (read only).
  - `ext:PostgreSQL` — time-zone conversion (`AT TIME ZONE`, `pg_timezone_names`), `PERCENTILE_CONT`.
- **Used by:** `app-insights` (report page, trends, footprint map, battery page and home card); `app-demo` mirrors these response shapes (`app/src/demo/server.ts:199-306`).
- **Provided interface:**

| Method | Path | Auth | Query parameters | Purpose | API level |
|---|---|---|---|---|---|
| GET | `/api/cars/{id}/report` | yes | `month` (YYYY-MM, optional), `tz` (IANA, default `UTC`), `currency` (ISO 4217, default `JPY`) | Monthly report | 6 |
| GET | `/api/cars/{id}/trends` | yes | `month`, `tz`, `currency` (same as report) | 12-month trends | 12 |
| GET | `/api/cars/{id}/footprint` | yes | `month`, `tz` | Route lines of a month | 12 |
| GET | `/api/cars/{id}/battery` | yes | `summary` (bool), `tz`, `new_kwh` (number) | Battery estimate + `tm` health | 12 (`tm`: 14) |

(src: api/src/main.rs:882-885; comment: api/src/main.rs:302; comment: api/src/insights.rs:2-3)

## 3. External behavior

### 3.1 Common rules
- **INS-001** When any of the four endpoints is called without a valid `Authorization` bearer token, the system SHALL respond `401`. (test: api/src/main.rs auth_tests::only_pair_is_public; src: api/src/main.rs:915)
- **INS-002** When a read-only device token calls any of the four endpoints, the system SHALL serve it like a full token, because all four are `GET` routes. (doc: CHANGELOG.md v1.2.0 "Read-only devices … everything can be viewed"; see `api-auth` for the scope rule)
- **INS-003** When any of the four endpoints is handled, the system SHALL only read from the database and SHALL NOT write any row. (comment: api/src/report.rs:3; comment: api/src/insights.rs:2-3)
- **INS-004** When `tz` is omitted, the system SHALL use `UTC`. (src: api/src/report.rs:90, api/src/report.rs:245, api/src/insights.rs:18, api/src/insights.rs:186)
- **INS-005** When `report`, `trends` or `footprint` receives a `tz` that PostgreSQL rejects with SQLSTATE `22023`, the system SHALL respond `400 {"error":"unknown tz"}`. (src: api/src/report.rs:110-113, api/src/report.rs:254-257, api/src/insights.rs:24)
- **INS-006** When `report` or `trends` receives a `currency` that, after trimming and upper-casing, is exactly three ASCII letters, the system SHALL use it as the default currency; otherwise the system SHALL use `JPY`. (src: api/src/report.rs:91-92, api/src/report.rs:246-247)
- **INS-007** When a month window is computed, the system SHALL take local midnight of the 1st of the month in `tz` up to (excluding) local midnight of the 1st of the next month, converted to TeslaMate's naive UTC timestamps. (comment: api/src/report.rs:96; src: api/src/report.rs:97-109, api/src/report.rs:248-253, api/src/insights.rs:19-23)
- **INS-008** When a place name is shown for a drive start/end or a charge, the system SHALL use the user alias, else the geofence name, else `<address name or "road house_number">, <city>`. (src: api/src/report.rs:79, api/src/report.rs:192-193, api/src/report.rs:215)
- **INS-009** When a timestamp is returned in a record, the system SHALL format it as `YYYY-MM-DDTHH:MM:SSZ` (UTC). (src: api/src/report.rs:190, api/src/report.rs:213; src: api/src/main.rs:121)

### 3.2 Monthly report — request validation
- **INS-010** When `month` is present and is not exactly 7 characters of the form `YYYY-MM` (digits, `-` at index 4, month 01–12), the system SHALL respond `400 {"error":"month must be YYYY-MM"}`. (src: api/src/report.rs:81-85, api/src/report.rs:89)
- **INS-011** When `month` is omitted, the system SHALL report the current month in `tz`. (src: api/src/report.rs:98)
- **INS-012** When no row in `cars` has the requested id, the system SHALL respond `404 {"error":"car not found"}`. (src: api/src/report.rs:93-94)
- **INS-013** When the requested month is later than the current month in `tz`, the system SHALL respond `400 {"error":"month is in the future"}`. (src: api/src/report.rs:115-117)
- **INS-014** When validation fails for several reasons, the system SHALL check in this order: month format, car existence, time zone, future month. (src: api/src/report.rs:89-117)

### 3.3 Monthly report — data selection and overview
- **INS-020** When the report is built, the system SHALL include the car's drives and charging processes whose `start_date` lies in the window from the start of the previous month to the end of the requested month and whose `end_date` is not null; each row SHALL count for the month in which it started. (src: api/src/report.rs:196, api/src/report.rs:204, api/src/report.rs:222, api/src/report.rs:233)
- **INS-021** When the report is built, the system SHALL fill `overview` from rows that started in the requested month and `previous` from rows that started in the whole previous calendar month, also when the requested month is still in progress. (src: api/src/report.rs:101-103, api/src/report.rs:136, api/src/report.rs:147; corroborated by the UI text app/src/locales/en.ts:318)
- **INS-022** When an overview is computed, the system SHALL return `distance_km` (sum of `drives.distance`), `drive_duration_min`, `drive_count`, `energy_used_kwh`, `energy_added_kwh` (sum of `charge_energy_added`), `charge_count`, `costs` and `efficiency_wh_km`; null inputs count as 0. (src: api/src/report.rs:28-38, api/src/report.rs:135-150)
- **INS-023** When a drive's energy is computed, the system SHALL use `(start_rated_range_km − end_rated_range_km) × cars.efficiency` and SHALL add negative values as 0. (src: api/src/report.rs:195, api/src/report.rs:140; comment: api/src/main.rs:241)
- **INS-024** When `distance_km > 0`, the system SHALL set `efficiency_wh_km = energy_used_kwh × 1000 / distance_km`; otherwise `null`. (src: api/src/report.rs:160)
- **INS-025** When numbers are returned, the system SHALL round distances, energies and efficiency to 0.1 and money amounts to 0.01. (src: api/src/report.rs:26, api/src/report.rs:158-164)
- **INS-026** When the response is returned, it SHALL contain `month`, `timezone` (the `tz` used), `is_current`, `first_month`, `days_in_month`, `days_elapsed`, `overview`, `previous`, `split`, `daily` and `records`. (src: api/src/report.rs:58-65, api/src/report.rs:185-186)
- **INS-027** When the requested month equals the current month in `tz`, the system SHALL set `is_current = true`; otherwise `false`. (src: api/src/report.rs:104)
- **INS-028** When `days_elapsed` is computed, the system SHALL return today's day of month (in `tz`) for the current month and `days_in_month` for past months. (src: api/src/report.rs:105-107; comment: api/src/report.rs:61)
- **INS-029** When the car has drives, the system SHALL set `first_month` to the month (in `tz`) of its earliest drive start; when it has none, `null`. Charges are not considered. (src: api/src/report.rs:128-129)

### 3.4 Monthly report — costs and currencies
- **INS-030** When the manual-cost table is available, the system SHALL use a session's manual amount and currency if one exists, else TeslaMate's `charging_processes.cost`; when the table is not available, the system SHALL use only TeslaMate's cost. (src: api/src/report.rs:118-121, api/src/report.rs:216; src: api/src/main.rs:57-65)
- **INS-031** When a cost has no manual currency, the system SHALL use the currency guessed from the charge location (`LOC_CURRENCY`), and when that is unknown, the request's default currency. (src: api/src/report.rs:120, api/src/report.rs:146; comment: api/src/main.rs:150, api/src/main.rs:67-68)
- **INS-032** When costs are aggregated, the system SHALL sum amounts per currency without conversion and return a list of `{currency, amount}` sorted by currency code. (src: api/src/report.rs:20-25; doc: CHANGELOG.md v0.4.0 "per-currency statistics")
- **INS-033** When a session has no cost, the system SHALL still count it in `charge_count` and `energy_added_kwh` but add nothing to `costs`. (src: api/src/report.rs:148-150)

### 3.5 Monthly report — charge-type split
- **INS-040** When the report is built, `split` SHALL contain exactly three buckets in the order `home`, `supercharger`, `other`, each with `kind`, `count`, `energy_kwh` and `costs`, computed from the requested month's sessions only. (src: api/src/report.rs:143-157, api/src/report.rs:164)
- **INS-041** When at least one `charges` row of a session has `fast_charger_present = true` and any of the following holds, the system SHALL classify the session as `supercharger`: (a) any `charges` row of the session has `fast_charger_brand` matching the case-insensitive regex `^tesla$`, (b) any `charges` row has `fast_charger_type` matching the case-insensitive regex `^tesla` (prefix — same rule TeslaMate uses for free-Supercharging cost), or (c) the text `alias name + geofence name + address name + address display_name` matches the case-insensitive regex `(supercharger|超充|スーパーチャージャー|tesla)` (name fallback when brand/type are null or `<invalid>`). (src: api/src/report.rs charges_sql CASE / lateral probe; comment: api/src/report.rs module header; test: api/src/report.rs::tests::charges_sql_classifies_tesla_fc_before_name_fallback) Confirmed from code (TeslaMate): Grafana SuC panels key off `fast_charger_brand = 'Tesla'` ([teslamate#5885](https://github.com/teslamate-org/teslamate/pull/5885)); free-SuC cost keys off `fast_charger_type` starting with `"Tesla"` (`elixir/lib/teslamate/log.ex`). Third-party DC (CHAdeMO / CCS with a non-Tesla brand) stays `other` unless the place name matches (c).
- **INS-042** When a session is not fast (no `charges` row with `fast_charger_present = true`) and either its alias or geofence name matches the case-insensitive regex `(home|自宅|家|うち|house)` or its `address_id` equals the car's home address, the system SHALL classify it as `home`. (src: api/src/report.rs:218-219; comment: api/src/report.rs:8-9)
- **INS-043** When the home address is determined, the system SHALL take the `address_id` with the most of the car's charging sessions that started at or after (end of the requested window − 12 months), have `duration_min > 0` and an average power `charge_energy_added × 60 / duration_min < 22` kW. (Upper bound of this window: see CB-1.) (src: api/src/report.rs:206-212; comment: api/src/report.rs:206)
- **INS-044** When a session is neither `supercharger` nor `home`, the system SHALL classify it as `other`. (src: api/src/report.rs:220; comment: api/src/report.rs:10)
- **INS-045** When a session has no `charges` rows, the system SHALL treat it as not fast and with no peak power. (src: api/src/report.rs:230-232)

### 3.6 Monthly report — daily breakdown and records
- **INS-050** When the report is built, `daily` SHALL contain one entry per calendar day of the requested month (`date` = `YYYY-MM-DD`, ascending), with `distance_km` of drives and `energy_added_kwh` of charges that started on that local day; days without activity SHALL be present with 0. (src: api/src/report.rs:133-134, api/src/report.rs:141, api/src/report.rs:152, api/src/report.rs:184, api/src/report.rs:191, api/src/report.rs:214)
- **INS-051** When records are computed, the system SHALL consider only the requested month and return `longest_drive` (largest non-null `distance_km`), `top_speed_drive` (largest non-null `speed_max`), `most_expensive_charge` and `fastest_charge`; each SHALL be `null` when there is no candidate. (src: api/src/report.rs:166-183)
- **INS-052** When `most_expensive_charge` is chosen, the system SHALL compare only charges in the default currency (a null currency counts as the default); when none has a cost in that currency, it SHALL take the largest amount among all charges with a cost, regardless of currency. (comment: api/src/report.rs:174; src: api/src/report.rs:175-177)
- **INS-053** When `fastest_charge` is chosen, the system SHALL use the session with the largest `peak_kw` (maximum `charges.charger_power`) greater than 0. (src: api/src/report.rs:182, api/src/report.rs:231)
- **INS-054** When a drive record is returned, it SHALL contain `id`, `start_date`, `start_address`, `end_address`, `distance_km`, `duration_min`, `speed_max`; a charge record SHALL contain `id`, `start_date`, `address`, `energy_kwh`, `cost`, `currency`, `peak_kw`, `start_battery_level`, `end_battery_level`, `duration_min`, where `currency` is set only when `cost` is set (falling back to the default currency). (src: api/src/report.rs:47-52, api/src/report.rs:168-172)

### 3.7 Trends
- **INS-060** When `trends` receives an invalid `month`, the system SHALL respond `400 {"error":"month must be YYYY-MM"}`; when `month` is omitted, it SHALL use the current month in `tz`. (src: api/src/report.rs:244, api/src/report.rs:249)
- **INS-061** When trends are computed, the system SHALL return `{"months": [...], "timezone": tz}` with exactly 12 entries, oldest first, for the 11 months before `month` and `month` itself; months without data SHALL be present with zero values. (src: api/src/report.rs:248-253, api/src/report.rs:268, api/src/report.rs:281-286; comment: api/src/report.rs:241)
- **INS-062** When a trend month is filled, each entry SHALL contain `month`, `distance_km`, `energy_used_kwh`, `energy_added_kwh`, `efficiency_wh_km`, `drive_count`, `charge_count`, `costs`, `home_kwh`, `supercharger_kwh`, `other_kwh`. (src: api/src/report.rs:237-239)
- **INS-063** When drives and charges are assigned to trend months, the system SHALL use the month of their local start date in `tz`. (src: api/src/report.rs:270, api/src/report.rs:274)
- **INS-064** When trend costs and charge types are computed, the system SHALL apply the same cost, currency and classification rules as the report (INS-030 – INS-044). (comment: api/src/report.rs:241; src: api/src/report.rs:259-263, api/src/report.rs:277-278)
- **INS-065** When a trend month's `distance_km > 1.0`, the system SHALL set `efficiency_wh_km = energy_used_kwh × 1000 / distance_km`; otherwise `null`. (src: api/src/report.rs:282)
- **INS-066** When trend values are returned, the system SHALL round distances and energies to 0.1 and money to 0.01. (src: api/src/report.rs:280-285)

### 3.8 Footprint
- **INS-070** When `footprint` receives a `month` that is not `YYYY-MM` with a month 01–12, the system SHALL respond `400 {"error":"month must be YYYY-MM"}`; when omitted, it SHALL use the current month in `tz`. (src: api/src/insights.rs:17, api/src/insights.rs:20)
- **INS-071** When the footprint is built, the system SHALL read the car's `positions` with `date` in the month window and a non-null `drive_id`, ordered by `drive_id` then `date`; a drive that crosses a month boundary contributes only its positions inside the month. (src: api/src/insights.rs:25-28)
- **INS-072** When positions are thinned, the system SHALL produce one line per drive, keep each drive's first point, keep a following point when it is at least `step` metres from the last kept point (equirectangular distance, 111,320 m per degree, longitude scaled by the cosine of latitude), always keep the drive's last point, and drop lines with fewer than 2 points. (src: api/src/insights.rs:30-47; comment: api/src/insights.rs:13-14)
- **INS-073** When thinning, the system SHALL start with `step = 25` m and double it while the total number of points exceeds 8000 and `step < 1600`. (src: api/src/insights.rs:50-52; comment: api/src/insights.rs:49)
- **INS-074** When more than 8000 points remain after the largest step, the system SHALL keep every k-th point of each line (k = ceil(total / 8000)) plus each line's last point. (src: api/src/insights.rs:53-58)
- **INS-075** When the footprint is returned, coordinates SHALL be `[lng, lat]` pairs rounded to 5 decimals, in `{"lines": [[[lng,lat],…],…], "points": <points returned>, "raw_points": <positions read>}`. (src: api/src/insights.rs:12, api/src/insights.rs:59-61)

### 3.9 Battery — range-based estimate
- **INS-080** When `battery` is called, `points` SHALL contain one entry per finished charging session of the car with `end_battery_level ≥ 50` and `end_rated_range_km > 0`, ordered by `end_date`, with `date` (session end, UTC ISO), `odometer_km` (odometer of the session's position), `range100_km = end_rated_range_km / end_battery_level × 100`, `end_level`, and `capacity_kwh = charge_energy_added / (end_battery_level − start_battery_level) × 100` when the gain is ≥ 30 points and the energy is > 0 (else `null`). (src: api/src/insights.rs:76-85; comment: api/src/insights.rs:69-71)
- **INS-081** When `initial_range100_km` and `current_range100_km` are computed, the system SHALL take the median of `range100_km` over the first and the last (up to) 10 points respectively, rounded to 0.1; the median is the element at index ⌊n/2⌋ of the sorted values. (src: api/src/insights.rs:86-90, api/src/insights.rs:111)
- **INS-082** When `months` is computed, the system SHALL group points by the UTC calendar month of the session end and return per month the median `range100_km` (0.1), the median of non-null `capacity_kwh` (0.1, or null), the maximum `odometer_km` and the count `n`. (comment: api/src/insights.rs:91; src: api/src/insights.rs:92-102)
- **INS-083** When `initial_range100_km > 0`, the system SHALL set `retained_pct = current / initial × 100` (0.1); otherwise `null`. (src: api/src/insights.rs:103)
- **INS-084** When the response is built, the system SHALL return `efficiency_kwh_km` (= `cars.efficiency`), `capacity_from_range_kwh = current_range100_km × efficiency` (0.1, null if either is missing) and `capacity_from_energy_kwh` = median of the latest 10 non-null `capacity_kwh` values (0.1). (src: api/src/insights.rs:75, api/src/insights.rs:104, api/src/insights.rs:112-113)
- **INS-085** When `summary=true`, the system SHALL return `points` and `months` as empty arrays while still returning `n_points`, `first_date` and the other summary fields, and SHALL return the `tm` chart series empty (INS-101, INS-102). (src: api/src/insights.rs:105-109, api/src/insights.rs:185)
- **INS-086** When the battery response is returned, it SHALL contain `points`, `months`, `n_points`, `first_date`, `initial_range100_km`, `current_range100_km`, `retained_pct`, `efficiency_kwh_km`, `capacity_from_range_kwh`, `capacity_from_energy_kwh` and `tm`. (src: api/src/insights.rs:110-115)

### 3.10 Battery — TeslaMate "Battery Health" method (`tm`)
The formulas below are a port of TeslaMate's `grafana/dashboards/battery-health.json` (variable `aux` and "Battery Capacity by Mileage") at TeslaMate `main @ 9f4098e`, re-implemented in one SQL query. (comment: api/src/insights.rs:118-137; doc: CHANGELOG.md v1.1.0; doc: README.md "License")

- **INS-090** When `battery` is called, the response SHALL include a `tm` object with `method = "teslamate-battery-health"`. (src: api/src/insights.rs:106, api/src/insights.rs:204)
- **INS-091** When the rated consumption is computed, the system SHALL take the most frequent value of `ROUND(charge_energy_added / (end_rated_range_km − start_rated_range_km), 3) × 100` over the car's sessions with `duration_min > 10`, `end_battery_level ≤ 95`, both rated ranges set and `charge_energy_added > 0`; ties SHALL be broken by the larger value; when no session qualifies, the system SHALL use `cars.efficiency × 100`. The result is in kWh per 100 rated km and is returned as `efficiency_kwh_100km` (0.01) with `efficiency_source` = `"derived"` or `"car"`. (comment: api/src/insights.rs:124-126; src: api/src/insights.rs:146-158, api/src/insights.rs:205)
- **INS-092** When a capacity sample is computed for a `charges` row, the system SHALL use `rated_battery_range_km × efficiency / usable_battery_level` (kWh at 100 %), only for rows with `usable_battery_level > 0`. (comment: api/src/insights.rs:127; src: api/src/insights.rs:161, api/src/insights.rs:164)
- **INS-093** When a sample is outside 20–150 kWh, the system SHALL treat its `charges` row as if it did not exist. This is the one intended deviation from TeslaMate. (comment: api/src/insights.rs:136-138; doc: CHANGELOG.md v1.1.0; src: app/src/locales/en.ts:276)
- **INS-094** When samples are selected, the system SHALL use only finished sessions (`end_date` set) whose `charge_energy_added` is at least the rated-consumption value. (comment: api/src/insights.rs:128; src: api/src/insights.rs:163, api/src/insights.rs:172)
- **INS-095** When `capacity_now_kwh` is computed, the system SHALL average the samples of the latest 100 `charges` rows of qualifying sessions (ordered by session `end_date` descending, then row `date` descending) and return the number of rows in that window as `now_samples`. (comment: api/src/insights.rs:129; src: api/src/insights.rs:168-175, api/src/insights.rs:206)
- **INS-096** When a row in that window has a null `rated_battery_range_km`, the system SHALL count it in the 100-row window and in `now_samples` while the average ignores its null sample; Confirmed from code; equivalence with TeslaMate's dashboard was checked only on the fixture (`testdata/gen_battery_health.py`), where no such null rows occur. (src: api/src/insights.rs:138, api/src/insights.rs:169-175)
- **INS-097** When `capacity_max_kwh` is computed, the system SHALL take the maximum sample over the last `charges` row of each qualifying session. (comment: api/src/insights.rs:130; src: api/src/insights.rs:159-165, api/src/insights.rs:177)
- **INS-098** When `new_kwh` is a finite number from 20 to 250, the system SHALL use it as `capacity_new_kwh` with `new_source = "custom"`; otherwise it SHALL use `capacity_max_kwh` with `new_source = "max"`. (comment: api/src/insights.rs:130-131; src: api/src/insights.rs:180-181, api/src/insights.rs:207)
- **INS-099** When both current and new capacity exist and new > 0, the system SHALL return `health_pct = min(100, now / new × 100)` and `degradation_pct = max(0, 100 − now / new × 100)`, both rounded to 0.1; otherwise both `null`. (comment: api/src/insights.rs:132; src: api/src/insights.rs:182, api/src/insights.rs:208)
- **INS-100** When charge cycles are computed, the system SHALL return `cycles = floor(Σ charge_energy_added / new capacity)` over all the car's sessions with `charge_energy_added > 0.01`, plus `energy_added_kwh` (that sum, 0.1) and `charges` (that count). (comment: api/src/insights.rs:133; src: api/src/insights.rs:176, api/src/insights.rs:209-210)
- **INS-101** When `summary` is not true and a rated consumption exists, the system SHALL return `points`: one entry per local day (in `tz`) of session end with the average odometer (0.1) and the average last-row sample (0.01), only for sessions with a non-null sample and a position row. (comment: api/src/insights.rs:134; src: api/src/insights.rs:185-195)
- **INS-102** When `summary` is not true and a rated consumption exists, the system SHALL return `half_months`: one entry per local half-month with `period` = `YYYYMM1` (days 1–15) or `YYYYMM2` (16–end), the minimum odometer (rounded to 1 km), the median sample (`PERCENTILE_CONT(0.5)`, 0.1) and the count `n`. (comment: api/src/insights.rs:135; src: api/src/insights.rs:196-200)
- **INS-103** When `battery` receives a `tz` that is not in `pg_timezone_names`, the system SHALL group `points` and `half_months` in UTC instead of failing. (src: api/src/insights.rs:186-188)
- **INS-104** When `capacity_now_kwh`, `capacity_max_kwh` and `capacity_new_kwh` are returned, the system SHALL round them to 0.01. (src: api/src/insights.rs:206-207)
- **INS-105** When the data contains no sample outside 20–150 kWh and no tie in the rated-consumption mode, the `tm` values SHALL equal those of TeslaMate's "Battery Health" dashboard on the same database. This was checked by hand on the fixture `testdata/gen_battery_health.py`; no automated test asserts it. (comment: api/src/insights.rs:122-123; comment: testdata/gen_battery_health.py:2-5; doc: CHANGELOG.md v1.1.0)

## 4. Key design decisions

- **D-1 Month windows in the user's time zone.** Every month window is the user's local calendar month, converted to TeslaMate's naive UTC timestamps before querying. Rationale: TeslaMate stores UTC without zone. (comment: api/src/report.rs:96) Consequence: the client must send its IANA zone; the battery range-based `months` are the exception and use UTC months (INS-082).
- **D-2 Report reads no `positions`.** The report reads only `drives` and `charging_processes`, plus one indexed probe of `charges` per session for the DC flag and peak power. Rationale: performance on large TeslaMate databases. (comment: api/src/report.rs:3, api/src/report.rs:229) The probe of `charges` per session is the reason peak power uses reported `charger_power` only (see CB-3).
- **D-3 Charge classification (Tesla FC signals + name fallback).** Supercharger vs home vs other: a session is `supercharger` when it is DC (`fast_charger_present`) and either TeslaMate's own Supercharger signals fire (`fast_charger_brand` = Tesla, or `fast_charger_type` starts with Tesla) or the place name matches Supercharger/超充/スーパーチャージャー/tesla keywords; `home` is AC at a home-named place or the inferred home address (most frequent AC-rate charging place); everything else is `other`. (comment: api/src/report.rs module header; src: charges_sql) Confirmed from TeslaMate source and dashboards (see INS-041). Name keywords remain so road-name Superchargers with null/`<invalid>` brand/type, and user aliases, still classify correctly (issue #29).
- **D-4 No currency conversion.** Costs stay in their own currency; every cost field is a list of `{currency, amount}`. Records compare amounts within the main currency first. (comment: api/src/report.rs:174; doc: CHANGELOG.md v0.4.0)
- **D-5 Server default currency `JPY`.** If the client sends no valid `currency`, `JPY` is used. Rationale (confirmed, design): older installs assumed JPY before v0.10, and the app pins that for them; current apps always send `currency`. (src: api/src/report.rs:92; comment: app/src/i18n.ts:29)
- **D-6 Server-side footprint thinning.** The server returns at most about 8000 points per month with an adaptive distance step, and keeps the first and last point of each drive. Rationale: one range scan of `positions`, with a bounded payload for the map. (comment: api/src/insights.rs:12-14, api/src/insights.rs:49, api/src/insights.rs:53)
- **D-7 TeslaMate-identical battery health with one deviation.** The dashboard SQL is ported into one query. Samples outside 20–150 kWh are ignored because a single bogus `usable_battery_level` makes TeslaMate's MAX, and so the health %, meaningless. Ties in the consumption mode are ordered (TeslaMate leaves them unordered). The TeslaMate NOTICE is preserved because the code is a modified AGPL derivative. (comment: api/src/insights.rs:118-138; doc: README.md "License"; doc: third_party/teslamate/NOTICE)
- **D-8 Range-based estimate kept next to `tm`.** The older range-at-100 % estimate is still returned, so apps and servers older than the `tm` method, and cars with too little data, still get a value. (doc: CHANGELOG.md v1.1.0 "With an older server, or too little charging data, the app keeps showing the previous range-based estimate"; comment: app/src/insights.ts:3-4)
- **D-9 `summary=true` for the home card.** Chart series are left out in summary mode. Rationale (confirmed from code): the home card needs only the headline numbers; the app calls `battery?summary=true` only for that card. (src: api/src/insights.rs:105-109, api/src/insights.rs:185; src: app/src/main.ts:790)
- **D-10 Lenient time zone in `battery`.** An unknown `tz` falls back to UTC here, while report, trends and footprint answer `400`. Confirmed from code, not a bug: `tz` only groups the battery chart by local month, so falling back to UTC keeps the Home card working instead of failing it. (src: api/src/insights.rs:186-188)
- **D-11 Previous-month comparison uses the full previous month.** For a month in progress, the comparison is with all of last month, not with the same number of days. (src: api/src/report.rs:101-103; src: app/src/locales/en.ts:318)

## 5. Constraints

- API levels: report since level 6; trends, footprint and battery since level 12; `tm` since level 14. (comment: api/src/main.rs:302; src: app/src/version.ts:10)
- Read-only access to TeslaMate tables; the role has only `SELECT` there. (comment: api/src/report.rs:3; doc: README.md "How it works")
- Footprint: about 8000 points at most (it can exceed 8000 slightly because each line's last point is kept), step 25–1600 m, coordinates to 5 decimals. (src: api/src/insights.rs:50-59)
- Footprint binds the car id as a 16-bit integer for `positions.car_id`. (src: api/src/insights.rs:28)
- Battery range estimate: sessions ending at ≥ 50 % SoC; energy-based capacity needs a gain of ≥ 30 points; initial / current use 10 sessions each. (src: api/src/insights.rs:79, api/src/insights.rs:84, api/src/insights.rs:87-89)
- `tm`: sample sanity window 20–150 kWh; current = latest 100 rows; custom new capacity 20–250 kWh. (src: api/src/insights.rs:138, api/src/insights.rs:175, api/src/insights.rs:180)
- Units: always km and kWh; no miles. (comment: api/src/insights.rs:123)
- Manual costs are used only when `drivelens.charge_costs` exists and is writable for the API role. (src: api/src/main.rs:57-65, api/src/report.rs:118)

## 6. Non-goals

- Converting between currencies. (src: api/src/report.rs:20-25; doc: CHANGELOG.md v0.4.0 "per-currency statistics")
- Writing or caching anything in the database. (comment: api/src/report.rs:3; comment: api/src/insights.rs:2-3)
- Returning miles or other units. (comment: api/src/insights.rs:123)
- Storing the user's new-capacity or baseline value on the server. The endpoint accepts `new_kwh` per request, but the app keeps its value on the device. (src: api/src/insights.rs:73; src: app/src/locales/en.ts:266)
- Aggregating several cars in one response. Confirmed from code (every query filters on one `car_id`); reports are per car.

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | The home-address subquery uses only a lower bound, `start_date ≥ window end − 12 months`, with no upper bound. For a past month it therefore also counts sessions after that month, up to today. (src: api/src/report.rs:208-212) | The comment says "last 12 months" (api/src/report.rs:9, api/src/report.rs:206), which reads as the 12 months up to the reported month. Reports of old months can change after a move or a new home charger. Confidence: possible. | Count only sessions in the 12 months before the window end. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: only past months are affected. |
| CB-2 | The SQL also matches `house` for home and also searches `addresses.display_name` for Supercharger. (src: api/src/report.rs:217-218) | The module comment lists neither (api/src/report.rs:5-10). Likely the comment is out of date rather than the code. Confidence: likely (documentation drift). | Comment and SQL describe the same keyword lists. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Documentation only (module comment). |
| CB-3 | `peak_kw` is `max(charges.charger_power)` and `fastest_charge` requires `peak_kw > 0`. (src: api/src/report.rs:231, api/src/report.rs:182) | `api-records` notes that on some cars `charger_power` stays 0 for a whole DC session and derives power from other fields (`fill_power`, api/src/main.rs:185-215). Such sessions never become the fastest charge here. Confidence: possible. | Use the same fallback power as the charge detail. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: cars whose `charger_power` stays 0 on DC get no "fastest charge". |
| CB-4 | An unknown car id gives `404` on `report` (api/src/report.rs:93-94) but `200` with empty or zero data on `trends`, `footprint` and `battery` (no existence check in api/src/report.rs:242-287, api/src/insights.rs:15-62, api/src/insights.rs:74-116). | The four endpoints share one path pattern, but handle a missing car differently. Confidence: possible. | Same `404 {"error":"car not found"}` for all four. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor inconsistency. |
| CB-5 | `footprint` checks the year with `m[..4].parse::<u32>()`, which accepts a leading `+` (e.g. `+202-01`). The value then reaches the SQL cast. (src: api/src/insights.rs:17, api/src/insights.rs:20) | `report` and `trends` reject such input with `400` (api/src/report.rs:81-85). Here a PostgreSQL cast error would likely become `500`. Confidence: likely; low impact. | Reuse `valid_month` and answer `400`. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: `+202-01` reaches PostgreSQL, which rejects it as a datetime error (not 22023), so the answer is 500 instead of 400. |
| CB-6 | Monthly efficiency needs `distance_km > 0` in the report (api/src/report.rs:160) but `distance_km > 1.0` in trends (api/src/report.rs:282). | The same metric for the same month can be shown in one place and be `null` in the other. Confidence: possible (may be a deliberate noise filter). | One threshold for both, or a documented reason. **Review:** not a bug. Different noise filters for a single month vs. a 12-month line; cosmetic at most. |
| CB-7 | The comment says units are km / kWh and "the app converts". (comment: api/src/insights.rs:123) | The app shows km and kWh only and has no unit conversion. Confidence: likely (documentation drift). | Comment states that no conversion exists. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Documentation drift (the app has no unit conversion). |
| CB-8 | `report` and `trends` always `LEFT JOIN drivelens.address_aliases`, whether or not that table exists. (src: api/src/report.rs:200-201, api/src/report.rs:225) | docs/install.md:231 says drives, charging and reports keep working when only some features are disabled ("place aliases" is one, api/src/main.rs:601-603). Without the table the query fails with `500`. Confidence: possible (only on installs where the table could not be created). | Leave the alias join out when the alias table is unavailable, as is done for `charge_costs`. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Same as api-storage CB-1 (X-1). |

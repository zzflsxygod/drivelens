# api-records — Cars, drives, charges, place aliases and manual charging costs

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `api/src/main.rs` (records part: `LOC_CURRENCY`, `ListParams`, `Car`, `ChargeSummary`, `ChargePoint`, `fill_power`, `Drive`, `PathPoint`, `charge_select`, `drive_select`, `paged`, `drives_route`, `charges_route`, `car_months`, `list_cars`, `list_charges`, `get_charge`, `list_drives`, `get_drive`, `drive_path`, alias and cost handlers); `testdata/schema.sql` (TeslaMate columns read).
> In this document, "the system" means the drivelens-api HTTP handlers for cars, drives, charges, drive paths, per-month totals, place aliases and manual charging costs.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

TeslaMate records drives, charging sessions and positions in its own PostgreSQL tables. This module turns those rows into
JSON lists and detail objects that the DriveLens app can show directly. It also lets the user overlay two kinds of their own
data on top of TeslaMate's records: a custom name per place (address alias) and a manually entered cost per charging
session. TeslaMate's tables are never modified; the overlay data lives in the separate `drivelens` schema
(doc: README.md "How it works").

## 2. Responsibility boundaries

### 2.1 In scope

- Car list.
- Completed-drive list (with keyset paging), single drive, raw drive path.
- Completed-charge list (with keyset paging), single charge with its charging curve points and best-effort power values.
- Per-month drive and charge totals for list headers and the month picker.
- Place names: the naming precedence (alias > geofence > TeslaMate address) and the alias list / set / reset endpoints.
- Manual charging costs: effective cost (manual > TeslaMate), currency guessing from the charge location, set / reset endpoints.
- The shared SQL fragments `drive_select`, `charge_select`, `LOC_CURRENCY` and the `ListParams` query type that other API modules reuse.

### 2.2 Out of scope

- Route registration, CORS, the `{"error": "internal error"}` envelope for unexpected errors, `/health` → `api-core`.
- Authentication, read-only device enforcement (HTTP 403 `read_only` on writes), rate limits → `api-auth`.
- Creating `drivelens.address_aliases` / `drivelens.charge_costs`, and the availability probe `costs_ok` → `api-storage`.
- Home screen aggregates (`/api/cars/{id}/status|last-activity|stats|summary`) → `api-summary`.
- Monthly report, trends, footprint, battery → `api-insights`.
- Journeys (CRUD, suggestions, journey path) → `api-journeys`; this module only adds `journey_id` / `journey_name` to drives.
- Trip-summary notifications (they read aliases directly) → `api-push`.
- How the app renders these records → `app-records`, `app-journeys`, `app-home`.

### 2.3 Interfaces and dependencies

- **Depends on:**
  - `ext:TeslaMate DB` — read-only: `cars`, `drives`, `charging_processes`, `charges`, `positions`, `addresses`, `geofences` (testdata/schema.sql).
  - `api-storage` — `drivelens.address_aliases`, `drivelens.charge_costs`, `drivelens.journeys`, `drivelens.journey_drives` tables and the probes `costs_ok` (src: api/src/main.rs:57-65) and `journey::tables_ok` (src: api/src/main.rs:442).
  - `api-core` — router, `ApiError` → HTTP 500 envelope (src: api/src/main.rs:86-96), `bad()` helper (src: api/src/main.rs:486-488).
  - `api-auth` — every route is behind the auth middleware (test: api/src/main.rs auth_tests::only_pair_is_public).
- **Used by:**
  - `api-summary` — calls `list_drives` / `list_charges` with `limit=1` and reuses `Drive`, `ChargeSummary`, `costs_ok`, `LOC_CURRENCY` (src: api/src/summary.rs:155-159, 202-216).
  - `api-journeys` — reuses `drive_select(true)`, `charge_select`, `ChargeSummary`, `ListParams` (src: api/src/journey.rs:117, 249-261, 324).
  - `api-insights` — reuses `costs_ok`, `LOC_CURRENCY` (src: api/src/report.rs:118-121, 259-262).
  - `app-records`, `app-journeys`, `app-home`, `app-insights`, `app-notifications`, `app-demo` (mirrors these shapes).
- **Provided interface:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/cars` | Car list |
| GET | `/api/drives` | Completed drives, newest first; optional keyset paging |
| GET | `/api/drives/{id}` | One completed drive |
| GET | `/api/drives/{id}/path` | All positions of a drive |
| GET | `/api/charges` | Completed charging sessions, newest first; optional keyset paging |
| GET | `/api/charges/{id}` | One charging session + curve points |
| PUT / DELETE | `/api/charges/{id}/cost` | Set / remove a manual cost |
| GET | `/api/cars/{id}/months` | Per-month totals in a time zone |
| GET | `/api/addresses/aliases` | All place aliases |
| PUT / DELETE | `/api/addresses/{id}/alias` | Set / remove a place alias |

(src: api/src/main.rs:877, 886-890, 901-902, 908-909). All require authentication (test: api/src/main.rs auth_tests::only_pair_is_public).

## 3. External behavior

### 3.1 Common output conventions

- **REC-001** When any endpoint of this module returns a timestamp, the system SHALL format it as text `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, UTC; TeslaMate's naive timestamps are UTC). (src: api/src/main.rs:121, 282, 391, 411, 615; comment: api/src/summary.rs:183)
- **REC-002** When any endpoint of this module returns a numeric TeslaMate column, the system SHALL return it as a JSON number regardless of TeslaMate's column type (cast to `float8` / `int4` / `int8` in SQL). (comment: api/src/main.rs:14-15)
- **REC-003** When a place name is shown for a drive start, drive end or charge, the system SHALL use the first non-null of: the user's alias for that address, the TeslaMate geofence name, and `"<address name, or road + house number>, <city>"` built from the TeslaMate address. (src: api/src/main.rs:283, 412-413; comment: api/src/summary.rs:76)

### 3.2 Cars

- **REC-010** When `GET /api/cars` is called, the system SHALL return a JSON array of `{id, name, model, marketing_name, vin, efficiency}` for every TeslaMate car, ordered by `display_priority` then `id`. (src: api/src/main.rs:123-131, 364-369)

### 3.3 Drive list (`GET /api/drives`)

- **REC-020** When `GET /api/drives` is called, the system SHALL return only drives whose `end_date` is set (completed drives), ordered by `start_date` descending, then `id` descending. (src: api/src/main.rs:439-441)
- **REC-021** When the `car_id` query parameter is given, the system SHALL return only drives of that car; without it, drives of all cars. (src: api/src/main.rs:439)
- **REC-022** When `limit` is omitted, the system SHALL return at most 50 drives; when it is given, the system SHALL clamp it to 1..500. (src: api/src/main.rs:117)
- **REC-023** When `offset` is given, the system SHALL skip that many rows (negative values count as 0; default 0). (src: api/src/main.rs:118, 441)
- **REC-024** When `before` is given as `<timestamp>~<id>`, the system SHALL return only drives whose `(start_date, id)` is strictly less than `(timestamp interpreted as UTC, id)`. (comment: api/src/main.rs:105; src: api/src/main.rs:112-116, 440)
- **REC-025** When `before` has no `~` part (a bare timestamp, used by the app's month jump), the system SHALL return drives that started strictly before that instant (the id part is treated as the maximum 32-bit integer). (comment: api/src/main.rs:105; src: api/src/main.rs:114)
- **REC-026** When the id part of `before` is not an integer, the system SHALL treat it as the maximum 32-bit integer; when `before` is empty, the system SHALL ignore it. (src: api/src/main.rs:113-114)
- **REC-027** When `paged=true` is given, the system SHALL respond with `{"items": [...], "next_cursor": <string|null>}`, where `next_cursor` is `"<start_date>~<id>"` of the last item if the page holds exactly `limit` items, and `null` otherwise. (src: api/src/main.rs:307-311, 312-316)
- **REC-028** When `paged` is absent or false, the system SHALL respond with a plain JSON array of drives (compatibility with older apps). (comment: api/src/main.rs:107, 306; src: api/src/main.rs:308)
- **REC-029** When a drive is returned, the system SHALL include `id`, `car_id`, `start_date`, `end_date`, `start_address`, `end_address` (REC-003), `start_address_id`, `end_address_id`, `start_alias`, `end_alias` (the raw alias or null), `distance_km`, `duration_min`, `speed_max`, `start_battery_level` / `end_battery_level` (from the drive's start / end position), `outside_temp_avg`, `start_lat`, `start_lng`, `end_lat`, `end_lng`, `journey_id`, `journey_name`. (src: api/src/main.rs:224-255, 410-433)
- **REC-030** When a drive is returned, the system SHALL compute `energy_kwh` as `(start_rated_range_km − end_rated_range_km) × cars.efficiency`, and `efficiency_wh_km` as `energy_kwh × 1000 / distance` when `distance > 0`, else `null`. (src: api/src/main.rs:418-419; comment: api/src/main.rs:241 "same as TeslaMate's Grafana")
- **REC-031** When the journey tables are available, the system SHALL fill `journey_id` / `journey_name` with the journey the drive belongs to (or null); when they are not available, both SHALL be `null`. (src: api/src/main.rs:251-254, 405-408, 442)
- **REC-032** When an `id` query parameter is sent, the system SHALL ignore it (it is not deserialized from the query string). (src: api/src/main.rs:103-104)

### 3.4 Single drive and drive path

- **REC-040** When `GET /api/drives/{id}` names a completed drive, the system SHALL return that drive as one object with the fields of REC-029/REC-030. (src: api/src/main.rs:451-458)
- **REC-041** When `GET /api/drives/{id}` names no completed drive, the system SHALL respond HTTP 404 with `{"error": "not found"}`. (src: api/src/main.rs:456)
- **REC-042** When `GET /api/drives/{id}/path` is called, the system SHALL return every TeslaMate position whose `drive_id` is `id`, ordered by time, as `[{date, lat, lng, speed, elevation, battery_level}]`. (src: api/src/main.rs:257-265, 613-620)
- **REC-043** When `GET /api/drives/{id}/path` names a drive with no positions (or no such drive), the system SHALL return an empty array with HTTP 200. (src: api/src/main.rs:613-620)

### 3.5 Charge list (`GET /api/charges`)

- **REC-050** When `GET /api/charges` is called, the system SHALL return only charging sessions whose `end_date` is set, ordered by `start_date` descending, then `id` descending, with the same `car_id`, `limit`, `offset`, `before` and `paged` semantics as REC-021…REC-028. (src: api/src/main.rs:317-321, 371-383)
- **REC-051** When a charging session is returned, the system SHALL include `id`, `car_id`, `start_date`, `end_date`, `address` (REC-003), `geofence` (geofence name or null), `address_id`, `alias`, `latitude` / `longitude` (of the session's position), `charge_energy_added`, `charge_energy_used`, `cost`, `currency`, `cost_source`, `cost_note`, `teslamate_cost`, `default_currency`, `start_battery_level`, `end_battery_level`, `duration_min`, `outside_temp_avg`. (src: api/src/main.rs:133-162, 281-296)

### 3.6 Effective cost and currency

- **REC-060** When the manual-cost table is available and a manual cost exists for a session, the system SHALL return `cost` = the manual amount, `currency` = the manual currency, `cost_source` = `"manual"` and `cost_note` = the manual note. (src: api/src/main.rs:268-272; comment: api/src/main.rs:148)
- **REC-061** When no manual cost exists but TeslaMate has a cost, the system SHALL return `cost` = TeslaMate's cost, `currency` = the currency guessed from the location (REC-063, may be null) and `cost_source` = `"teslamate"`. (src: api/src/main.rs:269-271, 274-276)
- **REC-062** When neither cost exists, the system SHALL return `cost`, `currency` and `cost_source` as `null`. (src: api/src/main.rs:269-276)
- **REC-063** When guessing a currency from a location, the system SHALL map TeslaMate's `addresses.country` (English or localized names, case-insensitive) to JPY, CNY, TWD, HKD, KRW, USD, GBP, CAD, AUD, SGD, CHF or EUR as listed in `LOC_CURRENCY`; when the country is null and the position lies within latitude 24–45.6 and longitude 129–146, it SHALL return `JPY`; otherwise `null`. (src: api/src/main.rs:67-83)
- **REC-064** When a charging session is returned, the system SHALL always include `teslamate_cost` (TeslaMate's own cost, or null) and `default_currency` (REC-063 guess, or null), whether or not a manual cost exists. (src: api/src/main.rs:288; comment: api/src/main.rs:156)
- **REC-065** When the manual-cost table is not available, the system SHALL still serve charges, with `cost` = TeslaMate's cost and `cost_note` = null. (src: api/src/main.rs:273-277, 376)

### 3.7 Single charge and charging curve (`GET /api/charges/{id}`)

- **REC-070** When `GET /api/charges/{id}` names an existing session, the system SHALL return the REC-051 fields plus `points`: the session's TeslaMate `charges` rows ordered by time, each with `date`, `battery_level`, `charge_energy_added`, `charger_power`, `charger_voltage`, `charger_actual_current`, `charger_phases`, `fast_charger_present`, `power_kw`, `power_source`. (src: api/src/main.rs:164-183, 217-222, 385-401)
- **REC-071** When `GET /api/charges/{id}` names no session, the system SHALL respond HTTP 404 with `{"error": "not found"}`. (src: api/src/main.rs:387-389)
- **REC-072** When any point of a session has `charger_power > 0`, the system SHALL set every point's `power_kw` to its `charger_power` (negative values as 0) with `power_source` = `"reported"`. (src: api/src/main.rs:190-195; comment: api/src/main.rs:190)
- **REC-073** When no point reports `charger_power > 0`, the system SHALL compute `power_kw` per point as `charger_voltage × charger_actual_current × phases / 1000` with `power_source` = `"voltage_current"` if `fast_charger_present` is not true, voltage > 50 and current > 0; `phases` is `charger_phases` when it is 1–3, else 1. (src: api/src/main.rs:198-201; comment: api/src/main.rs:185-188)
- **REC-074** When REC-073 does not apply to a point, the system SHALL compute `power_kw` as the slope of `charge_energy_added` (kWh per hour) between the points two positions before and after it (clamped to the series), with `power_source` = `"energy_delta"`, if that window spans at least 20 seconds and energy did not decrease; otherwise `power_kw` and `power_source` SHALL be null. (src: api/src/main.rs:202-210, 213)
- **REC-075** When `power_kw` is set, the system SHALL round it to one decimal place. (src: api/src/main.rs:212)

### 3.8 Per-month totals (`GET /api/cars/{id}/months`)

- **REC-080** When `GET /api/cars/{id}/months?tz=<zone>` is called, the system SHALL return one row per calendar month (in `tz`) that has a completed drive or a completed charge of that car: `{month: "YYYY-MM", drive_count, distance_km, duration_min, charge_count, energy_added_kwh}`, newest month first. (src: api/src/main.rs:323-340)
- **REC-081** When grouping into months, the system SHALL use the drive's / session's `start_date` converted from UTC to `tz`. (src: api/src/main.rs:332, 335)
- **REC-082** When returning month totals, the system SHALL round `distance_km` and `energy_added_kwh` to one decimal place and report 0 for a side (drives or charges) with no rows that month. (src: api/src/main.rs:338-339)
- **REC-083** When `tz` is omitted, the system SHALL use `UTC`. (src: api/src/main.rs:330)
- **REC-084** When `tz` is not a time zone PostgreSQL recognises, the system SHALL respond HTTP 400 with `{"error": "unknown tz"}`. (src: api/src/main.rs:343)
- **REC-085** When the car does not exist or has no completed records, the system SHALL return an empty array with HTTP 200. (src: api/src/main.rs:329-345)

### 3.9 Place aliases

- **REC-090** When `GET /api/addresses/aliases` is called, the system SHALL return every alias as `{address_id, name, original_name, updated_at}` ordered by `name`, where `original_name` is TeslaMate's address name, else road + house number, else `display_name`. (src: api/src/main.rs:460-484)
- **REC-091** When `PUT /api/addresses/{id}/alias` is called with `{"name": "<text>"}`, the system SHALL trim the name, store it as the alias of TeslaMate address `id` (creating or replacing it, `updated_at` = now) and return the stored alias in the REC-090 shape. (src: api/src/main.rs:490-504)
- **REC-092** When the trimmed name is empty or longer than 200 characters, the system SHALL respond HTTP 400 with `{"error": "name must be 1-200 characters"}` and store nothing. (src: api/src/main.rs:491-494)
- **REC-093** When address `id` does not exist in TeslaMate, the system SHALL respond HTTP 404 with `{"error": "address not found"}`. (src: api/src/main.rs:495-496)
- **REC-094** When `DELETE /api/addresses/{id}/alias` removes an alias, the system SHALL respond HTTP 204; when there was no alias, HTTP 404 with `{"error": "no alias"}`. (src: api/src/main.rs:506-509)
- **REC-095** When an alias exists for an address, the system SHALL show it as the place name of every drive and charge at that address (REC-003). (src: api/src/main.rs:283, 412-413; doc: app/src/locales/en.ts:20 "alias.hint")

### 3.10 Manual charging costs

- **REC-100** When `PUT /api/charges/{id}/cost` is called with `{"amount": <number>, "currency": "<code>", "note": <string|null>}` and the input is valid, the system SHALL store (create or replace) the manual cost for session `id` with `updated_at` = now and return the updated session in the REC-051 shape. (src: api/src/main.rs:524-544)
- **REC-101** When `amount` is not finite, negative, or ≥ 1e9, the system SHALL respond HTTP 400 with `{"error": "amount must be 0..1e9"}`. (src: api/src/main.rs:526-528)
- **REC-102** When `currency`, after trimming and upper-casing, is not exactly three ASCII letters, the system SHALL respond HTTP 400 with `{"error": "currency must be a 3-letter ISO 4217 code"}`. (src: api/src/main.rs:529-532)
- **REC-103** When `note` is given, the system SHALL trim it and store null for an empty note; when the trimmed note is longer than 500 characters, the system SHALL respond HTTP 400 with `{"error": "note too long"}`. (src: api/src/main.rs:533-534)
- **REC-104** When storing an amount, the system SHALL round it to 2 decimal places (`numeric(12,2)`). (src: api/src/main.rs:539)
- **REC-105** When session `id` does not exist, `PUT` SHALL respond HTTP 404 with `{"error": "charge not found"}`. (src: api/src/main.rs:535-536)
- **REC-106** When `DELETE /api/charges/{id}/cost` is called, the system SHALL remove the manual cost if any and return the session as it now is (TeslaMate cost in effect, if any); calling it again SHALL give the same result. (src: api/src/main.rs:546-551; comment: api/src/main.rs:549)
- **REC-107** When the manual-cost table is missing or not writable, `PUT` and `DELETE` SHALL respond HTTP 503 with an `error` text that names `drivelens.charge_costs` and tells the admin to run `deploy/setup.sql` and restart the API. (src: api/src/main.rs:514, 525, 547)

## 4. Key design decisions

- **D-1 Cast everything in SQL.** All numeric and timestamp columns are cast to `float8` / ISO-8601 text in the queries, so the code does not depend on TeslaMate's exact column types. (comment: api/src/main.rs:14-15) Consequence: timestamps lose sub-second precision (REC-001).
- **D-2 User data as an overlay, TeslaMate untouched.** Aliases and manual costs are stored in `drivelens.*` tables keyed by TeslaMate ids and joined in at read time. (doc: README.md "How it works"; doc: app/src/locales/en.ts:20, 26) Consequence: deleting the overlay row restores TeslaMate's value (REC-094, REC-106).
- **D-3 Manual cost wins over TeslaMate's cost.** The effective `cost` is the manual entry if present; TeslaMate's value stays visible as `teslamate_cost`. (comment: api/src/main.rs:148; doc: app/src/locales/en.ts:26)
- **D-4 Currency guessed from the place, not converted.** A TeslaMate cost carries no currency, so one is guessed from the charge location; null means "unknown, the client applies its default". Amounts are never converted between currencies. (comment: api/src/main.rs:67-68, 150; doc: CHANGELOG.md v0.4.0)
- **D-5 Keyset paging, opt-in envelope.** Lists page by `(start_date, id)` cursor (API level 10); the `{items, next_cursor}` envelope is returned only with `paged=true`, so older apps keep getting a plain array. (comment: api/src/main.rs:105-108, 301-302, 306)
- **D-6 Energy from rated range, like TeslaMate's dashboards.** Drive energy is `Δ rated range × car efficiency`, not measured energy. (comment: api/src/main.rs:241)
- **D-7 Best-effort charging power.** Because some cars report `charger_power = 0` for a whole session (seen on DC fast charging), power falls back to AC voltage × current × phases, then to the slope of energy added; `power_source` tells the client which method produced the value (API level 4). (comment: api/src/main.rs:174-188, 301)
- **D-8 Optional features probed at request time.** The cost and journey joins are added only when their tables are usable, so a partially set-up database still serves read-only data. (comment: api/src/main.rs:55-56, 246) Probe semantics are owned by `api-storage`.

## 5. Constraints

- TeslaMate tables are read only; the module writes only `drivelens.address_aliases` and `drivelens.charge_costs`. (doc: README.md "How it works"; src: api/src/main.rs:497-500, 507, 537-542, 548)
- `limit` 1..500, default 50; `offset` ≥ 0. (src: api/src/main.rs:117-118)
- Alias name: 1–200 characters after trimming. Cost amount: finite, 0 ≤ amount < 1e9, stored with 2 decimals. Currency: 3 ASCII letters, stored upper-case. Note: ≤ 500 characters after trimming. (src: api/src/main.rs:491-494, 526-534, 539)
- Table-level constraints (alias `name` non-blank, `amount >= 0`, currency `^[A-Z]{3}$`, rows deleted with the TeslaMate address / charging process via `ON DELETE CASCADE`) are defined by `api-storage`. (src: api/src/main.rs:571-586)
- API levels: 4 = `power_kw`; 5 = manual costs; 10 = keyset paging and `/cars/{id}/months`. Clients gate features on these levels. (comment: api/src/main.rs:301-302)
- `tz` values must be PostgreSQL time-zone names. (src: api/src/main.rs:343)
- The Japan bounding box in REC-063 is a rough rectangle. It is used only when TeslaMate has no country for the address. Confirmed (current scope): the overlap with places outside Japan inside the box is an accepted heuristic; it affects only the default currency guess, and the user can set a manual cost in any currency.
- Drive paths are returned in full, without downsampling. (src: api/src/main.rs:613-620)

## 6. Non-goals

- Modifying TeslaMate's data (addresses, costs, geofences). (doc: README.md "How it works"; doc: app/src/locales/en.ts:20, 26)
- Currency conversion or exchange rates. (src: api/src/main.rs:67-83, 268-277) Confirmed (current scope): deliberate; amounts are kept per currency (CHANGELOG v0.4.0).
- Listing drives or charging sessions that are still in progress. (src: api/src/main.rs:373, 439) Confirmed from code: intended; the live state is shown on Home (`api-summary` status).
- Downsampling a single drive's path (journey paths are downsampled by `api-journeys`). Confirmed from code: one drive's positions are few enough to send in full.

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `DELETE /api/charges/{id}/cost` and `DELETE /api/addresses/{id}/alias` bind the path id as `id as i32` without first checking that the row exists. An id above 2^31 wraps around (e.g. 4294967297 → 1), so the request can delete the manual cost / alias of a different record. `DELETE …/cost` then answers 404 for the original id, while the alias delete answers 204. (src: api/src/main.rs:507, 548) | The PUT handlers check existence with the full 64-bit id first, so they cannot hit another row (src: api/src/main.rs:495, 535). The DELETE handlers are not guarded the same way. Likely a bug; it needs an authenticated full-scope client sending an out-of-range id. | Ids outside the 32-bit range match nothing (404, no deletion). **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Low severity (needs an authenticated full-scope client and an id ≥ 2^31). Fix: reject ids outside `i32` or check existence first, as the PUT handlers do (X-3). |
| CB-2 | A `before` cursor whose timestamp part is not a valid timestamp is passed straight to `$n::timestamptz`. PostgreSQL then raises an error, which becomes HTTP 500 `{"error": "internal error"}`. (src: api/src/main.rs:112-116, 374, 440) | Other invalid inputs in this module get 400 with a message (e.g. REC-084, REC-092). Likely an oversight. | HTTP 400 with an error message for a malformed cursor. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (the app only sends cursors it received). |
| CB-3 | When TeslaMate has no address row (or no name, road or city) and there is no alias or geofence, `CONCAT_WS(', ', …)` gives an empty string, so `address` / `start_address` / `end_address` is `""` rather than `null`. (src: api/src/main.rs:283, 412-413) | The fields are typed `Option<String>`, and clients show `—` only for null (app `esc()` maps null to "—"). An empty string shows as a blank place name. Likely, based on PostgreSQL's `concat_ws` semantics. | `null` when no part of the name is known. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor; also shows as an empty Home map title (app-home CB-3). Fix: `NULLIF(CONCAT_WS(…), '')`. |
| CB-4 | The paging cursor carries the start time truncated to whole seconds (REC-001). The next page uses `(start_date, id) < (truncated_time, id)`. If two rows start within the same second and that second has a fractional part, a row with a smaller id but a later fraction than the truncated value is skipped. (src: api/src/main.rs:121, 315, 320, 374, 440) | Keyset paging should never skip rows. Possible; the impact depends on whether TeslaMate stores sub-second start times (confirmed: TeslaMate's `timestamp` columns keep microseconds), and two drives or sessions starting in the same second are rare. | A cursor with full timestamp precision, or a comparison at second granularity. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Practically negligible: two records of one car must start in the same second. |
| CB-5 | `GET /api/drives/{id}` returns 404 for a drive that is still in progress, because it reuses the completed-only list query. `GET /api/charges/{id}` returns a session that is still in progress, because it has no `end_date` filter. (src: api/src/main.rs:439, 452-453, 386) | The two detail endpoints treat in-progress records differently. Possible inconsistency; either behavior could be intended. | The same rule for both detail endpoints. **Review:** not a bug. Inconsistent but harmless: the app opens drive details only from finished drives in lists; a running charge detail is useful. Keep as is unless an issue asks for it. |

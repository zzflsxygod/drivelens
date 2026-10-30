# api-summary — Home screen data (status, last activity, statistics)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `api/src/summary.rs`; route registration in `api/src/main.rs:878-881`; API level history in `api/src/main.rs:300-303`.
> In this document, "the system" means the drivelens-api handlers behind `/api/cars/{id}/status`, `/api/cars/{id}/last-activity`, `/api/cars/{id}/stats` and `/api/cars/{id}/summary`.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

The app's Home screen shows one car at a glance: its state, battery and range, odometer, software version, where it is,
its latest drive and charge, this month's totals and all-time totals (doc: README.md "Features" → Home). This module
provides that data from TeslaMate's tables in three independent endpoints, so the app can load and cache each section on
its own, plus one combined endpoint kept for an old app version (comment: api/src/summary.rs:251).

## 2. Responsibility boundaries

### 2.1 In scope

- Car identity and latest state, position and software version (`/status`).
- Latest completed drive and charge and the derived "current location" (`/last-activity`).
- All-time and current-month totals, including per-currency effective charging costs (`/stats`).
- The combined legacy response (`/summary`).

### 2.2 Out of scope

- Drive / charge row shapes, place naming, cost precedence and currency guessing → `api-records` (reused here).
- Probing whether `drivelens.charge_costs` is usable (`costs_ok`) → `api-storage`.
- Monthly report and trends → `api-insights`; battery health card data → `api-insights`.
- Authentication → `api-auth`; routing, error envelope → `api-core`.
- Rendering the Home screen and caching its sections → `app-home`.

### 2.3 Interfaces and dependencies

- **Depends on:**
  - `ext:TeslaMate DB` — `cars`, `states`, `positions`, `updates`, `drives`, `charging_processes`, `addresses` (src: api/src/summary.rs:123-149, 176-217).
  - `api-records` — `list_drives`, `list_charges` (with `limit=1`), `Drive`, `ChargeSummary`, `LOC_CURRENCY` (src: api/src/summary.rs:93-94, 155-159, 216).
  - `api-storage` — `costs_ok` and the `drivelens.charge_costs` table (src: api/src/summary.rs:202-204).
  - `api-core` — `ApiError`, `TS` timestamp format, router (src: api/src/summary.rs:3; api/src/main.rs:878-881).
  - `api-auth` — all four routes require authentication (test: api/src/main.rs auth_tests::only_pair_is_public).
- **Used by:**
  - `app-home` — `/status`, `/last-activity`, `/stats` (src: app/src/main.ts:774-782).
  - `app-demo` — mirrors these response shapes for demo mode.
  - Apps older than API level 3 (app v0.3.0) — `/summary` (comment: api/src/summary.rs:251). No current app code calls `/summary`.
- **Provided interface:**

| Method | Path | Query | Purpose |
|--------|------|-------|---------|
| GET | `/api/cars/{id}/status` | — | Car info, state, latest position, software, optional `tpms` (api_level ≥ 16) |
| GET | `/api/cars/{id}/last-activity` | — | Latest drive, latest charge, location |
| GET | `/api/cars/{id}/stats` | `tz`, `currency` | All-time and this-month totals |
| GET | `/api/cars/{id}/summary` | `tz`, `currency` | All of the above, flattened into one object |

## 3. External behavior

### 3.1 Status (`GET /api/cars/{id}/status`)

- **SUM-001** When car `id` exists, the system SHALL return `{car, state, position, software}` and, at api_level ≥ 16, may include `tpms`. (src: api/src/summary.rs Status / `car_status`)
- **SUM-002** When car `id` does not exist, the system SHALL respond HTTP 404 with `{"error": "car not found"}`. (src: api/src/summary.rs:117-119, 236)
- **SUM-003** When returning `car`, the system SHALL include `id`, `name`, `model`, `marketing_name`, `trim_badging`, `exterior_color`, `wheel_type`, `vin`, `efficiency` from TeslaMate's `cars` row. (src: api/src/summary.rs:5-16, 123-126)
- **SUM-004** When returning `state`, the system SHALL use the car's most recent TeslaMate `states` row (by start time): `{state: <TeslaMate state text, e.g. "online" | "offline" | "asleep">, since: <start time>}`, or `null` if the car has no state rows. (src: api/src/summary.rs:34-38, 128-131; testdata/schema.sql "states_status")
- **SUM-005** When returning `position`, the system SHALL use the car's most recent `positions` row whose `ideal_battery_range_km` is not null, with `date`, `latitude`, `longitude`, `battery_level`, `usable_battery_level`, `rated_battery_range_km`, `ideal_battery_range_km`, `est_battery_range_km`, `odometer_km`, `outside_temp`, `inside_temp`, `speed`; or `null` if there is none. (src: api/src/summary.rs:18-32, 133-144)
- **SUM-006** When returning `software`, the system SHALL use the car's most recent `updates` row with a non-null `version`: `{version, installed_at}`, where `installed_at` is the update's end time, or its start time if it has no end; or `null` if there is none. (src: api/src/summary.rs:40-44, 146-149)
- **SUM-007** When returning `tpms` (api_level ≥ 16), the system SHALL (1) load the car's **3 most recent completed drives** (`id`, `start_date`, `end_date`), then (2) for each drive newest-first query `positions` with **`date BETWEEN start_date AND end_date` AND `drive_id = id`** and any `tpms_pressure_fl/fr/rl/rr` non-null, `ORDER BY date DESC LIMIT 1`, stopping at the first hit — returning `{date, fl, fr, rl, rr}` in bar. If none, it SHALL fall back over the last **7 days** for that `car_id`. If still none, `tpms` SHALL be omitted or null. Results SHALL be served from a per-`car_id` in-memory cache with a **5 minute** TTL (bounded map). No DB migration. (src: `api/src/summary.rs` `load_tpms` / `TpmsCache`; issue #24)

### 3.2 Last activity (`GET /api/cars/{id}/last-activity`)

- **SUM-010** When car `id` does not exist, the system SHALL respond HTTP 404 with `{"error": "car not found"}`. (src: api/src/summary.rs:239-241)
- **SUM-011** When car `id` exists, the system SHALL return `{location, last_drive, last_charge}`, where `last_drive` is the car's newest completed drive in the `GET /api/drives` item shape and `last_charge` is its newest completed charging session in the `GET /api/charges` item shape (each `null` if none). (src: api/src/summary.rs:90-95, 154-160, 169)
- **SUM-012** When the car has both a last drive and a last charge and the charge started at or after the drive ended, the system SHALL return `location = {name: <charge address>, address_id: <charge address id>, source: "charge"}`. (src: api/src/summary.rs:161-164)
- **SUM-013** When the car has a last drive and SUM-012 does not apply, the system SHALL return `location = {name: <drive end address>, address_id: <drive end address id>, source: "drive"}`. (src: api/src/summary.rs:165)
- **SUM-014** When the car has a last charge but no drive, the system SHALL return the charge location with `source: "charge"`; when it has neither, `location` SHALL be `null`. (src: api/src/summary.rs:166-167)
- **SUM-015** When a location name is returned, the system SHALL apply the place-name precedence alias > geofence > TeslaMate address. (comment: api/src/summary.rs:76; src: api/src/main.rs:283, 412-413)

### 3.3 Statistics (`GET /api/cars/{id}/stats`)

- **SUM-020** When car `id` does not exist, the system SHALL respond HTTP 404 with `{"error": "car not found"}` (checked before the time zone). (src: api/src/summary.rs:244-245)
- **SUM-021** When `tz` is omitted, the system SHALL use `UTC`; when `tz` is not a PostgreSQL time-zone name, the system SHALL respond HTTP 400 with `{"error": "unknown tz"}`. (src: api/src/summary.rs:195-199, 231-233, 246, 248)
- **SUM-022** When `currency`, after trimming and upper-casing, is exactly three ASCII letters, the system SHALL use it as the fallback currency; otherwise the fallback SHALL be `JPY`. (src: api/src/summary.rs:261-265)
- **SUM-023** When the request is valid, the system SHALL return `{stats, this_month, timezone}` where `timezone` echoes the time zone used. (src: api/src/summary.rs:97-102, 224)
- **SUM-024** When returning `stats`, the system SHALL report: `total_distance_km` = sum of `distance` over all the car's drives; `drive_count` = number of completed drives; `charge_count` = number of completed charging sessions; `total_energy_added_kwh` = sum of `charge_energy_added` over all its sessions; `total_cost` = sum of TeslaMate's `cost` over all its sessions (manual costs not included). (src: api/src/summary.rs:46-56, 176-182)
- **SUM-025** When returning `this_month`, the system SHALL use the current calendar month in `tz` (`month` = `"YYYY-MM"`), counting drives and sessions whose start time is at or after the start of that month in `tz`. (src: api/src/summary.rs:183-193; comment: api/src/summary.rs:183)
- **SUM-026** When returning `this_month`, the system SHALL report `distance_km`, `drive_count` (completed only), `drive_energy_kwh` (sum of `Δ rated range × car efficiency`), `charge_count` (completed only), `charge_energy_added_kwh`, and `charge_cost` (TeslaMate cost only). (src: api/src/summary.rs:61-72, 186-193)
- **SUM-027** When returning costs, the system SHALL compute each session's effective cost (manual amount if the manual-cost table is available and has an entry, else TeslaMate's cost), skip sessions without one, assign each a currency (manual currency, else the currency guessed from the location, else the fallback currency of SUM-022), and group by currency. (src: api/src/summary.rs:201-217; comment: api/src/summary.rs:53, 201)
- **SUM-028** When returning cost groups, the system SHALL put all-time groups in `stats.costs` and current-month groups in `this_month.charge_costs`, each entry as `{currency, amount, count}`, sorted by currency code, with amounts rounded to 2 decimals per group. (src: api/src/summary.rs:58-59, 214-223)

### 3.4 Combined summary (`GET /api/cars/{id}/summary`)

- **SUM-030** When the request is valid, the system SHALL return one object whose top-level keys are the union of the `/status`, `/last-activity` and `/stats` responses (`car`, `state`, `position`, `software`, `tpms` (only when present, api_level ≥ 16; see SUM-001), `location`, `last_drive`, `last_charge`, `stats`, `this_month`, `timezone`). (src: api/src/summary.rs:104-112, 252-259)
- **SUM-031** When car `id` does not exist, the system SHALL respond HTTP 404 `{"error": "car not found"}`; otherwise, when `tz` is invalid, HTTP 400 `{"error": "unknown tz"}`. (src: api/src/summary.rs:256-257)

## 4. Key design decisions

- **D-1 Three independent endpoints.** Home data was split into `/status`, `/last-activity` and `/stats` at API level 3 (v0.3.1) so each section can load, fail and be cached separately; `/summary` remains for app v0.3.0. (comment: api/src/main.rs:301; comment: api/src/summary.rs:251; doc: CHANGELOG.md v0.3.0 – v0.3.2 "fast loading with cached data")
- **D-2 Index-backed status queries.** The latest-position query filters on `ideal_battery_range_km IS NOT NULL` to match TeslaMate's partial index; without it PostgreSQL would scan all positions of the car. (comment: api/src/summary.rs:121, 133-135)
- **D-8 TPMS via recent drives with BRIN date bounds, not `drive_id IN`.** TeslaMate recent builds replaced btree `positions_drive_id_date_index` with BRIN minmax_multi (`positions_drive_id_date_timestamp_minmax_multi_ops_index`); a `drive_id IN (SELECT … LIMIT 3)` semi-join was planned as Parallel Seq Scan (~2M rows, ~137 ms). Primary path loads 3 drive windows then queries `date BETWEEN $start AND $end AND drive_id = $id` so the BRIN can prune to the drive's blocks (Bitmap Index Scan). 7-day fallback still uses BRIN(date). 5 min process cache. (issue #24)
- **D-3 Aggregates avoid `positions`.** Statistics read only `drives` and `charging_processes`, never `positions`. (comment: api/src/summary.rs:172)
- **D-4 Costs per currency, never converted.** Effective costs are summed per currency; the single `total_cost` / `charge_cost` numbers remain as the legacy TeslaMate-only totals. (comment: api/src/summary.rs:53, 201; doc: CHANGELOG.md v0.4.0 "per-currency statistics")
- **D-5 Month boundary in the user's time zone.** TeslaMate stores naive UTC timestamps; the start of the month is computed in `tz` and converted back to UTC. (comment: api/src/summary.rs:183)
- **D-6 Current location = whatever happened last.** The location is the end of the last drive or the place of the last charge, whichever is later; no live GPS lookup. (comment: api/src/summary.rs:161)
- **D-7 JPY as the server-side fallback currency.** Used only for costs whose currency is unknown and when the client sends no valid `currency`. (comment: api/src/summary.rs:261) Rationale (confirmed, design): the project started in Japan and installs before v0.10 assumed JPY; the app pins that default for them (comment: app/src/i18n.ts:29). Current apps always send `currency`.

## 5. Constraints

- `tz` must be a PostgreSQL time-zone name. (src: api/src/summary.rs:197-198)
- `currency` must be a 3-letter code, else `JPY` is used. (src: api/src/summary.rs:262-264)
- Read-only on TeslaMate tables; reads `drivelens.charge_costs` only when the probe allows it. (src: api/src/summary.rs:202-204)
- Available since API level 3; per-currency `costs` / `charge_costs` since manual costs (API level 5). (comment: api/src/main.rs:301) Confirmed: `costs` / `charge_costs` arrived with manual costs in server 0.4.0 = level 5 (CHANGELOG v0.4.0; app/src/version.ts level table 5 → 0.4.0). The app treats their absence as "legacy server" (src: app/src/main.ts:552-554).

## 6. Non-goals

- Live data from Tesla's servers: all values come from what TeslaMate has stored. (doc: README.md "How it works")
- Currency conversion between cost groups. (doc: CHANGELOG.md v0.4.0) Confirmed (current scope): deliberate.
- Battery health on the Home screen (served by `api-insights` `/battery?summary=true`). (src: app/src/main.ts:787-795)

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `total_distance_km` and `total_energy_added_kwh` (and this month's `distance_km`, `drive_energy_kwh`, `charge_energy_added_kwh`) sum over all rows, including in-progress drives and sessions. The matching counts include only completed rows. (src: api/src/summary.rs:177-181, 187-192) | The filters differ between sums and counts in the same response. Possible. The visible effect is probably nil if TeslaMate fills `distance` / `charge_energy_added` only when a drive or session ends (confirmed: TeslaMate sets them when it closes the drive / completes the charging process). | Sums and counts over the same set of rows. **Review:** not a bug. In practice the in-progress rows have NULL distance / energy, so sums and counts cover the same records; aligning the filters would be a cleanup only. |
| CB-2 | Per-currency amounts are rounded to 2 decimals per (currency, this-month flag) group. The all-time `stats.costs[].amount` then adds two rounded floats without rounding again, so values such as `1234.5600000000002` can appear in JSON. (src: api/src/summary.rs:214, 218-221) | The JSON shows float artifacts that the per-group rounding was presumably meant to avoid. Possible, cosmetic: the app formats amounts with fixed decimals. | All-time amounts rounded to 2 decimals after summing. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (the app formats with fixed decimals). |
| CB-3 | `location.name` can be `""` instead of `null` when the place has no alias, geofence or address parts. Inherited from `api-records` CB-3. (src: api/src/summary.rs:164-166; api/src/main.rs:283, 412-413) | See `api-records` CB-3. Likely. | `null` when no name is known. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Same as api-records CB-3. |

# api-journeys — Journeys API (groups of drives, suggestions, cover, weather, speed bands)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `api/src/journey.rs`, `api/src/phase2.rs`, route table in `api/src/main.rs`, `README.md`, `CHANGELOG.md`,
> client usage in `app/src/journey.ts` / `app/src/journey2.ts` (for intent only), demo mirror in `app/src/demo/server.ts` (for intent only).
> In this document, "the system" means the drivelens-api handlers for `/api/journeys*` (journeys, suggestions,
> dismissals, journey path, cover image, weather per drive, energy by speed band).
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

TeslaMate records individual drives. A trip of several hours or days is split into many drives and charging stops.
This module lets the user group finished drives into named **journeys**, proposes groupings automatically
(**suggestions**), and computes per-journey views: totals, stops, charges, a downsampled route, a cover image, the
weather at each drive's start and the energy used per speed band. It stores only DriveLens' own data; TeslaMate's
tables are read, never written (comment: `api/src/journey.rs:2-3`, `api/src/phase2.rs:2-3`; doc: `README.md` "How it works").

## 2. Responsibility boundaries

### 2.1 In scope
- HTTP behavior of every `/api/journeys*` endpoint (validation, limits, status codes, error texts, response shapes).
- The meaning of the data in `drivelens.journeys`, `drivelens.journey_drives`, `drivelens.dismissed_suggestions`
  and `drivelens.weather_hourly` (what a row means and when it is written).
- The suggestion algorithm, dismissal semantics, path downsampling, journey summary and stop computation.
- Fetching and caching weather from Open-Meteo.
- The speed-band energy computation.

### 2.2 Out of scope
- Creating / upgrading the tables and columns (DDL constants live in these files, but running them at start-up,
  privileges and the degrade-instead-of-fail policy) → `api-storage`.
- Authentication, the read-only device rule and failure limits → `api-auth`.
- Route registration, CORS, the generic JSON error envelope for 500s, `API_LEVEL` → `api-core`.
- The shared SQL for drive rows (`drive_select`) and charge rows (`charge_select`, `costs_ok`, location currency) → `api-records`.
- Rendering journeys, share cards, local dismissal fallback → `app-journeys`.
- The demo-mode re-implementation of these endpoints → `app-demo`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-records` — `drive_select(true)` for drive rows incl. `journey_id`/`journey_name` (`api/src/main.rs:404-435`),
    `charge_select` + `costs_ok` for charge rows and costs (`api/src/main.rs:57-65`, `:267-298`), `ListParams` limit/offset (`api/src/main.rs:117-118`).
  - `api-storage` — the tables listed above; availability probes `tables_ok`, `dismiss_ok`, `cover_ok`, `weather_ok`
    (defined here, run as part of the storage policy).
  - `api-auth` — all routes sit behind the auth middleware (`api/src/main.rs:915`); read-only devices get `403 read_only`
    for every non-GET/HEAD request outside `/api/push/` (`api/src/auth.rs:460-463`).
  - `api-core` — route table (`api/src/main.rs:891-900`), `ApiError` → `500 {"error":"internal error"}`.
  - `ext:teslamate-db` — reads `drives`, `cars`, `positions`, `addresses`, `geofences`, `charging_processes`.
  - `ext:open-meteo` — `https://archive-api.open-meteo.com/v1/archive` and `https://api.open-meteo.com/v1/forecast` (`api/src/phase2.rs:159`).
- **Used by:**
  - `app-journeys` — every endpoint below.
  - `api-records` — `journey::tables_ok` decides whether drive rows carry `journey_id`/`journey_name` (`api/src/main.rs:442`).
  - `api-core` — `/api/health` reports `journeys`, `suggestion_dismissal`, `journey_cover`, `weather` (`api/src/main.rs:358-360`); startup feature log (`api/src/main.rs:604-606`).
  - `app-demo` — mirrors these response shapes (`app/src/demo/server.ts:321-420`, `:457-487`).
- **Provided interface (all under the auth middleware):**

| Method | Path | Purpose | Feature probe |
|---|---|---|---|
| GET | `/api/journeys` | list journeys with totals; optional `q` place/name search (api_level ≥ 16) | `tables_ok` |
| POST | `/api/journeys` | create a journey from drives | `tables_ok` |
| GET | `/api/journeys/suggestions` | proposed groupings | `tables_ok` (+ `dismiss_ok` optional) |
| POST | `/api/journeys/suggestions/dismiss` | stop suggesting these drives | `dismiss_ok` |
| DELETE | `/api/journeys/suggestions/dismissed` | forget all dismissals | `dismiss_ok` |
| GET | `/api/journeys/{id}` | journey detail | `tables_ok` |
| PATCH | `/api/journeys/{id}` | rename / change note | `tables_ok` |
| DELETE | `/api/journeys/{id}` | delete journey (drives kept) | `tables_ok` |
| PUT | `/api/journeys/{id}/drives` | replace the drive set | `tables_ok` |
| GET | `/api/journeys/{id}/path` | downsampled route + cumulative km | `tables_ok` |
| GET / PUT / DELETE | `/api/journeys/{id}/cover` | cover image | `cover_ok` |
| GET | `/api/journeys/{id}/weather` | weather at each drive start | `weather_ok` |
| GET | `/api/journeys/{id}/speed-bands` | distance/energy per speed band | none |

(src: `api/src/main.rs:891-900`)

## 3. External behavior

### 3.1 Feature availability
- **JRN-001** When `drivelens.journeys` or `drivelens.journey_drives` is missing, not readable/writable, or the
  sequence `drivelens.journeys_id_seq` is not usable, the system SHALL answer `GET/POST /api/journeys`,
  `GET /api/journeys/suggestions`, `GET/PATCH/DELETE /api/journeys/{id}`, `PUT /api/journeys/{id}/drives` and
  `GET /api/journeys/{id}/path` with `503` and `{"error": "journey tables drivelens.journeys / journey_drives are missing or not writable; run deploy/setup.sql and restart the API"}`. (src: `api/src/journey.rs:7`, `:53-63`, `:66`)
- **JRN-002** When the probe has once reported the journey tables as usable, the system SHALL keep treating them as usable for the life of the process without re-checking. (src: `api/src/journey.rs:54`, `:61`)
- **JRN-003** When `drivelens.dismissed_suggestions` is missing or lacks SELECT/INSERT/DELETE privilege, the system SHALL answer the dismiss and restore endpoints with `503` and `{"error": "table drivelens.dismissed_suggestions is missing or not writable; run the v0.6.1 SQL (deploy/drivelens-v0.6.1.sql)"}`, and suggestions SHALL be computed without dismissals. (src: `api/src/journey.rs:26`, `:29-37`, `:327-330`, `:419`, `:430`)
- **JRN-004** When the column `drivelens.journeys.cover_image` does not exist, the system SHALL answer all `/cover` methods with `503` and `{"error": "column drivelens.journeys.cover_image is missing; run deploy/setup.sql and restart the API"}` and SHALL report `has_cover: false` in journey details. (src: `api/src/phase2.rs:8`, `:31-37`, `:54`, `:62`, `:72`, `:79-82`)
- **JRN-005** When `drivelens.weather_hourly` is missing or lacks SELECT/INSERT/UPDATE privilege, the system SHALL answer `/weather` with `503` and `{"error": "table drivelens.weather_hourly is missing or not writable; run deploy/setup.sql and restart the API"}`. (src: `api/src/phase2.rs:9`, `:38-45`, `:93`)

### 3.2 Data model semantics
- **JRN-010** When a journey exists, the system SHALL represent it as one `drivelens.journeys` row (`id`, `car_id`, `name`, `note`, `created_at`, `updated_at`, and — with phase 2 — `cover_image`, `cover_updated_at`) plus one `drivelens.journey_drives` row per member drive. (src: `api/src/journey.rs:10-19`; `api/src/phase2.rs:12-13`)
- **JRN-011** When a drive is a member of a journey, the system SHALL NOT allow it to be a member of any other journey: `journey_drives.drive_id` is the primary key. (src: `api/src/journey.rs:18`)
- **JRN-012** When TeslaMate deletes a drive, the system SHALL lose that drive's membership and dismissal rows through `ON DELETE CASCADE`; when TeslaMate deletes a car, its journeys SHALL be deleted the same way. A journey whose drives all disappeared SHALL remain with zero drives. (src: `api/src/journey.rs:12`, `:18-19`, `:24`, `:112`)
- **JRN-013** When any journey endpoint runs, the system SHALL NOT write to TeslaMate tables. (comment: `api/src/journey.rs:2-3`, `:191`; `api/src/phase2.rs:2-3`; doc: `README.md` "How it works")

### 3.3 List — `GET /api/journeys`
- **JRN-020** When called, the system SHALL return a JSON array of journeys, each with `id`, `car_id`, `name`, `note`, `start_date` (earliest drive start), `end_date` (latest drive end), `start_address` (start of the earliest drive), `end_address` (end of the latest drive), `drive_count`, `distance_km` (sum, 1 decimal), `duration_min` (sum), `energy_kwh` (sum of (start − end rated range) × car efficiency, 1 decimal). Dates use `YYYY-MM-DDTHH:MM:SSZ`. (src: `api/src/journey.rs:86-115`)
- **JRN-021** When an address has a user alias, the system SHALL use the alias; otherwise the geofence name; otherwise "name or road + house number, city". (src: `api/src/journey.rs:105-110`)
- **JRN-022** When `car_id` is given, the system SHALL return only that car's journeys; otherwise journeys of all cars. (src: `api/src/journey.rs:119`)
- **JRN-023** When listing, the system SHALL order by first drive start descending, journeys without drives last, ties by `id` descending, and SHALL apply `limit` (default 50, clamped to 1–500) and `offset` (default 0, minimum 0). `before` and `paged` are ignored. (src: `api/src/journey.rs:114`, `:119-120`; `api/src/main.rs:117-118`)
- **JRN-024** When a journey has no drives, the system SHALL return it with `drive_count: 0` and `null` dates, addresses and totals. (src: `api/src/journey.rs:111-112`)
- **JRN-025** When `GET /api/journeys` receives a `q` query parameter, the system SHALL trim it, ignore it when empty, truncate it to 100 Unicode scalars, escape `!` `%` `_` for `ILIKE … ESCAPE '!'`, and return only journeys whose **name** matches case-insensitively as a substring, **or** that contain at least one drive whose start or end display name (same expression as api-records REC-003) matches. The filter SHALL combine with `car_id`, `limit` and `offset`. (src: `api/src/journey.rs` `list`; uses `ListParams::search_pattern`; issue #18)

### 3.4 Create — `POST /api/journeys`
Body: `{"name": string, "note"?: string|null, "drive_ids": [int]}` (src: `api/src/journey.rs:125`).
- **JRN-030** When `name` is empty after trimming or longer than 200 characters, the system SHALL answer `400 {"error": "name must be 1-200 characters"}`; otherwise it SHALL store the trimmed name. (src: `api/src/journey.rs:131-135`, `:163`)
- **JRN-031** When `note` is absent, `null` or blank after trimming, the system SHALL store no note; when it is longer than 2000 characters after trimming, the system SHALL answer `400 {"error": "note too long"}`. (src: `api/src/journey.rs:136-140`, `:164`)
- **JRN-032** When `drive_ids` (after removing duplicates) is empty or has more than 500 entries, the system SHALL answer `400 {"error": "drive_ids must contain 1-500 drives"}`. (src: `api/src/journey.rs:144-145`)
- **JRN-033** When any id does not exist or the drive is not finished (`end_date IS NULL`), the system SHALL answer `404 {"error": "some drives were not found"}`. (src: `api/src/journey.rs:146-151`)
- **JRN-034** When the drives belong to more than one car, the system SHALL answer `400 {"error": "drives belong to different cars"}`. (src: `api/src/journey.rs:152-153`)
- **JRN-035** When any drive already belongs to a journey, the system SHALL answer `409 {"error": "some drives already belong to another journey", "drive_ids": [<taken ids>]}`. (src: `api/src/journey.rs:154-157`)
- **JRN-036** When the checks pass, the system SHALL insert the journey (with the drives' `car_id`) and its memberships in one transaction; when a concurrent request takes one of the drives first (unique violation `23505`), it SHALL answer `409 {"error": "some drives already belong to another journey"}` without `drive_ids` and store nothing. (src: `api/src/journey.rs:166-175`)
- **JRN-037** When creation succeeds, the system SHALL answer `200` with the journey detail (§3.7). (src: `api/src/journey.rs:176`)

### 3.5 Update and delete — `PATCH` / `DELETE /api/journeys/{id}`
PATCH body: `{"name"?: string, "note"?: string|null}` (src: `api/src/journey.rs:127`).
- **JRN-040** When `name` is present, the system SHALL validate it as in JRN-030 and replace the name; when absent, the name SHALL stay. (src: `api/src/journey.rs:181`, `:183`)
- **JRN-041** When `note` is a string, the system SHALL validate it as in JRN-031 and replace the note (a blank string clears it); when `note` is `null`, the note SHALL be cleared; when `note` is absent, the note SHALL stay (API ≥ 0.14.1, see CB-1). (src: `api/src/journey.rs` `PatchBody`, `present`; test: api/src/journey.rs tests::patch_note_null_clears_absent_keeps, api/src/main.rs auth_tests::db_journey_note_and_auth_reload)
- **JRN-042** When the PATCH succeeds, the system SHALL set `updated_at = now()` and answer `200` with the journey detail; when no journey has this id, `404 {"error": "journey not found"}`. Validation errors are reported before the existence check. (src: `api/src/journey.rs:181-186`)
- **JRN-043** When `DELETE /api/journeys/{id}` hits an existing journey, the system SHALL delete it and its memberships (cascade), keep the TeslaMate drives, and answer `204`; otherwise `404 {"error": "journey not found"}`. (src: `api/src/journey.rs:189-194`)

### 3.6 Replace drives — `PUT /api/journeys/{id}/drives`
Body: `{"drive_ids": [int]}` (src: `api/src/journey.rs:129`).
- **JRN-050** When no journey has this id, the system SHALL answer `404 {"error": "journey not found"}`. (src: `api/src/journey.rs:198-199`)
- **JRN-051** When the drive list fails the checks of JRN-032 to JRN-035 (drives of this same journey are not "taken"), the system SHALL answer with the same status and error as there. (src: `api/src/journey.rs:143-159`, `:200`)
- **JRN-052** When the drives belong to a car other than the journey's car, the system SHALL answer `400 {"error": "drives belong to a different car"}`. (src: `api/src/journey.rs:201`)
- **JRN-053** When the checks pass, the system SHALL, in one transaction, remove memberships not in the list, add the new ones, and verify that the journey now has exactly as many drives as requested; on a mismatch (a concurrent request took a drive) it SHALL roll back and answer `409 {"error": "some drives already belong to another journey"}`. (src: `api/src/journey.rs:203-210`)
- **JRN-054** When the replacement succeeds, the system SHALL set `updated_at = now()` and answer `200` with the journey detail. (src: `api/src/journey.rs:211-213`)

### 3.7 Detail — `GET /api/journeys/{id}`
- **JRN-060** When no journey has this id, the system SHALL answer `404 {"error": "journey not found"}`. (src: `api/src/journey.rs:245-247`)
- **JRN-061** When found, the system SHALL answer `{id, car_id, name, note, has_cover, summary, drives, charges, stops, candidates}`. (src: `api/src/journey.rs:229-237`, `:299`)
- **JRN-062** When building `drives`, the system SHALL return the member drives as full drive rows (same shape as `/api/drives`, incl. `journey_id`, `journey_name`) ordered by start time. (src: `api/src/journey.rs:248-250`)
- **JRN-063** When the journey has drives, `charges` SHALL contain the car's finished charging sessions that started between the first drive's start and the last drive's end (inclusive), ordered by start, in the `/api/charges` row shape (manual costs applied when available). (src: `api/src/journey.rs:252-257`)
- **JRN-064** When the journey has drives, `candidates` SHALL contain the car's finished drives that are not members of this journey and whose start lies in the inclusive window [first member's start − 24 h, last member's end + 24 h] (this includes non-member drives between the first and the last member; corrected in review); a candidate that belongs to another journey SHALL carry that journey's `journey_id`. (src: `api/src/journey.rs:235`, `:258-262`)
- **JRN-065** When the journey has no drives, `charges` and `candidates` SHALL be empty and `summary` SHALL hold zero / null values. (src: `api/src/journey.rs:264`, `:266`)
- **JRN-066** When computing `summary`, the system SHALL set: `start_date`/`start_address` from the first drive, `end_date`/`end_address` from the last drive; `elapsed_min` = (last end − first start) in whole minutes; `distance_km` = sum of drive distances; `driving_min` = sum of drive durations; `stop_min` = max(0, elapsed − driving); `energy_used_kwh` = sum of each drive's energy with negative values counted as 0; `speed_max` = highest drive `speed_max`; `charged_kwh` = sum of `charge_energy_added` over `charges`; `charge_count` = number of `charges`; `efficiency_wh_km` = energy × 1000 / distance when distance > 0, else `null`. Distances, energies and efficiency SHALL be rounded to 1 decimal. (src: `api/src/journey.rs:266-289`)
- **JRN-067** When computing `summary.costs`, the system SHALL sum charge costs per currency (`currency`, else `default_currency`, else `"JPY"`) and round each sum to 2 decimals. (src: `api/src/journey.rs:279-286`) — see CB-3.
- **JRN-068** When the journey has N drives, `stops` SHALL have N − 1 entries, one per gap between consecutive drives, each with `after_drive_id`, `before_drive_id`, `start_date` (previous drive end), `end_date` (next drive start), `duration_min` (≥ 0), `address`/`lat`/`lng` of the previous drive's end, `charge_ids` of the `charges` that started from 120 s before the previous drive's end up to the next drive's start, and `charged_kwh` (their energy, 1 decimal). (src: `api/src/journey.rs:291-297`)
- **JRN-069** When the cover column exists, `has_cover` SHALL be `true` exactly when a cover image is stored. (src: `api/src/journey.rs:298`; `api/src/phase2.rs:79-82`)

### 3.8 Suggestions — `GET /api/journeys/suggestions`
Query: `car_id`, `gap_min`, `charge_gap_min`, `limit` (src: `api/src/journey.rs:303`).
- **JRN-070** When parameters are missing, the system SHALL use `gap_min = 60`, `charge_gap_min = 120`, `limit = 10`; it SHALL clamp both gaps to 1–1440 minutes and `limit` to 1–50. (src: `api/src/journey.rs:318-320`; doc: `app/src/locales/en.ts:75` "may be up to 2 hours")
- **JRN-071** When `car_id` is absent, the system SHALL use the first car ordered by `display_priority, id`; when there is no car, it SHALL return `[]`. (src: `api/src/journey.rs:321-322`, `:331`; doc: `CHANGELOG.md` v0.13.1 "journey suggestions work without a car filter again")
- **JRN-072** When computing suggestions, the system SHALL consider only the car's 400 most recent finished drives, processed in chronological order. (src: `api/src/journey.rs:323-326`; comment: `:312`)
- **JRN-073** When a drive already belongs to a journey or is dismissed, the system SHALL skip it and end the current chain at that point. (src: `api/src/journey.rs:341`; comment: `:313-315`)
- **JRN-074** When a drive follows the previous drive of the current chain, the system SHALL add it to the chain only if the chain's span (first drive start → this drive's end) stays ≤ 3 days AND either the gap (previous end → this start) is shorter than `gap_min`, or at least one charging session started within [previous end − 120 s, this start] and the gap is shorter than `charge_gap_min`; otherwise the chain SHALL end and a new chain SHALL start at this drive. (src: `api/src/journey.rs:336`, `:342-350`; comment: `:311-312`, `:345`)
- **JRN-075** When a chain ends, the system SHALL emit it as a suggestion only if it has at least 2 drives. (src: `api/src/journey.rs:341`, `:348`, `:352`)
- **JRN-076** When returning suggestions, the system SHALL order them newest first and return at most `limit`, each as `{drive_ids, name, start_date, end_date, start_address, end_address, distance_km (1 decimal), duration_min, charge_count}`, where `charge_count` counts the charges found in the joined gaps. (src: `api/src/journey.rs:305-309`, `:354-368`)
- **JRN-077** When naming a suggestion, the system SHALL use `"<start address of first drive> → <end address of the drive whose end is farthest from the start>"`, `?` for unknown parts, and append `（往返）` when the last drive ends less than 1 km from the first drive's start. (src: `api/src/journey.rs:357-363`)
- **JRN-078** When suggestions are computed, the system SHALL NOT store them; they are recomputed on every request. (src: `api/src/journey.rs:316-370`)

### 3.9 Dismissals
- **JRN-080** When `POST /api/journeys/suggestions/dismiss` receives `{"drive_ids": [...]}` with 1–1000 entries, the system SHALL record every id that exists in `drives` in `drivelens.dismissed_suggestions` (ids already recorded are ignored) and answer `{"dismissed": <rows inserted>}`; with 0 or more than 1000 entries it SHALL answer `400 {"error": "drive_ids must contain 1-1000 drives"}`. (src: `api/src/journey.rs:415-426`)
- **JRN-081** When a drive is dismissed, the system SHALL never again include it in a suggestion, and it SHALL break chains as in JRN-073, so the dismissed suggestion does not come back; later drives can still form new suggestions. (comment: `api/src/journey.rs:313-315`)
- **JRN-082** When `DELETE /api/journeys/suggestions/dismissed` is called, the system SHALL delete all dismissal rows for all cars and answer `{"restored": <rows deleted>}`. (src: `api/src/journey.rs:428-433`)

### 3.10 Path — `GET /api/journeys/{id}/path`
- **JRN-090** When no journey has this id, the system SHALL answer `404 {"error": "journey not found"}`; when it exists but has no drives, `{"points": [], "total_points": 0, "downsampled": false}`. (src: `api/src/journey.rs:390-393`)
- **JRN-091** When the journey has drives, the system SHALL read the positions of its member drives (by car, journey time window and drive id) in time order and return `{points: [{drive_id, lat, lng, speed, elevation, km}], total_points, downsampled}`. (src: `api/src/journey.rs:394-398`, `:411`)
- **JRN-092** When computing `km`, the system SHALL accumulate great-circle distance over all positions (before downsampling), only between consecutive points of the same drive (gaps between drives add nothing), and round to 2 decimals. (src: `api/src/journey.rs:401-408`; comment: `:381-382`)
- **JRN-093** When there are more than 3000 positions, the system SHALL keep every `ceil(total/3000)`-th point plus the first and last point of every drive, and set `downsampled: true`; `total_points` SHALL be the number of positions before downsampling. (src: `api/src/journey.rs:379`, `:400`, `:406-411`)

### 3.11 Cover — `/api/journeys/{id}/cover`
- **JRN-100** When `GET` hits an existing journey, the system SHALL answer `{"image": <data URL or null>, "updated_at": <ISO time or null>}`; when not found, `404 {"error": "journey not found"}`. (src: `api/src/phase2.rs:53-59`)
- **JRN-101** When `PUT` receives `{"image": ...}` that does not start with `data:image/jpeg;base64,`, `data:image/png;base64,` or `data:image/webp;base64,`, the system SHALL answer `400 {"error": "image must be a JPEG/PNG/WebP data URL"}`. (src: `api/src/phase2.rs:63-64`)
- **JRN-102** When the data URL is longer than 1,500,000 characters, the system SHALL answer `413 {"error": "image too large (max ~1 MB)"}`. (src: `api/src/phase2.rs:65`)
- **JRN-103** When `PUT` passes validation, the system SHALL store the data URL unchanged in the journey row, set `cover_updated_at` and `updated_at` to now, and answer `204`; when the journey does not exist, `404 {"error": "journey not found"}`. (src: `api/src/phase2.rs:66-68`)
- **JRN-104** When `DELETE` hits an existing journey, the system SHALL clear the image and `cover_updated_at`, set `updated_at`, and answer `204` (also when no cover was set); otherwise `404 {"error": "journey not found"}`. (src: `api/src/phase2.rs:71-76`)
- **JRN-105** When a cover is stored, the system SHALL NOT decode or re-encode it; only the prefix and length are checked. Confirmed from code (no image crate is a dependency). (src: `api/src/phase2.rs:61-69`)

### 3.12 Weather — `GET /api/journeys/{id}/weather`
- **JRN-110** When called, the system SHALL answer `{"drives": [{drive_id, temp_c, precip_mm, source}], "partial": bool, "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)"}` with one entry per member drive in start order. (src: `api/src/phase2.rs:94-98`, `:147-151`)
- **JRN-111** When locating a drive, the system SHALL use the start position's coordinates, else the start address's coordinates, and the start time truncated to the hour (UTC). A drive without coordinates SHALL get `null` values. (src: `api/src/phase2.rs:95-96`, `:148-149`)
- **JRN-112** When looking up weather, the system SHALL key the cache by a grid cell of 0.1° (`round(lat × 10)`, `round(lng × 10)`) and the UTC hour, in `drivelens.weather_hourly`. (src: `api/src/phase2.rs:99`, `:14-18`, `:109-113`; comment: `:90`)
- **JRN-113** When some drives have no cached hour, the system SHALL fetch at most 20 grid cells per request, each for the date range (first to last day) of its missing drives, and upsert every returned hour that has a temperature (`ON CONFLICT` updates `temp_c`, `precip_mm`, `source`, `fetched_at`). (src: `api/src/phase2.rs:119-140`, `:169`)
- **JRN-114** When fetching a cell, the system SHALL first query the Open-Meteo archive API, then — if any hour of the range is still missing — the forecast API, with `hourly=temperature_2m,precipitation&timezone=GMT` and the cell centre as coordinates; an archive hour wins over a forecast hour, and `source` SHALL be `"archive"` or `"forecast"` accordingly. (src: `api/src/phase2.rs:156-176`; comment: `:90-91`, `:154-155`)
- **JRN-115** When the archive request returns a non-success status, the system SHALL continue with the forecast API; when the forecast request returns a non-success status, the system SHALL stop for that cell. (src: `api/src/phase2.rs:162`; comment: `:162` "forecast rejects dates older than ~3 months")
- **JRN-116** When a cell fetch fails with an error, the system SHALL log a warning, set `partial: true`, and still answer with whatever is cached. (src: `api/src/phase2.rs:142`, `:145`, `:151`)
- **JRN-117** When making outbound weather requests, the system SHALL use a dedicated HTTP client with a 15-second timeout, not the Web Push client. (src: `api/src/phase2.rs:129`; comment: `api/src/main.rs:49`)
- **JRN-118** When a journey id does not exist, the system SHALL answer `200` with an empty `drives` array. (src: `api/src/phase2.rs:94-98`) — see CB-4.

### 3.13 Speed bands — `GET /api/journeys/{id}/speed-bands`
- **JRN-120** When the journey does not exist or has no drives, the system SHALL answer `{"bands": [], "method": "none"}`. (src: `api/src/phase2.rs:189-193`)
- **JRN-121** When computing bands, the system SHALL build segments from consecutive positions of the same member drive that are less than 10 minutes apart and have coordinates; segment speed = mean of the two speeds (a missing speed is replaced by the other, else 0); segment distance = great-circle distance; segment energy = mean power × duration when both points have power. (src: `api/src/phase2.rs:194-204`)
- **JRN-122** When classifying a segment, the system SHALL use `city` for speed < 40 km/h, `suburb` for 40–80 km/h (inclusive), `highway` for > 80 km/h. (src: `api/src/phase2.rs:205`; comment: `:184`)
- **JRN-123** When estimating a drive's band energy, the system SHALL use integrated power where available and, for the remaining distance, the drive's measured kWh/km (from power if more than 1 km had power, else drive energy / drive distance); it SHALL then scale the drive's band energies so they add up to the drive's energy (max(0, (start − end rated range) × efficiency)) and scale band distances so they add up to the drive's recorded distance. (src: `api/src/phase2.rs:210-232`; comment: `:185-187`, `:227`)
- **JRN-124** When answering, the system SHALL return `{"bands": [...3 bands...], "method": "power"|"mixed"|"distance", "thresholds_kmh": [40, 80]}`; each band has `key` (`city`/`suburb`/`highway`), `label` (`市区`/`郊外`/`高速`), `distance_km` (1 decimal), `energy_kwh` (2 decimals), `wh_km` (rounded; `null` below 0.5 km), `duration_min` (1 decimal), `share` (% of distance, 1 decimal). (src: `api/src/phase2.rs:234-243`)
- **JRN-125** When more than half of the band distance had power data, `method` SHALL be `"power"`; when some had, `"mixed"`; otherwise `"distance"`. (src: `api/src/phase2.rs:242`)

### 3.14 Access control (applied by `api-auth`)
- **JRN-130** When a read-only device calls any POST/PATCH/PUT/DELETE journey endpoint, the system SHALL be unreachable: the auth middleware answers `403` with code `read_only`. GET endpoints, including `/weather` (which may write the weather cache), remain allowed. (src: `api/src/auth.rs:460-463`; test: `api/src/auth.rs tests::read_only_devices`)
- **JRN-131** When any `/api/journeys*` route is called without a valid `Authorization` header, the system SHALL be unreachable: the request is answered `401`. (test: `api/src/main.rs auth_tests::only_pair_is_public`)

## 4. Key design decisions

- **D-1 Own schema, read-only TeslaMate.** Journeys, memberships, dismissals, covers and the weather cache live in `drivelens.*`; TeslaMate rows are only referenced by foreign keys. Rationale: DriveLens must never modify TeslaMate's tables (doc: `README.md` "How it works"; comment: `api/src/journey.rs:2-3`). Consequence: cleanup follows TeslaMate deletes via `ON DELETE CASCADE`.
- **D-2 One journey per drive, enforced by the database.** `journey_drives.drive_id` is the primary key; handlers pre-check and return `409` with the taken ids, and also handle the race (`23505` on create, count check on replace). Rationale for the race handling is stated (comment: `api/src/journey.rs:208`); rationale for "one journey per drive" (confirmed, design): a drive belongs to one trip, so journey totals never count a drive twice.
- **D-3 Suggestions are computed, not stored.** Only dismissals are persisted, per drive, so a dismissed suggestion cannot reappear while new drives still form new suggestions (comment: `api/src/journey.rs:311-315`). The 3-day span cap avoids chaining a whole commute history (comment: `:345`). The 400-drive look-back bounds the work (confirmed from code).
- **D-4 Charging stops extend the gap.** A gap with a charge may be up to `charge_gap_min` (default 2 h) instead of `gap_min` (doc: `app/src/locales/en.ts:75`).
- **D-5 Path downsampling with exact distance.** Cumulative km is computed on the full track before downsampling, and drive endpoints are always kept (comment: `api/src/journey.rs:381-383`). The window + car filter is chosen to use the positions BRIN date index (comment: `:383`).
- **D-6 Cover stored inline.** The cover is stored as a data URL in a `text` column of the journey row (src: `api/src/phase2.rs:12`, `:66`); the app sends a small JPEG (doc: `CHANGELOG.md` v0.7.0 "stored as a small JPEG"). Rationale (confirmed): the cover is small, and storing it in the row keeps backup and uninstall to the `drivelens` schema only, with no file storage in the container (read-only root filesystem).
- **D-7 Weather cache on a 0.1° × 1 h grid.** Requests to Open-Meteo use the cell centre, and results are cached so each cell-hour is fetched once (comment: `api/src/phase2.rs:90-91`). Confirmed: the grid also limits the location precision sent to Open-Meteo (SECURITY.md: coordinates "rounded to 0.1°").
- **D-8 Archive first, forecast for recent days.** The archive API lags a few days; the forecast API's past data fills those hours, and it rejects dates older than about 3 months (comment: `api/src/phase2.rs:154-155`, `:162`).
- **D-9 Speed-band energy calibrated to the drive total.** Band energies are scaled to the drive's energy, computed the same way as elsewhere (rated range × efficiency) so numbers agree across screens (comment: `api/src/phase2.rs:184-187`).
- **D-10 Degrade instead of fail.** Each feature checks its own table/column and answers `503` with a setup hint, so the rest of the API keeps working (comment: `api/src/journey.rs:3`).
- **D-11 Server-side Chinese labels.** Suggestion names use the suffix `（往返）` and band labels are Chinese; the app localizes both (src: `app/src/journey.ts:49-50`, `app/src/journey2.ts:89-90`). Confirmed: kept for compatibility with existing data and older clients; current apps localize them. Server texts are not localized (see Non-goals).

## 5. Constraints

- Journey name: 1–200 characters after trimming; note: ≤ 2000 characters after trimming. (src: `api/src/journey.rs:133`, `:138`)
- Drive ids per create/replace: 1–500 distinct; per dismiss: 1–1000. (src: `api/src/journey.rs:145`, `:420`)
- All drives of a journey: finished and of one car. (src: `api/src/journey.rs:149`, `:153`, `:201`)
- List: `limit` 1–500 (default 50). Suggestions: `limit` 1–50 (default 10), gaps 1–1440 min, look-back 400 drives, span ≤ 3 days, ≥ 2 drives. (src: `api/src/main.rs:117`; `api/src/journey.rs:318-324`, `:346`)
- Path: about 3000 points plus drive endpoints. (src: `api/src/journey.rs:379`)
- Cover: JPEG/PNG/WebP data URL, ≤ 1,500,000 characters. (src: `api/src/phase2.rs:63-65`)
- Weather: ≤ 20 cells fetched per request; 15 s timeout per HTTP request; up to 2 requests per cell. (src: `api/src/phase2.rs:129-130`, `:159`)
- Speed bands: thresholds 40 / 80 km/h; segments < 10 min apart; `wh_km` only for ≥ 0.5 km. (src: `api/src/phase2.rs:204-205`, `:239`)
- Introduced by API level 8 (journeys), 9 (dismissals), 11 (cover, weather, speed bands). (comment: `api/src/main.rs:302`)
- All endpoints require authentication; writes require a full-scope device or the owner key. (src: `api/src/main.rs:915`; `api/src/auth.rs:460-463`)

## 6. Non-goals

- Changing TeslaMate drives or charges (grouping exists only in DriveLens). (doc: `app/src/locales/en.ts:376` "TeslaMate's drives are not changed"; comment: `api/src/journey.rs:191`)
- Journeys spanning several cars. (src: `api/src/journey.rs:153`)
- Creating journeys automatically; suggestions only propose. Confirmed (current scope).
- Per-car dismissal reset; restore clears all dismissals. (src: `api/src/journey.rs:431`)
- Weather forecasts for the future, or weather along the route; only the start hour/place of each drive. (comment: `api/src/phase2.rs:90`)
- Image processing of covers on the server (no resize, no validation of the image bytes). Confirmed (current scope): the app resizes before upload.
- Localization of server-generated texts. Confirmed (current scope): the app localizes; push texts are the exception (`api-push`, per-subscription locale).

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | `PatchBody.note` is `Option<Option<String>>` without a custom deserializer (src: `api/src/journey.rs:127`, `:182`). With serde's default handling, `"note": null` deserializes to `None` (same as absent), so the note is left unchanged. The app sends `note: null` when the user empties the note (src: `app/src/journey.ts:159`, `:328`). | The double `Option` only makes sense if `null` should clear the note; the demo mirror clears it on `null` (src: `app/src/demo/server.ts:472`). Likely: the user cannot remove a note from the app. | `"note": null` clears the note; absent leaves it unchanged. **Review:** real issue, verified at 9b1c39c. **Fixed in v1.2.3 / API 0.14.1:** `note` uses `#[serde(default, deserialize_with = "present")]`, so `null` → clear and absent → unchanged; the demo already behaved this way (X-8). |
| CB-2 | Create validates de-duplicated ids but inserts the raw `drive_ids` (src: `api/src/journey.rs:144`, `:169-173`); replace counts raw ids against stored rows (src: `api/src/journey.rs:202`, `:209-210`). A body with a repeated id gets `409 "some drives already belong to another journey"`. | The error is misleading; the demo mirror de-duplicates (src: `app/src/demo/server.ts:461`, `:477`). The app never sends duplicates, so impact is limited to other clients. Likely. | Duplicate ids are ignored. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (the app never sends duplicate ids). |
| CB-3 | Journey summary costs fall back to `"JPY"` when neither `currency` nor `default_currency` is known (src: `api/src/journey.rs:282`). Charge rows with an unknown currency are `null`, and the app formats them in the user's default currency (src: `api/src/main.rs:150`; `app/src/api.ts:122`). The same journey page can show a charge in USD and the total in ¥. | Looks like a leftover of the pre-v0.10 implicit JPY default (comment: `app/src/i18n.ts:29`). Report and summary endpoints take a `currency` parameter instead (src: `api/src/report.rs:92`, `api/src/summary.rs:261-265`). Likely. | Unknown currency stays `null` (client default) or the endpoint accepts a `currency` parameter. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor. |
| CB-4 | `/speed-bands` has no `tables_ok` check (src: `api/src/phase2.rs:188-193`): with missing journey tables it fails with `500` instead of `503`. For an unknown journey id, `/speed-bands` and `/weather` answer `200` with empty data, while every other journey endpoint answers `404` (src: `api/src/phase2.rs:193`, `:94-98`). | Inconsistent with the rest of the module. Possible; the app only calls these for existing journeys, so the impact is small. | `503` when tables are missing; `404 "journey not found"` for unknown ids. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (X-5). |
| CB-5 | When more than 20 grid cells are uncached, cells beyond 20 are skipped without setting `partial` (src: `api/src/phase2.rs:127`, `:130`). The app shows its "some weather data couldn't be fetched" note only when `partial` is true (src: `app/src/journey.ts:477`). | The user gets missing values with no hint; they fill in on later requests. Possible. | `partial: true` when cells were skipped. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor: long journeys can silently miss weather for some cells. |
| CB-6 | In `fetch_open_meteo`, a transport/JSON error on the forecast request (after a successful archive response) returns an error via `?`, discarding the archive rows already collected for that cell (src: `api/src/phase2.rs:161`, `:163`). | Data that was fetched is thrown away; the cell is retried next time. Possible. | Keep and cache the archive rows; mark `partial`. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor. |
| CB-7 | The dismissal `503` text tells the admin to run `deploy/drivelens-v0.6.1.sql` (src: `api/src/journey.rs:26`), while `setup.sql` says the older files are no longer needed (src: `deploy/setup.sql:18`) and the other journey messages point to `setup.sql`. | Legacy message. Likely. | Point to `deploy/setup.sql`. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Text only (X-4). |

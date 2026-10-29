# app-demo — Demo mode (offline fictional car and in-browser mock API)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15).
> Sources: `app/src/demo.ts`, `app/src/demo/gen.ts`, `app/src/demo/server.ts`, `app/src/demo/routes.json`, `app/src/demo/README.md`, `app/scripts/demo/fetch-routes.py`; demo hooks in `app/src/main.ts`, `app/src/api.ts`, `app/src/auth.ts`, `app/src/devices.ts`, `app/src/notify.ts`, `app/src/setup.ts`, `app/vite.config.ts`.
> In this document, "the system" means Demo Mode: the controller in `app/src/demo.ts`, the generated dataset (`gen.ts` + `routes.json`), the in-browser mock of the DriveLens API (`server.ts`) and the build script for the route data.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

Demo mode lets anyone try every DriveLens screen without a server or TeslaMate. It shows a fictional "Demo Car" with about three months of Tokyo-area data and runs entirely in the browser (doc: README.md:11; doc: CHANGELOG.md v0.13.0, v1.0.0). The app's normal code path is used unchanged: requests go to a reserved demo address, a local mock answers them in the shape of the real API, and the user's real server settings and cached data are not touched (comment: app/src/demo.ts:2-5; comment: app/src/demo/server.ts:2-3).

## 2. Responsibility boundaries

### 2.1 In scope
- Entering and leaving demo mode, including the `?demo` URL parameter, the flag in `localStorage`, and purging demo storage.
- The storage namespace helper `skey()` that keeps per-server UI state for demo and real use apart.
- Intercepting `window.fetch` for the demo address and lazy-loading the mock.
- The deterministic, date-relative dataset (car, places, drives, charges, journeys, bundled costs).
- The mock API: which endpoints it answers, its rules, the version it reports, persisting user edits, and the simulated device auth.
- Demo-specific UI rules the app shows while demo mode is on: banner, Settings card, reduced server section and sign-out wording. The UI is rendered by `app-shell` / `app-connection` code, but the behavior is specified here.
- Building `routes.json` (`app/scripts/demo/fetch-routes.py`) and the rule that demo places are obviously fictional.
- Data attribution for the OpenStreetMap-derived routes.

### 2.2 Out of scope
- The real API semantics that the mock imitates → `api-core`, `api-records`, `api-summary`, `api-insights`, `api-journeys`, `api-auth`.
- Rendering of every screen that shows demo data → `app-home`, `app-records`, `app-journeys`, `app-insights`, `app-shell`.
- The notification settings UI and its simulated mode → `app-notifications` (summarised in 3.10 because demo depends on it).
- Settings storage (`loadSettings` / `saveSettings`), the `api()` request layer, version gating (`FEATURE_LEVEL`) and device-auth client logic → `app-connection`. The demo-specific branches are listed here.
- Map tiles: they still come from the network → `app-ui-kit`.
- The web build's third-party license file, which includes the demo route notice → `app-platforms` (`app/vite.config.ts:148-151`).
- Caching the lazy demo chunk in the service worker → `app-platforms` (`app/vite.config.ts:53`).

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `app-connection`: `FEATURE_LEVEL` (`app/src/version.ts:10`) and `LATEST_SERVER` (`app/src/setup.ts:14`) for the version the mock reports (`app/src/demo.ts:6-7, 26`).
  - Browser: `window.fetch`, `Response`, `DOMException`, `localStorage`, `location`, `history`, `URL`/`URLSearchParams`, `Intl.DateTimeFormat` with IANA time zones (`app/src/demo/server.ts:39-45`).
  - Build time only: `ext:OSRM` (`router.project-osrm.org`, OpenStreetMap data) and `ext:Open-Meteo Elevation API` through `fetch-routes.py`. The output is committed, and no network call is made for demo data at runtime (comment: app/scripts/demo/fetch-routes.py:3-5; doc: app/src/demo/README.md:15).
- **Used by:**
  - `app-connection`: `api.ts` (`loadSettings` returns the demo address; `saveSettings` never persists it; a 401 does not sign out); `auth.ts` (`canWrite`, `signOut`, `whoAmI`, `initDeviceAuth`, `upgradeToDeviceToken`); `devices.ts` (no polling, sign-out wording); `setup.ts` (wizard button `enterDemo`).
  - `app-shell`: `main.ts` (banner, Settings card, server section, `skey` for the selected car and home cache, ignoring the signed-out event).
  - `app-records`: `infinite.ts` list caches through `skey` (`app/src/infinite.ts:45`).
  - `app-insights`: battery overrides through `skey` (`app/src/insights.ts:28, 32, 71`).
  - `app-notifications`: `isDemo` and `skey("drivelens-push-demo")` (`app/src/notify.ts:43-48`).
  - `app-platforms`: license text for `routes.json` (`app/vite.config.ts:148-151`).
- **Provided interface:**

| Export | Module | Purpose |
|---|---|---|
| `isDemo()` | `demo.ts:17` | Demo flag set? |
| `skey(key)` | `demo.ts:22` | Storage key in the demo namespace while demo is on |
| `enterDemo()`, `exitDemo()` | `demo.ts:63, 70` | Enter / leave (each reloads the page) |
| `installDemoFetch()` | `demo.ts:29` | Wraps `window.fetch` (called automatically) |
| `DEMO_URL`, `DEMO_TOKEN`, `DEMO_CAR`, `DEMO_CREDIT` | `demo.ts:9-11, 76` | Constants |
| `configure`, `initDemo`, `handle`, `resetDemoState`, `attribution` | `demo/server.ts` | Mock server (lazy chunk) |
| `generate`, `DEMO_CAR_ID`, `hav`, `climate` | `demo/gen.ts` | Dataset generator |

| Storage / URL | Meaning |
|---|---|
| `localStorage["drivelens-demo"] = "1"` | Demo mode on (`demo.ts:12, 17`) |
| `localStorage["drivelens-demo-state"]` | Persisted demo edits (`demo/server.ts:15`) |
| `localStorage["drivelens-demo~<x>"]` | Namespaced per-server UI state while demo is on (`demo.ts:15, 22`) |
| `localStorage["drivelens-demo-prev-car"]` | v0.13.0 leftover, only purged (`demo.ts:13`) |
| `?demo` | Open straight into demo mode (`demo.ts:78-81`) |
| `https://demo.drivelens.invalid` | Demo API address (`demo.ts:9`) |

Mock endpoints (`app/src/demo/server.ts:424-491`, `508-532`). Every request is accepted; the demo token is never checked.

| Method | Path | Mock behavior |
|---|---|---|
| any | `/health`, `/api/health` | `{status, version, api_level}` |
| GET | `/api/cars` | the one demo car |
| any | `/api/cars/{id}/status` · `last-activity` · `stats` · `months` · `report` · `trends` · `footprint` · `battery` | computed from the dataset; any `id` |
| any | `/api/drives`, `/api/charges` | lists (array, or `{items, next_cursor}` with `paged=true`) |
| any | `/api/drives/{id}`, `/api/drives/{id}/path`, `/api/charges/{id}` | detail |
| PUT, DELETE | `/api/charges/{id}/cost` | manual cost edit |
| any | `/api/addresses/aliases`; PUT, DELETE `/api/addresses/{id}/alias` | place names |
| GET, POST | `/api/journeys` | list / create |
| any | `/api/journeys/suggestions`; POST `…/dismiss`; DELETE `…/dismissed` | suggestions |
| GET, PATCH, DELETE | `/api/journeys/{id}`; PUT `/api/journeys/{id}/drives` | journey CRUD |
| any | `/api/journeys/{id}/path` · `weather` · `speed-bands`; GET, PUT, DELETE `…/cover` | journey extras |
| various | `/api/auth/me`, `/api/auth/devices[...]`, `/api/auth/pairings`, `/api/auth/pair` | simulated device auth (3.9) |
| — | `/api/cars/{id}/summary`, `/api/push/*` | not implemented → 404 (see CB-1) |

## 3. External behavior

### 3.1 Entering and leaving
- **DEMO-001** When the page loads with a `demo` query parameter and demo mode is off, the system SHALL purge demo storage (DEMO-023), set `localStorage["drivelens-demo"] = "1"` and reload at `location.pathname`, which drops every query parameter. (src: app/src/demo.ts:61-67, 78-81; doc: CHANGELOG.md v0.15.1; doc: README.md:11)
- **DEMO-002** When the page loads with `?demo` and demo mode is already on, the system SHALL remove the query string with `history.replaceState`, without a reload. (src: app/src/demo.ts:80)
- **DEMO-003** When the user taps "Try demo" in the setup wizard or "Try demo mode" in Settings › Server, the system SHALL enter demo mode as in DEMO-001. (src: app/src/setup.ts:172-174, 191; app/src/main.ts:368-369, 473-474)
- **DEMO-004** When demo mode is entered, the system SHALL start from fresh demo state; edits from an earlier demo session are discarded. (src: app/src/demo.ts:63-67; comment: app/src/demo.ts:64 "a fresh demo every time")
- **DEMO-005** When the user exits through the banner's Exit button, the Settings card's "Exit demo" button, or "Sign out of this device", the system SHALL remove the flag, purge demo storage and reload at `location.pathname`. (src: app/src/demo.ts:70-74; app/src/main.ts:342, 474; app/src/auth.ts:142)
- **DEMO-006** When demo mode is left, the app SHALL return to the configured real server with its previous selected car and caches, or to the setup wizard when no server is configured. (comment: app/src/demo.ts:68-69; src: app/src/main.ts:320, 956-959; src: app/src/locales/en.ts:203-204)
- **DEMO-007** When `localStorage` cannot be read, `isDemo()` SHALL return `false`. (src: app/src/demo.ts:17)

### 3.2 What the user sees while demo mode is on
- **DEMO-010** When demo mode is on, the app SHALL add the `demo` class to `<body>` and show a status strip as the last row inside the sticky header. The strip shows a dot, "Demo mode", "· fictional data" and an Exit button. (src: app/src/main.ts:334-344; app/src/style.css:58, 102-112; doc: CHANGELOG.md v0.14.2)
- **DEMO-011** When demo mode is on, Settings SHALL show a demo card at the top. The card says that all data is fictional, that edits stay on this device and are discarded on exit, where exiting returns to, and that map tiles still need the internet. It has an "Exit demo" button and shows `DEMO_CREDIT`. (src: app/src/main.ts:315-323, 408; app/src/locales/en.ts:202-205, 208)
- **DEMO-012** When demo mode is on, Settings › Server SHALL show only the app/server version line, without address, token or save controls. "Sign out of this device" SHALL say that it only leaves the demo. (src: app/src/main.ts:351, 475; app/src/devices.ts:204, 209-211; app/src/locales/en.ts:558, 560)
- **DEMO-013** When demo mode is on, every write entry point SHALL be available: the demo device has full scope. (src: app/src/auth.ts:45; comment: app/src/auth.ts:45)

### 3.3 Keeping the real configuration apart
- **DEMO-020** When demo mode is on, `loadSettings()` SHALL return `apiUrl = "https://demo.drivelens.invalid"` and `token = "demo-mode-token-not-a-secret-0000000"`, and the stored real values SHALL stay as they are. (src: app/src/api.ts:17-21; app/src/demo.ts:9-10; comment: app/src/demo.ts:4)
- **DEMO-021** When settings are saved while demo mode is on, the system SHALL write the real `apiUrl`, `token`, `tokenKind`, `deviceId` and `deviceScope` back unchanged. Other preferences, such as theme or currency, are saved normally. (src: app/src/api.ts:22-28; comment: app/src/api.ts:25)
- **DEMO-022** While demo mode is on, `skey("drivelens-<x>")` SHALL return `drivelens-demo~<x>`; when demo mode is off it SHALL return the key unchanged. It covers the selected car, the home snapshot, list caches, battery overrides and the simulated push preferences. (src: app/src/demo.ts:18-22; app/src/main.ts:567-568; app/src/infinite.ts:45; app/src/insights.ts:28, 32, 71; app/src/notify.ts:43; doc: CHANGELOG.md v0.13.1)
- **DEMO-023** When demo storage is purged, the system SHALL remove:
  - every key that starts with `drivelens-demo~`;
  - `drivelens-demo-state` and `drivelens-demo-prev-car`;
  - the v0.13.0 leftovers for car 901 in the shared namespace: `drivelens-home-901`, keys matching `drivelens-list-*:901`, and the `901` entry of `drivelens-battery-baseline`.

  (src: app/src/demo.ts:47-59; comment: app/src/demo.ts:47)
- **DEMO-024** When demo mode is on and a request gets HTTP 401, the system SHALL NOT sign the device out: no `drivelens-signed-out` event is raised, and the handler ignores it in demo. (src: app/src/api.ts:70; app/src/main.ts:875-878)
- **DEMO-025** When demo mode is on and device auth starts up, the system SHALL NOT exchange tokens or write a device identity into the settings. It only calls the mock `/api/auth/me`. (src: app/src/auth.ts:35, 154, 175-179)
- **DEMO-026** When the app clears a server's caches because the user switched servers, demo keys SHALL be left alone. (src: app/src/auth.ts:88-94; comment: app/src/auth.ts:88)

### 3.4 Request interception
- **DEMO-030** When the page loads with demo mode on, the system SHALL wrap `window.fetch` once. A request whose URL starts with `https://demo.drivelens.invalid` SHALL be answered locally, and every other request (for example map tiles) SHALL go to the original `fetch` unchanged. (src: app/src/demo.ts:28-34, 82; comment: app/src/demo.ts:5)
- **DEMO-031** When a demo request is handled, the system SHALL take the method from `init.method`, else `Request.method`, else `GET`. It SHALL parse a string body as JSON; a body that is not a string or not valid JSON becomes `undefined`. (src: app/src/demo.ts:35-37)
- **DEMO-032** When a demo request is handled, the system SHALL wait a random 25–70 ms before answering. (src: app/src/demo.ts:39; comment: app/src/demo.ts:39 "feels like a (fast) network")
- **DEMO-033** When the request's `AbortSignal` is aborted by the time it would be answered, the system SHALL reject with a `DOMException` named `AbortError`. (src: app/src/demo.ts:40)
- **DEMO-034** When the mock returns status 204, the system SHALL answer with an empty body. Otherwise it SHALL answer with the JSON body, the mock status and `content-type: application/json`. (src: app/src/demo.ts:41-43)
- **DEMO-035** When the first demo request is made, the system SHALL dynamically import `./demo/server` (which pulls in `gen.ts` and `routes.json`), configure the reported version and generate the dataset for `Date.now()`. When demo mode is off, that chunk SHALL NOT be downloaded. (src: app/src/demo.ts:24-26; comment: app/src/demo.ts:2-3; doc: app/src/demo/README.md:3-4)
- **DEMO-036** When the mock gets a path, it SHALL strip trailing slashes. An unknown path or method SHALL get `404 {"error":"not found"}`. (src: app/src/demo/server.ts:426, 490)

### 3.5 Reported server
- **DEMO-040** When `/health` or `/api/health` is requested with any method, the mock SHALL return `{"status":"ok","version":"0.14.0","api_level":15}`. The version is `LATEST_SERVER` and the level is the highest value in `FEATURE_LEVEL`, so every feature the app knows is shown. (src: app/src/demo.ts:26; app/src/demo/server.ts:6-9, 117-119, 430; app/src/setup.ts:14; app/src/version.ts:10; comment: app/src/demo/server.ts:6)

### 3.6 Dataset
- **DEMO-050** When the dataset is generated, it SHALL cover 92 Tokyo-local days ending today. Tokyo time is a fixed UTC+9 offset with no DST. (src: app/src/demo/gen.ts:8-9, 64-65; doc: app/src/demo/README.md:7)
- **DEMO-051** When the dataset is generated more than once on the same Tokyo day, it SHALL contain the same drives, charges, ids and values. Each day has its own seeded PRNG (`mulberry`, seeded from the local day number), the start state is fixed (78 % charge, odometer 18,240 km, at home), and `Math.random()` is used only for the response delay. (src: app/src/demo/gen.ts:24, 68, 72, 153-154; app/src/demo.ts:39; doc: app/src/demo/README.md:7)
- **DEMO-052** When the dataset is generated, drives and charges that have not ended by "now" SHALL be left out. (src: app/src/demo/gen.ts:195-196)
- **DEMO-053** When the dataset is generated, it SHALL contain one car:
  - id 901, name "Demo Car", model "3", marketing name `null`, trim `RWD`;
  - VIN `DEMO00000000000001`, efficiency 0.1345 kWh per rated km;
  - software version `<year>.<ISO-ish week − 4, at least 2>.5`, taken from the date 21 days ago.

  (src: app/src/demo/gen.ts:6-7, 209-212; doc: app/src/demo/README.md:6)
- **DEMO-054** When the dataset is generated, it SHALL use the 18 places in `routes.json` as addresses with ids from 9001. The home place SHALL also be geofence 901, `🗼 Demo Home`. (src: app/src/demo/gen.ts:53, 57-62; app/src/demo/routes.json "places")
- **DEMO-055** When demo places are chosen or changed, no place SHALL be on a residence. The home is `東京タワー（デモ）, 港区` on Tokyo Tower's own car park, and the office is `羽田イノベーションシティ, 大田区` (about 14 km away). (doc: app/src/demo/README.md:8; doc: CHANGELOG.md v1.2.2; comment: app/scripts/demo/fetch-routes.py:9-10)
- **DEMO-056** When drives are generated, they SHALL follow the 31 real road legs in `routes.json`. Speeds are scaled for traffic (slower 07–09 and 17–19 local time on roads below 70 km/h), and energy comes from a speed, climb and temperature model. (src: app/src/demo/gen.ts:45-52, 74-120; doc: app/src/demo/README.md:9)
- **DEMO-057** When the timeline is generated, it SHALL follow this schedule, with days counted back from today:

  | Days | Pattern |
  |---|---|
  | Weekdays | Commute in 78 % of cases (16 % of those via Shibuya); otherwise a 40 % chance of a Kichijōji trip |
  | Weekends | 0–2 outings |
  | −5 | Hakone (the bundled journey `箱根日帰り`) |
  | −37 | Fuji Five Lakes (the bundled journey `富士五湖ドライブ`) |
  | −50 | Hakone again, without a journey |
  | −19 | Shōnan |
  | −12 | Bay area |
  | −29, −61 | Supercharger Kōhoku |
  | −73 | Makuhari |

  A bundled journey is created only if its drives fall inside the window. (src: app/src/demo/gen.ts:150-192, 205-208)
- **DEMO-058** When charges are generated, they SHALL follow these rules:
  - **Home, overnight:** the car is at home below 62 % and no Supercharger day is within the next two days. Target 80 %, or 90 % in 15 % of cases. TeslaMate cost = `round(energy used × 31)` JPY.
  - **AC charging at Futako-Tamagawa:** cost 0.
  - **Supercharger sessions:** a bundled manual cost of `round(energy added × 66)` JPY. The first one has the note "Tesla app receipt".
  - **Fujiyoshida quick charger:** `round(max(1, minutes/30) × 1350)` JPY, with the note `30分 1,350円`.

  (src: app/src/demo/gen.ts:122-148, 160, 197-204; doc: app/src/demo/README.md:17-19)
- **DEMO-059** When the dataset is generated, the rated range at 100 % SHALL fall linearly from 440.6 km by 4.2 km over the 92 days, giving a gentle battery fade. (src: app/src/demo/gen.ts:69)
- **DEMO-060** When temperatures or weather are produced, they SHALL come from a synthetic Tokyo climatology with an elevation lapse rate. About 27 % of days are rainy, and no weather service is contacted. (src: app/src/demo/gen.ts:37-42, 72, 78, 117; app/src/demo/server.ts:400-405; doc: app/src/demo/README.md:15)

### 3.7 Mock API behavior
- **DEMO-070** When `/api/cars/{id}/…` (status, last-activity, stats, months, report, trends, footprint, battery) is requested with any numeric `id`, the mock SHALL answer for the demo car. Lists ignore `car_id`. (src: app/src/demo/server.ts:432-437, 440; comment: app/src/demo/server.ts:433)
- **DEMO-071** When `/api/drives` or `/api/charges` is requested, the mock SHALL:
  - sort rows newest first by (start, id);
  - apply `limit` (default 50, clamped to 1–500) and `offset` (≥ 0);
  - honour `before` as `<ISO time>~<id>` or as a bare date;
  - with `paged=true`, return `{items, next_cursor}`, where `next_cursor` is `<start_date>~<id>` of the last row when the page is full and `null` otherwise;
  - without it, return a plain array;
  - for `/api/drives` only, when `q` is non-empty after trim (max 100 chars), filter to drives whose start or end display name contains the query case-insensitively before paging (issue #18).

  (src: app/src/demo/server.ts `list` / `/api/drives`)
- **DEMO-072** When `tz` is given to stats, months, report, trends or footprint and is not a valid IANA zone, the mock SHALL return `400 {"error":"unknown tz"}`. Without `tz` it SHALL use UTC. (src: app/src/demo/server.ts:45, 151, 173, 208, 242, 258)
- **DEMO-073** When `month` is given to report, trends or footprint and does not match `YYYY-MM`, the mock SHALL return `400 "month must be YYYY-MM"`. A report for a future month SHALL get `400 "month is in the future"`. (src: app/src/demo/server.ts:209, 212, 243, 259)
- **DEMO-074** When `currency` is not three letters, the mock SHALL use `JPY` as the default currency. (src: app/src/demo/server.ts:57)
- **DEMO-075** When a charge's effective cost is computed, the mock SHALL use the first that applies: a cost edited in the demo (a deleted cost counts as "no manual cost"), then the bundled manual cost (`cost_source: "manual"`), then the TeslaMate cost in JPY (`"teslamate"`). `default_currency` is always `JPY`. (src: app/src/demo/server.ts:76-89, 448)
- **DEMO-076** When a charge detail is requested, each point's `power_kw` SHALL equal the reported `charger_power`, with `power_source: "reported"`. (src: app/src/demo/server.ts:90-94)
- **DEMO-077** When a cost is written, the mock SHALL require a finite amount with `0 ≤ amount < 1e9` (else 400 `amount must be 0..1e9`) and a three-letter currency (else 400). It SHALL round the amount to 2 decimals, trim the note, and return the updated charge. An unknown charge SHALL get 404 `charge not found`. (src: app/src/demo/server.ts:442-449)
- **DEMO-078** When a place alias is written, the mock SHALL accept 1–200 characters after trimming (else 400) for a known address (else 404 `address not found`). Removing an alias that does not exist SHALL return 404 `no alias`, and a successful removal returns 204. (src: app/src/demo/server.ts:357, 450-456)
- **DEMO-079** When journeys are created or changed, the mock SHALL apply these rules:
  - **Names:** 1–200 characters after trimming (else 400).
  - **`drive_ids`:** must contain 1–500 entries (else 400).
  - **Unknown drives:** 404 `some drives were not found`.
  - **Drives already in another journey:** `409 {"error": "some drives already belong to another journey", "drive_ids": [...]}`.
  - **Responses:** create, patch and set-drives return the journey detail; delete returns 204.
  - **Ids:** new journeys get ids from 100.

  (src: app/src/demo/server.ts:19, 357-365, 457-478)
- **DEMO-080** When a cover is written, the mock SHALL accept only JPEG, PNG or WebP data URLs (else 400) of at most 1,500,000 characters (else 413 `image too large (max ~1 MB)`), and SHALL answer 204. (src: app/src/demo/server.ts:482-488)
- **DEMO-081** When suggestions are requested, the mock SHALL:
  - consider the newest 400 drives;
  - group neighbours that are less than `gap_min` minutes apart (default 60, clamped to 1–1440), or less than `charge_gap_min` minutes apart (default 120) when a charge started between them;
  - keep each group within 3 days;
  - skip drives that are in a journey or were dismissed;
  - return at most `limit` groups (default 10, clamped to 1–50), newest first;
  - name each group `start → farthest end`, with `（往返）` added for round trips.

  (src: app/src/demo/server.ts:366-389)
- **DEMO-082** When a journey path is requested, the mock SHALL keep at most about 3,000 points by keeping every `ceil(total/3000)`-th point plus the first and last point of each drive, and SHALL report the cumulative `km`. (src: app/src/demo/server.ts:390-399)
- **DEMO-083** When a footprint is requested, the mock SHALL thin points with a minimum spacing that starts at 25 m and doubles up to 1,600 m until 8,000 points or fewer remain, then decimate if still above 8,000. (src: app/src/demo/server.ts:257-277)
- **DEMO-084** When speed bands are requested, the mock SHALL split distance, energy and time into `city` (<40 km/h), `suburb` (40–80) and `highway` (>80), with `method: "power"` when more than half of the distance has measured power and `"distance"` otherwise. A missing or empty journey gets `{bands: [], method: "none"}`. (src: app/src/demo/server.ts:406-421)
- **DEMO-085** When journey weather is requested, the mock SHALL return synthetic `temp_c` and `precip_mm` per drive. `source` is `"forecast"` for drives within the last 4 days and `"archive"` otherwise, with the attribution `Demo data (synthetic weather, no Open-Meteo request)`. (src: app/src/demo/server.ts:400-405)

### 3.8 Persisting edits
- **DEMO-090** When a write succeeds, the mock SHALL save the demo state to `localStorage["drivelens-demo-state"]`. The state holds aliases, costs, journeys (with covers), the next journey id, dismissed drives and the Tokyo day. (src: app/src/demo/server.ts:13-15, 21, 31; doc: app/src/demo/README.md:16)
- **DEMO-091** When saving fails (for example storage quota), the mock SHALL retry without cover images. If that fails too, it SHALL keep the state in memory only. (src: app/src/demo/server.ts:21)
- **DEMO-092** When the mock starts and the saved state is missing, unreadable or from another Tokyo day, it SHALL start from fresh state: the bundled journeys and no edits. On a new day the timeline is regenerated, so earlier edits would point at shifted drives. (src: app/src/demo/server.ts:22-29; comment: app/src/demo/server.ts:26; doc: app/src/demo/README.md:16)

### 3.9 Simulated device auth
- **DEMO-100** When `/api/auth/me` is requested, the mock SHALL return `{kind: "device", device: <the current demo device>, device_auth: true, owner_key_mode: "full"}`. (src: app/src/demo/server.ts:512)
- **DEMO-101** When the device list is requested, the mock SHALL return three fictional devices, sorted by `created_at`, newest first:
  - "Demo phone" — current, full;
  - "Mac · Safari" — full, created by pairing;
  - "iPad · Safari" — read-only, expires in 21 days.

  Their addresses are documentation IPs (`192.0.2.x`, `198.51.100.x`). (src: app/src/demo/server.ts:498-506, 513)
- **DEMO-102** When a device is renamed or revoked, or "all other devices" are revoked (`?except=current`), the mock SHALL change only its in-memory list. A page reload brings the three devices back. Names must be 1–60 characters after control characters are removed (else 400 `invalid_name`), and an unknown device gets 404 `not_found`. (src: app/src/demo/server.ts:493, 507, 515-524; comment: app/src/demo/server.ts:493)
- **DEMO-103** When `POST /api/auth/devices` is requested, the mock SHALL return 403 `owner_key_required`. (src: app/src/demo/server.ts:514)
- **DEMO-104** When `POST /api/auth/pairings` is requested with scope `full`, `read` or none, the mock SHALL return `201 {code: "7KQ2-M9XD", expires_at: now + 10 min}`. Any other scope SHALL get 400 `invalid_scope`. (src: app/src/demo/server.ts:525-529)
- **DEMO-105** When `POST /api/auth/pair` is requested, the mock SHALL always return 400 `invalid_code`. (src: app/src/demo/server.ts:530)
- **DEMO-106** When the Devices section is shown in demo mode, it SHALL NOT poll the server, and nothing is sent over the network. (src: app/src/devices.ts:118; doc: CHANGELOG.md v1.2.0)

### 3.10 Simulated notifications (owned by `app-notifications`)
- **DEMO-110** When notifications are turned on, off or per type in demo mode, the system SHALL neither ask for browser permission nor call `/api/push/*`. The preferences are stored under `skey("drivelens-push-demo")`. (src: app/src/notify.ts:43-48, 69, 85, 91; comment: app/src/notify.ts:4)
- **DEMO-111** When "send test" is used in demo mode, the app SHALL show an in-page preview banner with a fixed sample trip text, which closes after 6 s. Tapping it SHALL open the newest demo drive. (src: app/src/notify.ts:95-113; app/src/locales/en.ts:482-484)

### 3.11 Attribution
- **DEMO-120** When demo mode is on, Settings SHALL show `Demo routes © OpenStreetMap contributors (ODbL), routed with OSRM · elevation © Copernicus DEM via Open-Meteo (CC BY 4.0) · weather is synthetic`. (src: app/src/demo.ts:75-76; app/src/main.ts:322; comment: app/src/demo.ts:75 "ODbL requires attribution")
- **DEMO-121** When the web app is built, the third-party license file SHALL include the ODbL notice for the demo routes and the CC BY 4.0 notice for elevation. (src: app/vite.config.ts:148-151; doc: README.md:89)

### 3.12 Building the route data (`fetch-routes.py`)
- **DEMO-130** When `fetch-routes.py` runs without arguments, it SHALL build `routes.json` for the 31 legs in `PAIRS` and write it in `PAIRS` order with `attribution`, `places` and `routes` (`poly`, `spd`, `ele`, `km`, `min`). For each leg it SHALL:
  1. request a route from `router.project-osrm.org` (polyline6, distance and duration annotations);
  2. simplify the geometry with Douglas–Peucker at 6 m;
  3. compute a speed per kept segment, clamped to 5–120 km/h;
  4. sample elevation about every 400 m from the Open-Meteo elevation API, in batches of up to 100, and interpolate it per vertex;
  5. encode the geometry as polyline5.

  (src: app/scripts/demo/fetch-routes.py:28-30, 83-128; doc: app/src/demo/README.md:9-14)
- **DEMO-131** When leg names are passed as arguments, the script SHALL re-fetch only those legs, keep the others from the committed file, and stop with `unknown pair(s): …` for names that are not in `PAIRS`. (src: app/scripts/demo/fetch-routes.py:86-91; doc: app/src/demo/README.md:10)
- **DEMO-132** When a request fails, the script SHALL retry up to 5 times, waiting 2, 4, 6… s, and then stop with `failed <url>`. It sends `User-Agent: DriveLens-demo-builder` and pauses 0.4 s between elevation batches and 1.1 s between legs. (src: app/scripts/demo/fetch-routes.py:32-39, 113, 124)

## 4. Key design decisions
- **D-1 Mock at the `fetch` layer.** The demo uses its own API address, so `api()`, the version check and every screen run their normal code. (comment: app/src/demo.ts:2-5; comment: app/src/demo/server.ts:2-3) Confirmed: The `.invalid` top-level domain was chosen because it is reserved (RFC 2606 / RFC 6761) and never resolves, so a request that bypassed the wrapper could not reach anyone.
- **D-2 Lazy-loaded chunk.** The main bundle carries only the small controller. The mock, the generator and `routes.json` (about 77 KB raw / 32 KB gzip) load on the first demo request. (comment: app/src/demo.ts:2-3; doc: app/src/demo/README.md:4)
- **D-3 Deterministic and date-relative, not a static snapshot.** The timeline always ends "now" and is the same within a Tokyo day. Ids are derived from the day number and sequence (`(day mod 100000) × 10 + seq`). (src: app/src/demo/gen.ts:84, 124; doc: app/src/demo/README.md:7) Confirmed (current scope). Rationale: the data always looks current, and edits stay valid within the day.
- **D-4 Real road geometry, prepared offline.** Routes come from OSRM/OSM and elevation from Copernicus DEM, through a script whose output is committed. Runtime makes no network calls for demo data. (comment: app/scripts/demo/fetch-routes.py:3-5; doc: app/src/demo/README.md:9-15)
- **D-5 A separate storage namespace.** Demo state never mixes with a real server's cached data, in either direction. (comment: app/src/demo.ts:18-21; doc: CHANGELOG.md v0.13.1)
- **D-6 Edits are throw-away.** Demo edits are discarded on enter, on exit and on a new Tokyo day. (comment: app/src/demo.ts:64, 68; doc: app/src/demo/README.md:16; src: app/src/locales/en.ts:202)
- **D-7 Demo reports the newest server level.** All features are visible in demo. (comment: app/src/demo/server.ts:6)
- **D-8 One car; any car id maps to it.** A car id remembered from a real server still works. (comment: app/src/demo/server.ts:433)
- **D-9 Obviously fictional places.** The home moved from a residential street to Tokyo Tower in v1.2.2, so it cannot be mistaken for someone's real house. (doc: CHANGELOG.md v1.2.2; doc: app/src/demo/README.md:8)
- **D-10 Device auth simulated in memory.** The demo device is "full", and no pairing ever succeeds. (comment: app/src/auth.ts:45; comment: app/src/demo/server.ts:493; src: app/src/demo/server.ts:530)

## 5. Constraints
- The flag and edits live in `localStorage`. Without it demo mode cannot be turned on, and edits are not kept. (src: app/src/demo.ts:17; app/src/demo/server.ts:21)
- Map tiles need an internet connection even in demo mode. (src: app/src/locales/en.ts:208)
- The OSM-derived routes require ODbL attribution wherever demo data is shown or shipped. (comment: app/src/demo.ts:75; doc: README.md:89)
- Fixed demo identifiers: car 901, geofence 901, addresses 9001–9018, journeys 1–2 bundled and 100+ for new ones; charge sequence numbers start at 5 within a day. (src: app/src/demo/gen.ts:6, 57-62, 84, 124, 160; app/src/demo/server.ts:19)
- `routes.json` is about 45.8 KB, with 18 places and 31 legs. (src: app/src/demo/routes.json)
- Time-zone handling in the mock relies on `Intl.DateTimeFormat` support for IANA zones. (src: app/src/demo/server.ts:39-51)
- Cover images are kept in `localStorage`, which has a per-origin quota. When the quota is hit, covers are dropped from the saved state. (src: app/src/demo/server.ts:21) Confirmed: browsers allow about 5 MiB of `localStorage` per origin (Chrome, Firefox, Safari), and the fallback save drops covers first.
- Contributors test UI changes in demo mode as well. (doc: CONTRIBUTING.md:88)

## 6. Non-goals
- Sending notifications or contacting push services. (comment: app/src/notify.ts:4; src: app/src/locales/en.ts:482)
- Calling Open-Meteo or any other external service at runtime. (doc: app/src/demo/README.md:15; src: app/src/demo/server.ts:404)
- Successful pairing, read-only demo devices for the current user, or token exchange. (src: app/src/demo/server.ts:512-530; app/src/auth.ts:45)
- Keeping demo edits across demo sessions, devices or days. (doc: app/src/demo/README.md:16)
- A multi-car demo. (src: app/src/demo/gen.ts:6; app/src/demo/server.ts:120) Confirmed (current scope): one fictional car is enough to show every feature.
- Serving as a test fixture or reference implementation for drivelens-api. Confirmed (current scope): the server's fixtures are in `testdata/`.

## 7. Current behavior vs. intended behavior
| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | The header comment says the mock "answers every DriveLens API endpoint" (comment: app/src/demo/server.ts:2). `GET /api/cars/{id}/summary` and the five `/api/push/*` endpoints return 404 (src: app/src/demo/server.ts:424-491; compare api/src/main.rs:878, 903-907). The app does not call them in demo mode: the push UI branches on `isDemo()` (app/src/notify.ts:48-96), and no app code calls `/summary`. | The comment and the code disagree. There is no user impact today. | Reword the comment to "every endpoint the app uses in demo mode". **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Comment only. |
| CB-2 | Validation and error responses drift from the Rust API, although the comment says the mock mirrors its "rules" (comment: app/src/demo/server.ts:2-3):<br>(a) journey notes have no 2,000-character limit (Rust api/src/journey.rs:136-140);<br>(b) cost notes have no 500-character limit (api/src/main.rs:533-534);<br>(c) dismiss accepts more than 1,000 ids (api/src/journey.rs:419);<br>(d) `PATCH /api/journeys/{id}` with `"name": null` returns 400, while Rust leaves the name unchanged (api/src/journey.rs:127, 180-181);<br>(e) `DELETE /api/addresses/{id}/alias` for an unknown address returns 404 `address not found`, while Rust returns 404 `no alias` (api/src/main.rs:506-508);<br>(f) `/api/health` returns the short public shape without `database` and the feature flags (api/src/main.rs:353-362);<br>(g) the 1–500 drive count is checked before de-duplication, while Rust de-duplicates first (api/src/journey.rs:144-145).<br>(src: app/src/demo/server.ts:358-361, 430, 451-456, 465-466, 472) | Likely unintended drift. Low impact, because the app's own inputs stay within the limits. | Match the Rust limits and messages, or document the differences. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Low impact (the app's own inputs stay within the limits). |
| CB-3 | The v0.13.0 leftover cleanup runs on every enter and exit. It deletes shared-namespace keys for car id 901 (`drivelens-home-901`, `drivelens-list-*:901`) and the `901` entry of `drivelens-battery-baseline` (src: app/src/demo.ts:47-58). | If a real TeslaMate car has id 901, its caches and battery baseline override would be removed. Possible; the impact is small (caches rebuild, the override is lost). | Limit the cleanup to a one-time migration, or skip it when a real server uses car 901. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor (only a real car with id 901). |
| CB-4 | `resetDemoState()` and `attribution()` in `server.ts` are exported but not used anywhere (src: app/src/demo/server.ts:10, 32). `DEMO_CREDIT` repeats the attribution of `routes.json` in different words (src: app/src/demo.ts:76; app/src/demo/routes.json "attribution"). | Dead exports and two copies of the credit text. Certain; no user impact. | Remove the unused exports, or show `attribution()` instead of the hard-coded copy. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Cosmetic (dead code). |
| CB-5 | `fetch-routes.py` reads and writes `routes.json` without `encoding="utf-8"` while writing non-ASCII text (`ensure_ascii=False`) (src: app/scripts/demo/fetch-routes.py:89, 127). | On a system whose default encoding is not UTF-8 (for example Windows with code page 932/1252), the script may fail or write a mis-encoded file. Possible; affects only maintainers. | Open the file with explicit UTF-8. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor, maintainers on non-UTF-8 systems only. |

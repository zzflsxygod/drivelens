# app-notifications — Notification settings and push handling (client side)

> Reverse-engineered from `main` @ 9b1c39c (app v1.2.2, drivelens-api 0.14.0, API level 15); updated for changes through `main` @ 9bd5dd2 (app v1.3.1, drivelens-api 0.15.0, API level 16).
> `src:` line numbers refer to 9b1c39c. Code added or rewritten after 9b1c39c is cited as `path` plus a symbol name. "At this commit" means 9bd5dd2.
> Sources: `app/src/notify.ts`; the `push` and `notificationclick` handlers in the generated service worker (`swSource` in `app/vite.config.ts`); the notification glue in `app/src/main.ts` (`mountNotifications`, `initNotificationClicks`, `openView`, `from=push`); `disable()` callers in `app/src/auth.ts`; `nt.*` strings in `app/src/locales/en.ts`; `docs/install.md` §7; `SECURITY.md`.
> In this document, "the system" means the web app's notification component: the Settings › Notifications card, the browser push subscription it manages, and the service-worker code that shows pushes and routes taps.
> Reviewed against `main` @ 9b1c39c on 2026-10-26: every former `TO CONFIRM` mark is resolved as *Confirmed from code*, *Confirmed (owner decision)*, *Confirmed (current scope / design)* or **[OWNER DECISION NEEDED]**, and every CB row in section 7 ends with a **Review** verdict (see OVERVIEW §1).

## 1. Goal

The user can turn on push notifications for the current device and choose which kinds to receive: a trip summary and a monthly report reminder. Tapping a notification opens the matching screen. The server (`api-push`) detects events and sends the pushes. This module only manages the browser's push subscription and the per-type switches, shows incoming pushes, and routes taps (comment: app/src/notify.ts:2-4; doc: docs/install.md "7. Notifications"). In demo mode the same UI is simulated entirely in the page (comment: app/src/notify.ts:4).

## 2. Responsibility boundaries

### 2.1 In scope
- Detecting whether notifications can work on this device, and showing the matching state or hint.
- Turning on: the permission prompt, fetching the server's VAPID key, creating or replacing the `PushSubscription`, and registering it with the server.
- Turning off, the per-type switches (`trip_summary`, `monthly_report`) and the test notification.
- Keeping the server's copy of the device time zone and UI language up to date.
- Simulating all of the above in demo mode, including an in-page preview of a notification.
- The service worker's `push` handler (shows the notification) and `notificationclick` handler (focuses or opens the app).
- Passing tapped notification targets to the app's view router.

### 2.2 Out of scope
- Detecting finished drives, choosing message texts, encryption and delivery → `api-push`.
- Registering the service worker, app-shell caching and the update toast → `app-platforms`.
- The full deep-link table (`openView`), tabs and the Settings layout where the card sits → `app-shell`.
- The `api()` request layer, error-to-message mapping, server API-level detection (`lacks`, `serverReady`) and sign-out → `app-connection`.
- The demo storage namespace (`skey`) and the demo API server → `app-demo`.
- Translated strings → `app-i18n`. Icons and switch styling → `app-ui-kit`.

### 2.3 Interfaces and dependencies
- **Depends on:**
  - `api-push`: `GET /api/push/key`, `POST /api/push/subscription`, `POST /api/push/subscription/status`, `POST /api/push/unsubscribe`, `POST /api/push/test`, and the push payload `{title, body, tag, url, kind}`.
  - `app-connection`: `api()` (adds the bearer token and sets `status` on errors) (src: app/src/api.ts:53-94); `lacks("push")`, `featureText`, `serverReady` and `onServerInfo` (src: app/src/version.ts:10, 19, 25, 52, 56).
  - `app-demo`: `isDemo()` and `skey()` (src: app/src/demo.ts:17, 22).
  - `app-platforms`: `isTauri()` (src: app/src/platform.ts:13); `isIOS()` and `isStandalone()` (src: app/src/pwa.ts:13, 15); the registered service worker (src: app/src/pwa.ts:47-64).
  - `app-i18n`: `t()` and `currentLang()`. `app-ui-kit`: `ic()`.
  - ext:browser APIs: `Notification`, `PushManager`, `ServiceWorkerContainer`, `Intl.DateTimeFormat`, `localStorage` (demo only).
- **Used by:**
  - `app-shell`: `mountNotifications(slot)` in Settings and `initNotificationClicks(open)` at startup (src: app/src/main.ts:431, 439, 952).
  - `app-connection`: `disable()` during sign-out and when the device is disconnected (src: app/src/auth.ts:7, 138, 145).
- **Provided interface:**
  - `mountNotifications(slot: HTMLElement)`, `initNotificationClicks(open: (view: string) => void)`, `disable(): Promise<State>` (src: app/src/notify.ts:84, 126, 186).
  - Window event `drivelens-open` with `detail: {view}`, and service-worker message `{type: "drivelens-open", view}` (src: app/src/notify.ts:112, 186-193; app/vite.config.ts:110).
  - Demo storage key `drivelens-push-demo`, namespaced by `skey` (src: app/src/notify.ts:43).

## 3. External behavior

### 3.1 Detecting the state
- **NOTIF-001** When the Settings screen is shown, the system SHALL render a "Notifications" section in loading state and then replace it with the detected state. (src: app/src/notify.ts:126-133, 180-181; app/src/main.ts:431, 439)
- **NOTIF-002** When demo mode is active, the system SHALL derive the state only from the stored demo preferences ("on" when `subscribed` is true, otherwise "off"). It SHALL use no browser permission, push or server call for this. (src: app/src/notify.ts:43-48)
- **NOTIF-003** When the app runs inside the Tauri shell, the system SHALL show the hint "Push notifications are available in the web app (PWA)." and no switches. (src: app/src/notify.ts:49, 134; app/src/locales/en.ts:486)
- **NOTIF-004** When the server's API level is known to be below 13, the system SHALL show the "server too old" text for the `push` feature and the hint "Notifications need a newer drivelens-api on your server." Detection SHALL wait for the running server check to finish first. (src: app/src/notify.ts:50-51, 135; app/src/version.ts:10, 52, 56; app/src/locales/en.ts:487)
- **NOTIF-005** When the page is not a secure context, the system SHALL show "Notifications need the web app to be opened over https." (src: app/src/notify.ts:52, 137; app/src/locales/en.ts:489; doc: docs/install.md "Appendix: LAN-only use")
- **NOTIF-006** When the browser lacks `serviceWorker`, `PushManager` or `Notification`, the system SHALL show a hint that depends on the device:
  - iPhone / iPad not opened from the Home Screen: the "Add to Home Screen first" instructions (`nt.ios`);
  - iPhone / iPad opened from the Home Screen: the iOS 16.4+ requirement (`nt.iosOld`);
  - any other device: "This browser doesn't support web push" (`nt.unsupported`).

  (src: app/src/notify.ts:20, 53, 138-139; app/src/locales/en.ts:490-492; doc: docs/install.md "7. Notifications")
- **NOTIF-007** When `Notification.permission` is `denied`, the system SHALL show that notifications are blocked and how to allow them in the site settings. (src: app/src/notify.ts:54, 140; app/src/locales/en.ts:493-494)
- **NOTIF-008** When no browser push subscription exists, or the service worker is not ready within 4 seconds, the system SHALL show the "off" state. (src: app/src/notify.ts:30-34, 55-56)
- **NOTIF-009** When a browser push subscription exists, the system SHALL send `POST /api/push/subscription/status` with its endpoint. It SHALL show "on" with the server's preferences when the server reports `subscribed: true` and the permission is `granted`, and "off" otherwise. (src: app/src/notify.ts:57-63)
- **NOTIF-010** When a server call during detection fails with HTTP 503, the system SHALL show the "notifications aren't enabled on the server" hint. For any other failure it SHALL show the error message and a Retry button that runs detection again. (src: app/src/notify.ts:40, 64, 136, 141, 177-178)
- **NOTIF-011** When the state is "on" and the server's stored `tz` or `locale` differs from the device's IANA time zone or the current UI language, the system SHALL re-send `POST /api/push/subscription` in the background without the toggle fields, ignoring errors. (src: app/src/notify.ts:19, 35-39, 61-62; comment: app/src/notify.ts:61)
- **NOTIF-012** When the server information changes while the card is shown, the system SHALL run detection again, unless an action is in progress or the state is "on" or "loading". (src: app/src/notify.ts:182)

### 3.2 Turning notifications on
- **NOTIF-020** When the user switches the master switch on, the system SHALL call `Notification.requestPermission()` as the first awaited step of that click handler. (src: app/src/notify.ts:67-70, 163-166; comment: app/src/notify.ts:67, 165)
- **NOTIF-021** When the permission result is `denied`, the system SHALL show the blocked state. When the user dismisses the prompt without granting, it SHALL show "off". (src: app/src/notify.ts:71-72)
- **NOTIF-022** When permission is granted, the system SHALL fetch `GET /api/push/key`. A 503 SHALL lead to the "not enabled on the server" hint, and any other failure to the error state. (src: app/src/notify.ts:73-75)
- **NOTIF-023** When the service worker does not become ready within 10 seconds, the system SHALL show the error "The service worker isn't ready yet. Reload the page and try again." (src: app/src/notify.ts:26-29, 76; app/src/locales/en.ts:495)
- **NOTIF-024** When the browser already has a push subscription whose `applicationServerKey` differs from the server's public key, the system SHALL unsubscribe it and create a new one. (src: app/src/notify.ts:77-80; comment: app/src/notify.ts:78)
- **NOTIF-025** When it creates a subscription, the system SHALL use `userVisibleOnly: true` and the server's public key as `applicationServerKey`. (src: app/src/notify.ts:22-25, 80)
- **NOTIF-026** When the subscription is ready, the system SHALL send `POST /api/push/subscription` and then show "on" with the returned preferences. The body contains:
  - `endpoint` and `keys.p256dh` / `keys.auth`;
  - `tz`: the device's IANA zone, or `UTC`;
  - `locale`: the current UI language;
  - `user_agent`: the first 300 characters of `navigator.userAgent`;
  - `trip_summary: true` and `monthly_report: true`.

  (src: app/src/notify.ts:19, 35-39, 81-82)
- **NOTIF-027** When it sends any subscription request, the system SHALL not include `car_ids`, so the server notifies about all cars. (src: app/src/notify.ts:35-39)

### 3.3 Turning notifications off
- **NOTIF-030** When the user switches the master switch off, or `disable()` is called, the system SHALL do the following when a browser subscription exists:
  1. send `POST /api/push/unsubscribe` with its endpoint, ignoring errors;
  2. unsubscribe it in the browser, ignoring errors;
  3. show "off".

  (src: app/src/notify.ts:84-89, 166)
- **NOTIF-031** When no browser subscription exists at that moment, the system SHALL show "off" without calling the server. (src: app/src/notify.ts:86-88)
- **NOTIF-032** When the user signs out with a device token, the system SHALL run `disable()` before the device is revoked. When the server connection is forgotten, it SHALL run `disable()` again but wait at most 1.5 seconds for it. (src: app/src/auth.ts:129-139, 141-148; comment: app/src/auth.ts:137, 145; doc: CHANGELOG.md v1.2.0)

### 3.4 Per-type switches
- **NOTIF-040** When notifications are on and the user flips "Trip summary" or "Monthly report", the system SHALL send `POST /api/push/subscription` with the subscription body and only that one field. It SHALL then show the returned preferences. (src: app/src/notify.ts:90-94, 168-173)
- **NOTIF-041** When the browser subscription has disappeared at that moment, the system SHALL show "This device's push subscription is gone. Turn notifications off and on again." (src: app/src/notify.ts:92; app/src/locales/en.ts:496)
- **NOTIF-042** When notifications are off, the system SHALL disable the per-type switches and the test button and make their panel inert. (src: app/src/notify.ts:143-148)
- **NOTIF-043** When any action is running, the system SHALL mark the card busy, disable its controls and ignore further actions until the running one finishes. (src: app/src/notify.ts:127, 143-147, 155-160)

### 3.5 Test notification
- **NOTIF-050** When the user presses "Send a test notification", the system SHALL send `POST /api/push/test` with the subscription endpoint. On success it SHALL show "Sent — it should arrive in a few seconds". On failure it SHALL show the error message inline. (src: app/src/notify.ts:95-99, 155-158, 176; app/src/locales/en.ts:479-480)

### 3.6 Demo mode
- **NOTIF-060** When the user turns notifications on in demo mode, the system SHALL store `{subscribed: true, trip_summary: true, monthly_report: true}` under the demo-namespaced key derived from `drivelens-push-demo`. It SHALL not request permission or contact any push service. (src: app/src/notify.ts:43-45, 69; app/src/demo.ts:22; comment: app/src/notify.ts:4)
- **NOTIF-061** When the user turns notifications off or flips a switch in demo mode, the system SHALL update only the stored demo preferences. (src: app/src/notify.ts:85, 91)
- **NOTIF-062** When the user sends a test in demo mode, the system SHALL show an in-page banner styled like a notification, with the texts "Trip finished · 23.4 km" and a sample route. The banner SHALL close after 6 seconds. Tapping it SHALL close it and open the newest demo drive. (src: app/src/notify.ts:96, 101-113; app/src/locales/en.ts:483-484)
- **NOTIF-063** When the card is shown in demo mode, its footnote SHALL say that nothing is actually sent. Outside demo mode, it SHALL explain that the user's own server sends the notifications through the browser's push service, end-to-end encrypted. (src: app/src/notify.ts:149; app/src/locales/en.ts:481-482)

### 3.7 Showing a push (service worker)
- **NOTIF-070** When the service worker receives a push whose data is JSON, it SHALL show a notification with these fields:
  - `title`: the payload `title`, or `DriveLens`;
  - `body`: the payload `body`, or empty;
  - `tag`: the payload `tag`, if any;
  - icon `/icons/icon-192.png` and badge `/icons/badge-96.png`;
  - `data.url`: the payload `url` if it is a string, else `/`;
  - the current time as timestamp.

  (src: app/vite.config.ts:93-99)
- **NOTIF-071** When the push data is not valid JSON, the service worker SHALL show the raw text as the body under the title `DriveLens`. (src: app/vite.config.ts:94-96)

### 3.8 Tapping a notification
- **NOTIF-080** When a notification is tapped, the service worker SHALL close it and resolve `data.url` against its own origin. When the result is on another origin, it SHALL do nothing further. (src: app/vite.config.ts:100-103)
- **NOTIF-081** When a window of the app's origin is open, the service worker SHALL focus it and post `{type: "drivelens-open", view}` to it, where `view` is the URL's `view` parameter, without reloading. (src: app/vite.config.ts:104-111; comment: app/vite.config.ts:108)
- **NOTIF-082** When no app window is open, the service worker SHALL open a new window at the URL's path and query, with `from=push` added. (src: app/vite.config.ts:113-114)
- **NOTIF-083** When the page receives a `drivelens-open` message from the service worker, or a `drivelens-open` window event, whose `view` is a string, the app SHALL close open menus, remove an open `.modal` and open that view. This happens only when a server URL is configured and the setup screen is not shown. (src: app/src/notify.ts:186-193; app/src/main.ts:952)
- **NOTIF-084** When the app starts with `from=push` in the address and a service worker already controls the page, the app SHALL replace the address with the bare path, so a later reload does not open the target again. (src: app/src/main.ts:953-954; comment: app/src/main.ts:953)
- **NOTIF-085** When a view sent by the server is opened, the app SHALL handle it as follows. The full table of deep links belongs to `app-shell`.
  - `drive:<id>`: show that drive's detail page with the Drives tab marked.
  - `report:<YYYY-MM>`: show that month's report; a malformed month falls back to the current month.
  - `settings`: show the Settings tab.

  (src: app/src/main.ts:937-951; api/src/push.rs:203, 215, 223)

## 4. Key design decisions

- **D-1 The server does the work.** The client only manages the subscription and the switches. Detection and sending happen on the user's own server (comment: app/src/notify.ts:2-4; doc: docs/install.md "7. Notifications").
- **D-2 The permission is requested inside the user's gesture.** Safari only shows the permission prompt for a direct user gesture, so `requestPermission` is the first await in the click handler (comment: app/src/notify.ts:67, 165).
- **D-3 Re-subscribe when the server key differs.** A browser subscription made for another server (another VAPID key) cannot be reused (comment: app/src/notify.ts:78). This also covers a server whose stored key was lost (doc: docs/install.md "7. Notifications").
- **D-4 The server's copy of time zone and language is refreshed.** When the user travels or switches language, the next Settings visit updates the subscription (comment: app/src/notify.ts:61). The time zone decides when "the 1st, 09:00" is (doc: docs/install.md "7. Notifications").
- **D-5 Demo mode is simulated in the page.** No permission, no push service and no server write are involved, and the test is previewed in the page (comment: app/src/notify.ts:4; app/src/locales/en.ts:482).
- **D-6 A tap reuses the open window.** If the app is open, the service worker focuses it and the page navigates through `postMessage` instead of reloading (comment: app/vite.config.ts:108).
- **D-7 Notifications exist only in the web app (PWA).** The Tauri apps show a hint instead (src: app/src/notify.ts:49; app/src/locales/en.ts:486). Confirmed (owner decision). Rationale: Web Push needs a service worker, and the Tauri builds register none (comment: app/src/pwa.ts:3); the native apps are also paused (comment: .github/workflows/android.yml:4).
- **D-8 Nothing from a push is cached.** The service worker only displays the payload (comment: app/vite.config.ts:92).

## 5. Constraints

- The server must be at API level 13 or higher (src: app/src/version.ts:10).
- Notifications need a secure context (https) and browser support for service workers, `PushManager` and `Notification`. Over plain http on a LAN they are not available (src: app/src/notify.ts:20, 52; doc: docs/install.md "Appendix: LAN-only use").
- iPhone / iPad need iOS 16.4 or later, with DriveLens added to the Home Screen and opened from there. Android and desktop need Chrome, Edge or Firefox (doc: docs/install.md "7. Notifications").
- Timeouts: 10 s for the service worker when turning on; 4 s for subscription lookups (src: app/src/notify.ts:26, 32).
- A subscription belongs to one browser on one device ("On for this device") (src: app/src/locales/en.ts:474; doc: docs/install.md "7. Notifications").
- Read-only devices may change their own notification settings (doc: SECURITY.md "Privacy promise").
- The service worker uses only `title`, `body`, `tag` and `url` from the payload. `kind` is not read (src: app/vite.config.ts:96-98).

## 6. Non-goals

- The client does not detect drives or compose message texts (comment: app/src/notify.ts:2-4).
- No notifications in the Tauri desktop / Android apps (src: app/src/notify.ts:49).
- Confirmed (current scope): There is no per-car choice in the UI. `car_ids` is never sent, although the server supports it (src: app/src/notify.ts:35-39; api/src/push.rs:446).
- Confirmed (current scope): There is no list or history of past notifications in the app (src: app/src/notify.ts:126-183).

## 7. Current behavior vs. intended behavior

| ID | Current behavior (evidence) | Why it looks unintended | Presumed intended behavior |
|----|-----------------------------|-------------------------|----------------------------|
| CB-1 | When the server answers 503, the card tells the user to "run deploy/drivelens-v0.16.0.sql" on the server. The same text is in all three locales (src: app/src/locales/en.ts:488; app/src/locales/zh.ts:487; app/src/locales/ja.ts:488). | The current setup path is `deploy/setup.sql`, after which the API creates its tables itself. `setup.sql` says the older SQL files are no longer needed (comment: deploy/setup.sql:18-19; doc: CHANGELOG.md, header). Likely stale; it mirrors `api-push` CB-1. | The hint points to re-running `deploy/setup.sql` once and restarting drivelens-api, or to the install guide. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Text only, in all three locales (X-4). |
| CB-2 | Trip notification URLs carry `&car=<car id>` (src: api/src/push.rs:203; test: api/src/push.rs tests::trip_texts). The app reads only the `view` parameter, both at startup and in service-worker messages (src: app/src/main.ts:935; app/vite.config.ts:107). The car selector is not switched to the drive's car. | The server sends a parameter that no code reads. For several cars, the drive page opens, but "back" leads to the list of the previously selected car. Possible. | Either switch the selected car to `car` when opening the target, or stop sending the parameter. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor, multi-car only (X-6). |
| CB-3 | The monthly reminder's distance and drive count cover all cars, because the app never sends `car_ids` (src: app/src/notify.ts:35-39; api/src/push.rs:331-335). Tapping it opens the report of the currently selected car (src: app/src/main.ts:814). | With several cars, the numbers in the notification can differ from the report that opens. Possible; affects multi-car installs only. | Numbers and the opened report refer to the same scope: per car, or a report for all cars. **Review:** real issue, verified at 9b1c39c; not fixed in this PR. Minor, multi-car only. |

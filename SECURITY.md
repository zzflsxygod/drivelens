# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: go to the repository's **Security** tab → **Report a vulnerability** (a [private security advisory](https://github.com/zzflsxygod/drivelens/security/advisories/new)). Please include:

- what is affected (drivelens-api, the web app, or both) and which version
- steps to reproduce or a proof of concept
- the impact you expect

You should get a first reply within a few days. Once a fix is released, the advisory will be published, with credit to you if you want it.

## Supported versions

Only the latest release is supported. drivelens-api is normally kept up to date automatically (Watchtower), and the official web app at https://drivelens-app.oharuru.com always runs the latest version.

## Privacy promise

- DriveLens **never sends your server URL or your API token anywhere except your own server.** They are stored only on your device (in the browser's localStorage) and are only used for requests to the server you entered. They are never put in URLs, and DriveLens will not add features that share them with anyone else.
- **No telemetry, analytics or tracking.** DriveLens does not collect usage data, crash reports or identifiers.
- Your TeslaMate data stays on your server. The app requests it directly from your drivelens-api; there is no DriveLens backend in between.
- The only third-party requests the app makes are for map tiles (OpenFreeMap, falling back to OpenStreetMap).
- Your own drivelens-api fetches weather for journeys from Open-Meteo using coordinates rounded to 0.1° (about 10 km) and dates; no token or identifier is sent. Web push notifications are sent by your own server through your browser's push service (for example Google, Apple or Mozilla) and are encrypted end to end.
- drivelens-api only has read access to TeslaMate's tables and never modifies them.

## Scope notes

drivelens-api is designed to run behind HTTPS (Cloudflare Tunnel, Tailscale Serve or a reverse proxy) and to be protected by a long random API token. Problems that require an attacker to already have that token, or that come from exposing PostgreSQL or the API over plain HTTP against the install guide, are generally out of scope, but reports are still welcome.

# DriveLens

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/zzflsxygod)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](LICENSE)

DriveLens is a third-party companion app for [TeslaMate](https://github.com/teslamate-org/teslamate). It reads your own TeslaMate database (read-only) and shows drives, routes, charging sessions, monthly reports, journeys and battery health in a mobile-first web app.

- **Web app (official):** https://drivelens-app.oharuru.com
- **Install the server part (drivelens-api):** [docs/install.md](docs/install.md) · [中文](docs/install.zh.md) · [日本語](docs/install.ja.md)
- **Releases, changelog and downloads:** [zzflsxygod/drivelens-releases](https://github.com/zzflsxygod/drivelens-releases)
- **Support the project:** [Buy Me a Coffee](https://buymeacoffee.com/zzflsxygod) ☕

```
Browser (official web app)  ──HTTPS + Bearer token──>  drivelens-api (your server)  ──read-only──>  TeslaMate PostgreSQL
```

DriveLens **never modifies TeslaMate's tables**. drivelens-api only has `SELECT` on them; DriveLens' own data (place names, manual charging costs, journeys, push subscriptions, weather cache) lives in a separate `drivelens` schema.

## How to use it

1. Run **drivelens-api** next to TeslaMate on your server, using the prebuilt image `ghcr.io/zzflsxygod/drivelens-api` (linux/amd64 + linux/arm64). Follow the [install guide](docs/install.md).
2. Open the **official web app** at https://drivelens-app.oharuru.com and enter your server URL and token. They are stored only in your browser and are sent only to your own server.

The official hosted web app is the supported way to use DriveLens. The source code in this repository is published for transparency, auditing and contributions. Self-hosting the web app is possible under the license, but it is **not officially supported**.

## Repository layout

| Path | What it is |
| --- | --- |
| `api/` | drivelens-api: Rust (Axum + sqlx) server, Dockerfile |
| `app/` | DriveLens app: Vite + TypeScript web app / PWA (MapLibre), Tauri 2 shell for the paused native builds |
| `deploy/` | Docker Compose snippet and database setup / migration SQL |
| `docs/` | Install guides (en / zh / ja) and development notes (`DEVELOPMENT.zh.md`) |
| `testdata/` | Synthetic TeslaMate-compatible schema and sample data for local testing (no real data) |
| `distribution/` | Files mirrored to the public releases repo (README, CHANGELOG, demo screenshots) |
| `scripts/` | Release tooling used by the maintainer |

## Contributing

Bug reports and pull requests are welcome. Please open an issue before starting work on a new feature; small fixes can go straight to a pull request. Every commit needs a DCO `Signed-off-by` line. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the API and the app locally.

Security issues: please report them privately, see [SECURITY.md](SECURITY.md).

## Privacy

DriveLens never sends your server URL or token anywhere except your own server, and it has no telemetry or analytics. Details are in [SECURITY.md](SECURITY.md).

## Name and logo

"DriveLens" and the DriveLens logo identify the official project. If you fork DriveLens, please give your fork a different name and logo so users don't confuse it with the official app.

## License

Copyright (C) 2026 zzflsxygod

DriveLens is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).

If you run a modified version as a network service, the AGPL requires you to offer its source code to the users of that service.

DriveLens is an independent project and is not affiliated with, endorsed by or sponsored by Tesla, Inc. or the TeslaMate project. "Tesla" is a trademark of Tesla, Inc. Maps © [OpenFreeMap](https://openfreemap.org) / © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Weather data by [Open-Meteo](https://open-meteo.com).

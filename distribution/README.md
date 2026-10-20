# DriveLens

**English** · [中文](README.zh.md) · [日本語](README.ja.md)

DriveLens is a companion app for [TeslaMate](https://github.com/teslamate-org/teslamate). It reads your own TeslaMate database through a small read-only API on your server and shows your car, drives, charging sessions, journeys and monthly reports in a clean mobile-first app.

- **Web app:** https://drivelens-app.oharuru.com — works on phones and desktops, can be installed to the home screen (PWA)
- **Try it without a server:** [open the demo](https://drivelens-app.oharuru.com/?demo) (fictional car and data, nothing leaves your browser)
- **Self-host the backend:** [install guide](docs/install.md) · [中文](docs/install.zh.md) · [日本語](docs/install.ja.md)
- **What's new:** [CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/zzflsxygod/drivelens-releases/releases)
- **Feedback:** [Issues](https://github.com/zzflsxygod/drivelens-releases/issues/new/choose)

<p>
  <img src="screenshots/home-light.jpg" width="200" alt="Home">
  <img src="screenshots/drives.jpg" width="200" alt="Drives">
  <img src="screenshots/journey.jpg" width="200" alt="Journey">
</p>
<p>
  <img src="screenshots/report.jpg" width="200" alt="Monthly report">
  <img src="screenshots/share-card.jpg" width="200" alt="Share card">
  <img src="screenshots/home-dark.jpg" width="200" alt="Dark mode">
</p>

<sub>Screenshots are from demo mode (fictional data).</sub>

## Features

- **Home:** state of charge, range, odometer, software version, temperatures, current location on a map, this month at a glance
- **Drives and charging:** infinite lists with month headers, route maps coloured by speed, charging curves, weather per drive, energy by speed band
- **Journeys:** group drives into trips (with automatic suggestions), add a cover photo and notes, create a share card
- **Monthly report:** distance, energy, charging cost, home vs. Supercharger split, daily breakdown, footprint map, 12-month trends
- **Battery health:** degradation curve based on rated range
- **Notifications (web app):** a trip summary when a drive ends and a monthly-report reminder on the 1st, each switchable
- **Your names and costs:** rename places, enter charging costs manually (any currency)
- **Languages:** English, 中文, 日本語 · light and dark theme

## How it works

```
DriveLens app (web / Windows / Android)  ──https + token──>  drivelens-api (on your server)  ──read-only──>  TeslaMate PostgreSQL
```

- The app talks **directly to your own server**. Your token and your data never pass through any DriveLens service; the web app is only static files.
- drivelens-api uses a **read-only** database account and **never modifies TeslaMate's tables**. Its own data (place names, costs, journeys, covers, weather cache) lives in a separate `drivelens` schema.
- The server needs an https address for the web app (Cloudflare Tunnel or `tailscale serve` work well). See the [install guide](docs/install.md).

## Requirements

- TeslaMate running with Docker Compose
- An x86_64 or ARM64 server (Raspberry Pi works)
- A way to reach the server securely from outside (Cloudflare Tunnel or Tailscale recommended)

## Quick start

```bash
cd teslamate   # TeslaMate's compose directory
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/setup.sql
curl -fsSLO https://raw.githubusercontent.com/zzflsxygod/drivelens-releases/main/deploy/docker-compose.drivelens.yml
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
source .env
docker compose exec -T database psql -U teslamate -d teslamate -v ro_pass="$DRIVELENS_DB_PASS" < setup.sql
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d drivelens-api
```

Then make it reachable over https and enter the address and `DRIVELENS_API_TOKEN` in the app. The [install guide](docs/install.md) explains each step.

## License

DriveLens is **free to use** but it is **not open source**. The source code is not published. See [LICENSE](LICENSE).

DriveLens is an independent project and is not affiliated with Tesla, Inc. or the TeslaMate project. Maps © [OpenFreeMap](https://openfreemap.org) / © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Weather data by [Open-Meteo](https://open-meteo.com).

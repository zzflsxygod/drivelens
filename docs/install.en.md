# DriveLens installation guide (self-hosted TeslaMate)

[中文](install.md) · **English** · [日本語](install.ja.md)

DriveLens has two parts:

- **drivelens-api** — a small service (Docker container) on your TeslaMate server that reads the TeslaMate database through a read-only account.
- **DriveLens app** — the phone / desktop client. On first launch you enter your server URL and token.

> DriveLens **never modifies TeslaMate's tables**. It only has SELECT on them; its own data (place names, manual charging costs, journeys, covers, weather cache) lives in a separate `drivelens` schema.

## Requirements

- TeslaMate running with Docker Compose (the official `docker-compose.yml`; the database service is called `database`, and the database name / admin user are `teslamate` by default).
- An x86_64 or ARM64 server (Raspberry Pi works).
- A safe way to reach the server from outside: **Cloudflare Tunnel or Tailscale is recommended** (step 5).

## 1. Get the source

Put the DriveLens source in a `drivelens/` folder inside your TeslaMate compose directory (unpack the archive you received, or `git clone`):

```
teslamate/
├── docker-compose.yml        # TeslaMate's existing file
├── .env
└── drivelens/                # DriveLens source
    ├── api/
    └── deploy/
```

## 2. Generate a password and a token in `.env`

In the TeslaMate compose directory:

```bash
echo "DRIVELENS_DB_PASS=$(openssl rand -hex 16)"  >> .env
echo "DRIVELENS_API_TOKEN=$(openssl rand -hex 24)" >> .env
```

- `DRIVELENS_DB_PASS` — password of the read-only database account `drivelens_ro`.
- `DRIVELENS_API_TOKEN` — the token the app uses (**at least 16 characters; 32+ random characters recommended**; the API log and the app warn when it is too short).

## 3. Create the database account (once)

```bash
source .env
docker compose exec -T database psql -U teslamate -d teslamate \
  -v ro_pass="$DRIVELENS_DB_PASS" < drivelens/deploy/setup.sql
```

`setup.sql` can be run again safely. It:

1. creates the login role `drivelens_ro` (or just updates its password);
2. grants **SELECT** on TeslaMate's tables (including tables added by future TeslaMate upgrades);
3. grants REFERENCES on `cars / addresses / drives / charging_processes` (DriveLens tables use foreign keys to them, so its data is cleaned up when TeslaMate deletes a drive; **no write access**);
4. creates the `drivelens` schema owned by `drivelens_ro`.

After that the API **creates and upgrades its tables in the `drivelens` schema automatically** on every start (idempotent). No further SQL is needed.

> If your database name or admin user isn't `teslamate`, change `-U` / `-d` and add `DRIVELENS_DB_NAME=yourdb` to `.env`.

## 4. Start drivelens-api

```bash
cp drivelens/deploy/docker-compose.drivelens.yml .
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d --build drivelens-api
docker compose -f docker-compose.yml -f docker-compose.drivelens.yml logs drivelens-api
```

The first build takes a few minutes (10+ minutes on a Raspberry Pi). When the log shows

```
INFO drivelens_api: all features enabled (API level 12)
INFO drivelens_api: listening on 0.0.0.0:8080
```

everything is fine. If you see `disabled features: …` or `cannot read TeslaMate tables`, step 3 didn't succeed: run `setup.sql` again and `docker compose restart drivelens-api`. Read-only features (drives, charging, reports…) keep working in the meantime.

Local check: `curl http://127.0.0.1:8080/health` should return `{"status":"ok","version":"…","api_level":…}`.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | `postgres://drivelens_ro:password@database:5432/teslamate` (the compose file builds it from `.env`) |
| `API_TOKEN` | ✅ | Bearer token for the app; at least 16 characters, 32+ recommended |
| `BIND_ADDR` | | Listen address, `0.0.0.0:8080` in the image |
| `DRIVELENS_CORS_ORIGINS` | | Comma-separated web origins allowed to call the API from a browser (v0.11.0+; the old name `CORS_ORIGINS` still works). Default: only the official web app `https://drivelens-app.oharuru.com`; the Windows / Android apps are always allowed. Add your own URL if you host the web app yourself; `*` allows any origin |
| `RUST_LOG` | | Log level, default `info` |

`.env` variables used by the compose file: `DRIVELENS_DB_PASS`, `DRIVELENS_API_TOKEN`, optionally `DRIVELENS_DB_NAME` (default teslamate), `DRIVELENS_SRC` (source folder, default `./drivelens`) and `DRIVELENS_IMAGE` (if you use your own registry).

### Updating

```bash
cd drivelens && git pull   # or replace with the new source
cd .. && docker compose -f docker-compose.yml -f docker-compose.drivelens.yml up -d --build drivelens-api
```

The API upgrades its database schema automatically on start.

## 5. Reaching the server securely (pick one)

**Don't expose port 8080 directly to the internet** (without https the token travels in plain text).

### Option A: Cloudflare Tunnel (recommended if you have a domain)

1. In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and copy its token.
2. Uncomment the `cloudflared` section in `docker-compose.drivelens.yml` and add `CLOUDFLARE_TUNNEL_TOKEN=…` to `.env`; you can then remove `ports:` from `drivelens-api`.
3. Add a Public Hostname `drivelens.your-domain` → `http://drivelens-api:8080` (or `http://127.0.0.1:8080` if cloudflared runs on the host).
4. In the app, enter `https://drivelens.your-domain`.

### Option B: Tailscale (no domain / private access)

1. Install Tailscale on the server and your phone and sign in to the same account.
2. Change `ports` in the compose file to `- "8080:8080"` (reachable only via Tailscale / LAN — don't forward the port on your router).
3. In the app, enter `http://<server's Tailscale IP or name>:8080` (e.g. `http://100.x.y.z:8080`). `tailscale serve` can add https.

> Built-in protections: constant-time token comparison; 10 failed logins from one IP within 10 minutes → temporarily refused (HTTP 429); read-only access to TeslaMate's tables.

## 6. Install and set up the app

1. Install the app (Windows installer / Android APK, distributed by whoever shared DriveLens with you).
2. On first launch you'll see “Welcome to DriveLens” (the language follows your system and can be changed at the top right):
   - **Server URL** — from step 5, e.g. `https://drivelens.example.com`;
   - **API token** — `DRIVELENS_API_TOKEN` from `.env`.
3. Tap “Test connection & start”. The app checks `/health`, then reads your cars with the token, and explains what went wrong if it fails:

| Message | What to do |
| --- | --- |
| Wrong token (401) | Copy `DRIVELENS_API_TOKEN` again, without spaces or quotes |
| Can't reach / timed out | Check the URL and that the tunnel or Tailscale is running; Cloudflare Tunnel needs `https://`, a direct port is usually `http://…:8080` |
| Isn't a DriveLens API | You entered the TeslaMate / Grafana URL; use the drivelens-api URL |
| Server is too old | Update drivelens-api (see “Updating”) |
| Too many wrong tokens (429) | Wait 10 minutes and try again |

You can change the server URL and token at any time in Settings (new values are saved only after a successful test). The app language, map label language and default currency follow your device and can also be changed in Settings.

## 7. Web app (PWA)

If you'd rather not install an app, open **https://drivelens-app.oharuru.com** in a browser and enter your server address and token (or try the demo first). The web app is just static files: your browser talks directly to **your own** drivelens-api; the token and your data never pass through the web host.

**Server requirements**

- **drivelens-api v0.11.0 or later**: allows the official web app (CORS) by default. If you set `DRIVELENS_CORS_ORIGINS`, include `https://drivelens-app.oharuru.com`, e.g.
  ```yaml
  environment:
    - DRIVELENS_CORS_ORIGINS=https://drivelens-app.oharuru.com
  ```
- **https only**: browsers block calls from an https page to an `http://` address (mixed content). Cloudflare Tunnel (option A) works; with Tailscale enable `tailscale serve` and use `https://machine.your-tailnet.ts.net` instead of `http://100.x.y.z:8080`.
- Don't put a login page such as Cloudflare Access in front of the API — it blocks the browser's cross-origin requests.

**Install to the home screen**

- Android (Chrome) / desktop (Chrome, Edge): "Install as an app" at the bottom of Settings, or the browser menu → Install app.
- iPhone / iPad (Safari): Share → Add to Home Screen. Installed, it opens full-screen in portrait.

**Notes**

- The token is kept in this browser's local storage; clear it in Settings on shared computers.
- The offline cache holds only the app itself (HTML / JS / CSS / icons); API responses are never cached.
- Hosting the web app yourself: download `DriveLens_<version>_web.zip` from the release, unzip it to any https static host (unknown paths must fall back to `index.html`) and add your URL to `DRIVELENS_CORS_ORIGINS` on the server.

| Web app message | What to do |
| --- | --- |
| Server does not allow this site (CORS) | Update drivelens-api to v0.11.0+, check `DRIVELENS_CORS_ORIGINS` |
| Browser blocks the http server address | Use an https address (Cloudflare Tunnel / `tailscale serve`) |
| Can't reach (certificate / domain) | Check the domain, that the tunnel is running and the certificate is valid |

## Troubleshooting

- **Log shows `password authentication failed for user "drivelens_ro"`**: `DRIVELENS_DB_PASS` in `.env` differs from the password used with `setup.sql`. Run step 3 again (it updates the password).
- **Log shows `API_TOKEN looks weak`**: the token is short or simple. Replace it with one from `openssl rand -hex 24` and update the app settings.
- **Uninstall**: stop and remove the `drivelens-api` container, then (optionally) run as the admin
  `DROP SCHEMA drivelens CASCADE; DROP OWNED BY drivelens_ro; DROP ROLE drivelens_ro;` — TeslaMate's data is not affected.

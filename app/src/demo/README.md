# Demo Mode data

Offline demo (app ≥ 0.13.0): every API call goes to `server.ts`, which works out the responses from a dataset that `gen.ts` builds at load time.
This chunk is lazy-loaded, about 77 KB raw / 32 KB gzip.

- **Car**: "Demo Car". It is fictional, with specs like a Model 3 RWD.
- **Timeline**: about 92 days ending today (Asia/Tokyo), generated deterministically. Dates shift relative to the current day.
- **Places**: the home is deliberately fictional, 「東京タワー（デモ）」 (geofence 「🗼 Demo Home」), placed on Tokyo Tower's own car park so it can't be mistaken for a real house. The office is 羽田イノベーションシティ (a commercial complex, about 14 km away). Other places are stations, landmarks and chargers. Never put a demo place on a residence.
- **Routes** (`routes.json`): real road geometry for 31 Tokyo-area legs, made by `app/scripts/demo/fetch-routes.py`.
  - `python3 app/scripts/demo/fetch-routes.py` fetches all legs; `python3 app/scripts/demo/fetch-routes.py 'H>O' 'O>H'` re-fetches only those legs and keeps the others.
  - Routed with the public OSRM server on OpenStreetMap data.
  - **© OpenStreetMap contributors, ODbL 1.0**: [https://www.openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)
  - Simplified to about 6 m.
- **Elevation**: Copernicus DEM GLO-90 via the Open-Meteo Elevation API (CC BY 4.0).
- **Weather / temperatures**: synthetic Tokyo climatology. No Open-Meteo request is made in demo mode.
- **Writes** (aliases, costs, journeys, covers, dismissals): kept in `localStorage["drivelens-demo-state"]`. They are reset when you exit or on a new day.
- **Charging**:
  - Home charging: about ¥31/kWh. This is the TeslaMate cost.
  - Supercharger places: generic names. Cost is a manual ¥66/kWh.

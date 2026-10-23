// SPDX-License-Identifier: AGPL-3.0-or-later
//! 旅程第二期 (api_level 11): cover image, weather per drive (Open-Meteo, cached in drivelens.weather_hourly),
//! energy by speed band. Only drivelens.* is written; TeslaMate tables are read only.
use super::*;
use std::collections::HashMap;
use std::sync::atomic::Ordering;

const COVER_MISSING: &str = "column drivelens.journeys.cover_image is missing; run deploy/setup.sql and restart the API";
const WEATHER_MISSING: &str = "table drivelens.weather_hourly is missing or not writable; run deploy/setup.sql and restart the API";

pub const DDL: [&str; 3] = [
    "ALTER TABLE drivelens.journeys ADD COLUMN IF NOT EXISTS cover_image text",
    "ALTER TABLE drivelens.journeys ADD COLUMN IF NOT EXISTS cover_updated_at timestamptz",
    "CREATE TABLE IF NOT EXISTS drivelens.weather_hourly (
        lat_key smallint NOT NULL, lng_key smallint NOT NULL, hour timestamptz NOT NULL,
        temp_c real, precip_mm real, source text NOT NULL DEFAULT 'archive',
        fetched_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (lat_key, lng_key, hour))",
];

/// Best effort; a no-op when everything already exists (e.g. production where an admin ran the old SQL
/// and the API role does not own the tables — ALTER would fail there even with IF NOT EXISTS).
pub async fn try_migrate(db: &PgPool) {
    let done: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'drivelens' AND table_name = 'journeys' AND column_name = 'cover_updated_at') AND to_regclass('drivelens.weather_hourly') IS NOT NULL")
        .fetch_one(db).await.unwrap_or(false);
    let has_journeys: bool = sqlx::query_scalar("SELECT to_regclass('drivelens.journeys') IS NOT NULL").fetch_one(db).await.unwrap_or(false);
    if done || !has_journeys { return; }
    for q in DDL { if let Err(e) = sqlx::query(q).execute(db).await { tracing::warn!("journey cover / weather cache schema not applied ({e}); run deploy/setup.sql and restart the API"); return; } }
}

pub async fn cover_ok(s: &AppState) -> Result<bool, ApiError> {
    if s.cover_ok.load(Ordering::Relaxed) { return Ok(true); }
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'drivelens' AND table_name = 'journeys' AND column_name = 'cover_image')").fetch_one(&s.db).await?;
    if ok { s.cover_ok.store(true, Ordering::Relaxed); }
    Ok(ok)
}
pub async fn weather_ok(s: &AppState) -> Result<bool, ApiError> {
    if s.weather_ok.load(Ordering::Relaxed) { return Ok(true); }
    let ok: bool = sqlx::query_scalar(
        "SELECT to_regclass('drivelens.weather_hourly') IS NOT NULL AND has_table_privilege('drivelens.weather_hourly', 'SELECT,INSERT,UPDATE')").fetch_one(&s.db).await
        .or_else(|e| match &e { sqlx::Error::Database(_) => Ok(false), _ => Err(e) })?;
    if ok { s.weather_ok.store(true, Ordering::Relaxed); }
    Ok(ok)
}

fn err(code: StatusCode, msg: &str) -> Response { (code, Json(serde_json::json!({"error": msg}))).into_response() }

// ---------------- cover ----------------
#[derive(Deserialize)]
pub struct CoverBody { image: String }

pub async fn get_cover(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    if !cover_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, COVER_MISSING)); }
    let r: Option<(Option<String>, Option<String>)> = sqlx::query_as(&format!(
        "SELECT cover_image, to_char(cover_updated_at AT TIME ZONE 'UTC', '{TS}') FROM drivelens.journeys WHERE id = $1")).bind(id as i32).fetch_optional(&s.db).await?;
    let Some((image, updated_at)) = r else { return Ok(err(StatusCode::NOT_FOUND, "journey not found")) };
    Ok(Json(serde_json::json!({"image": image, "updated_at": updated_at})).into_response())
}

pub async fn put_cover(State(s): State<AppState>, Path(id): Path<i64>, Json(b): Json<CoverBody>) -> Result<Response, ApiError> {
    if !cover_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, COVER_MISSING)); }
    let ok_type = ["data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,"].iter().any(|p| b.image.starts_with(p));
    if !ok_type { return Ok(err(StatusCode::BAD_REQUEST, "image must be a JPEG/PNG/WebP data URL")); }
    if b.image.len() > 1_500_000 { return Ok(err(StatusCode::PAYLOAD_TOO_LARGE, "image too large (max ~1 MB)")); }
    let r = sqlx::query("UPDATE drivelens.journeys SET cover_image = $2, cover_updated_at = now(), updated_at = now() WHERE id = $1")
        .bind(id as i32).bind(&b.image).execute(&s.db).await?;
    Ok(if r.rows_affected() == 0 { err(StatusCode::NOT_FOUND, "journey not found") } else { StatusCode::NO_CONTENT.into_response() })
}

pub async fn delete_cover(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    if !cover_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, COVER_MISSING)); }
    let r = sqlx::query("UPDATE drivelens.journeys SET cover_image = NULL, cover_updated_at = NULL, updated_at = now() WHERE id = $1")
        .bind(id as i32).execute(&s.db).await?;
    Ok(if r.rows_affected() == 0 { err(StatusCode::NOT_FOUND, "journey not found") } else { StatusCode::NO_CONTENT.into_response() })
}

/// Journey ids with a cover (for list thumbnails / detail flag). Empty when the column is missing.
pub async fn has_cover(s: &AppState, id: i64) -> Result<bool, ApiError> {
    if !cover_ok(s).await? { return Ok(false); }
    Ok(sqlx::query_scalar::<_, bool>("SELECT cover_image IS NOT NULL FROM drivelens.journeys WHERE id = $1").bind(id as i32).fetch_optional(&s.db).await?.unwrap_or(false))
}

// ---------------- weather ----------------
#[derive(FromRow)]
struct DStart { id: i64, lat: Option<f64>, lng: Option<f64>, hour: Option<String>, day: Option<String> }
#[derive(Serialize)]
struct DWeather { drive_id: i64, temp_c: Option<f64>, precip_mm: Option<f64>, source: Option<String> }

/// Weather at each drive's start (hour, ~0.1° cell). Missing cells are fetched from Open-Meteo
/// (archive API; the last days come from the forecast API's past data) and cached in drivelens.weather_hourly.
pub async fn weather(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    if !weather_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, WEATHER_MISSING)); }
    let ds = sqlx::query_as::<_, DStart>(
        "SELECT d.id::int8 AS id, COALESCE(p.latitude, a.latitude)::float8 AS lat, COALESCE(p.longitude, a.longitude)::float8 AS lng,
                to_char(date_trunc('hour', d.start_date), 'YYYY-MM-DD HH24:00:00') AS hour, to_char(d.start_date, 'YYYY-MM-DD') AS day
         FROM drivelens.journey_drives jd JOIN drives d ON d.id = jd.drive_id LEFT JOIN positions p ON p.id = d.start_position_id LEFT JOIN addresses a ON a.id = d.start_address_id
         WHERE jd.journey_id = $1 ORDER BY d.start_date").bind(id as i32).fetch_all(&s.db).await?;
    let key = |lat: f64, lng: f64| ((lat * 10.0).round() as i16, (lng * 10.0).round() as i16);
    let lookup = |ds: &Vec<DStart>| {
        let mut lk: Vec<i16> = vec![]; let mut gk: Vec<i16> = vec![]; let mut hs: Vec<String> = vec![];
        for d in ds { if let (Some(a), Some(b), Some(h)) = (d.lat, d.lng, &d.hour) { let k = key(a, b); lk.push(k.0); gk.push(k.1); hs.push(h.clone()); } }
        (lk, gk, hs)
    };
    let (lk, gk, hs) = lookup(&ds);
    let fetch_cached = |lk: Vec<i16>, gk: Vec<i16>, hs: Vec<String>| {
        let db = s.db.clone();
        async move {
            sqlx::query_as::<_, (i16, i16, String, Option<f64>, Option<f64>, String)>(
                "SELECT w.lat_key, w.lng_key, to_char(w.hour AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:00:00'), round(w.temp_c::numeric, 1)::float8, round(w.precip_mm::numeric, 1)::float8, w.source
                 FROM drivelens.weather_hourly w JOIN unnest($1::int2[], $2::int2[], $3::text[]) AS q(a, b, h)
                   ON w.lat_key = q.a AND w.lng_key = q.b AND w.hour = (q.h::timestamp AT TIME ZONE 'UTC')")
                .bind(lk).bind(gk).bind(hs).fetch_all(&db).await
        }
    };
    let mut cache: HashMap<(i16, i16, String), (Option<f64>, Option<f64>, String)> =
        fetch_cached(lk.clone(), gk.clone(), hs.clone()).await?.into_iter().map(|r| ((r.0, r.1, r.2), (r.3, r.4, r.5))).collect();
    // cells (with day range) that need fetching
    let mut need: HashMap<(i16, i16), (String, String)> = HashMap::new();
    for d in &ds {
        let (Some(a), Some(b), Some(h), Some(day)) = (d.lat, d.lng, &d.hour, &d.day) else { continue };
        let k = key(a, b);
        if cache.contains_key(&(k.0, k.1, h.clone())) { continue; }
        let e = need.entry(k).or_insert((day.clone(), day.clone()));
        if *day < e.0 { e.0 = day.clone(); } if *day > e.1 { e.1 = day.clone(); }
    }
    let mut failed = false;
    if !need.is_empty() {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?;
        for ((la, lo), (d0, d1)) in need.into_iter().take(20) {
            match fetch_open_meteo(&client, la, lo, &d0, &d1).await {
                Ok(rows) if !rows.is_empty() => {
                    let (mut hh, mut tt, mut pp, mut ss) = (vec![], vec![], vec![], vec![]);
                    for (h, t, p, src) in rows { hh.push(h); tt.push(t.map(|x| x as f32)); pp.push(p.map(|x| x as f32)); ss.push(src); }
                    sqlx::query(
                        "INSERT INTO drivelens.weather_hourly (lat_key, lng_key, hour, temp_c, precip_mm, source)
                         SELECT $1, $2, h::timestamp AT TIME ZONE 'UTC', t, p, src FROM unnest($3::text[], $4::real[], $5::real[], $6::text[]) AS x(h, t, p, src)
                         ON CONFLICT (lat_key, lng_key, hour) DO UPDATE SET temp_c = EXCLUDED.temp_c, precip_mm = EXCLUDED.precip_mm, source = EXCLUDED.source, fetched_at = now()")
                        .bind(la).bind(lo).bind(&hh).bind(&tt).bind(&pp).bind(&ss).execute(&s.db).await?;
                }
                Ok(_) => {}
                Err(e) => { tracing::warn!("open-meteo fetch failed for {la},{lo}: {e}"); failed = true; }
            }
        }
        cache = fetch_cached(lk, gk, hs).await?.into_iter().map(|r| ((r.0, r.1, r.2), (r.3, r.4, r.5))).collect();
    }
    let out: Vec<DWeather> = ds.iter().map(|d| {
        let c = match (d.lat, d.lng, &d.hour) { (Some(a), Some(b), Some(h)) => { let k = key(a, b); cache.get(&(k.0, k.1, h.clone())) } _ => None };
        DWeather { drive_id: d.id, temp_c: c.and_then(|c| c.0), precip_mm: c.and_then(|c| c.1), source: c.map(|c| c.2.clone()) }
    }).collect();
    Ok(Json(serde_json::json!({"drives": out, "partial": failed, "attribution": "Weather data by Open-Meteo.com (CC BY 4.0)"})).into_response())
}

/// Hourly rows (UTC "YYYY-MM-DD HH:00:00", temp, precip, source). Only hours with a temperature are returned
/// (the archive lags a few days; those hours are filled from the forecast API's past data).
async fn fetch_open_meteo(c: &reqwest::Client, la: i16, lo: i16, d0: &str, d1: &str) -> anyhow::Result<Vec<(String, Option<f64>, Option<f64>, String)>> {
    let (lat, lng) = (la as f64 / 10.0, lo as f64 / 10.0);
    let mut out: HashMap<String, (Option<f64>, Option<f64>, String)> = HashMap::new();
    for (src, base) in [("archive", "https://archive-api.open-meteo.com/v1/archive"), ("forecast", "https://api.open-meteo.com/v1/forecast")] {
        let url = format!("{base}?latitude={lat}&longitude={lng}&start_date={d0}&end_date={d1}&hourly=temperature_2m,precipitation&timezone=GMT");
        let r = c.get(&url).send().await?;
        if !r.status().is_success() { if src == "forecast" { break; } continue; } // forecast rejects dates older than ~3 months
        let v: serde_json::Value = r.json().await?;
        let h = &v["hourly"];
        let (Some(ts), Some(tt), Some(pp)) = (h["time"].as_array(), h["temperature_2m"].as_array(), h["precipitation"].as_array()) else { continue };
        for i in 0..ts.len() {
            let Some(t) = ts[i].as_str() else { continue };
            let temp = tt.get(i).and_then(|x| x.as_f64());
            if temp.is_none() || out.contains_key(t) { continue; }
            out.insert(t.to_string(), (temp, pp.get(i).and_then(|x| x.as_f64()), src.to_string()));
        }
        // complete? (all hours of the range present)
        if out.len() >= ts.len() { break; }
    }
    Ok(out.into_iter().map(|(t, (a, b, s))| (format!("{}:00", t.replace('T', " ")), a, b, s)).collect())
}

// ---------------- speed bands ----------------
#[derive(FromRow)]
struct BandRow { drive_id: i64, band: i32, dist_km: f64, dist_pw_km: f64, pw_kwh: f64, dt_s: f64 }
#[derive(Serialize)]
struct Band { key: &'static str, label: &'static str, distance_km: f64, energy_kwh: f64, wh_km: Option<f64>, duration_min: f64, share: f64 }

/// Distance/energy by speed band (市区 <40, 郊外 40–80, 高速 >80 km/h) from consecutive position pairs
/// (one indexed scan of the journey's positions, aggregated in SQL). Energy per segment = integrated
/// power where both points have it, otherwise the drive's measured Wh/km; then each drive is scaled
/// so its bands add up to the drive's energy (rated range × efficiency, same as elsewhere).
pub async fn speed_bands(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    let w: Option<(i64, Option<String>, Option<String>, Vec<i32>)> = sqlx::query_as(
        "SELECT j.car_id::int8, to_char(min(d.start_date), 'YYYY-MM-DD HH24:MI:SS'), to_char(max(d.end_date), 'YYYY-MM-DD HH24:MI:SS'), array_agg(d.id)
         FROM drivelens.journeys j JOIN drivelens.journey_drives jd ON jd.journey_id = j.id JOIN drives d ON d.id = jd.drive_id
         WHERE j.id = $1 GROUP BY j.car_id").bind(id as i32).fetch_optional(&s.db).await?;
    let Some((car, Some(t0), Some(t1), ids)) = w else { return Ok(Json(serde_json::json!({"bands": [], "method": "none"})).into_response()) };
    let rows = sqlx::query_as::<_, BandRow>(
        "WITH p AS (
           SELECT drive_id, speed, power, date, latitude::float8 AS la, longitude::float8 AS lo,
                  lag(speed) OVER w AS ps, lag(power) OVER w AS pp, lag(latitude::float8) OVER w AS pla, lag(longitude::float8) OVER w AS plo, lag(date) OVER w AS pd
           FROM positions WHERE car_id = $1 AND date >= $2::timestamp AND date <= $3::timestamp AND drive_id = ANY($4)
           WINDOW w AS (PARTITION BY drive_id ORDER BY date)),
         seg AS (
           SELECT drive_id, (COALESCE(speed, ps, 0) + COALESCE(ps, speed, 0)) / 2.0 AS v,
                  (12742.0 * asin(least(1.0, sqrt(power(sin(radians(la - pla) / 2), 2) + cos(radians(pla)) * cos(radians(la)) * power(sin(radians(lo - plo) / 2), 2)))))::float8 AS km, EXTRACT(EPOCH FROM date - pd)::float8 AS dt,
                  CASE WHEN power IS NOT NULL AND pp IS NOT NULL THEN (power + pp) / 2.0 * EXTRACT(EPOCH FROM date - pd) / 3600.0 END::float8 AS kwh
           FROM p WHERE pd IS NOT NULL AND date - pd < interval '10 minutes' AND pla IS NOT NULL)
         SELECT drive_id::int8 AS drive_id, (CASE WHEN v < 40 THEN 0 WHEN v <= 80 THEN 1 ELSE 2 END)::int4 AS band,
                COALESCE(sum(km), 0)::float8 AS dist_km, COALESCE(sum(km) FILTER (WHERE kwh IS NOT NULL), 0)::float8 AS dist_pw_km,
                COALESCE(sum(kwh), 0)::float8 AS pw_kwh, COALESCE(sum(dt), 0)::float8 AS dt_s
         FROM seg GROUP BY 1, 2")
        .bind(car as i16).bind(&t0).bind(&t1).bind(&ids).fetch_all(&s.db).await?;
    let totals: HashMap<i64, (f64, f64)> = sqlx::query_as::<_, (i64, Option<f64>, Option<f64>)>(
        "SELECT d.id::int8, GREATEST((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency, 0)::float8, d.distance::float8
         FROM drives d JOIN cars c ON c.id = d.car_id WHERE d.id = ANY($1)").bind(&ids).fetch_all(&s.db).await?
        .into_iter().map(|(i, e, d)| (i, (e.unwrap_or(0.0), d.unwrap_or(0.0)))).collect();
    let mut by_drive: HashMap<i64, Vec<&BandRow>> = HashMap::new();
    for r in &rows { by_drive.entry(r.drive_id).or_default().push(r); }
    let (mut dist, mut energy, mut dur) = ([0.0f64; 3], [0.0f64; 3], [0.0f64; 3]);
    let mut measured_km = 0.0;
    for (d, rs) in by_drive {
        let (te, tdist) = totals.get(&d).copied().unwrap_or((0.0, 0.0));
        let (pk, pkm): (f64, f64) = rs.iter().fold((0.0, 0.0), |a, r| (a.0 + r.pw_kwh, a.1 + r.dist_pw_km));
        let segkm: f64 = rs.iter().map(|r| r.dist_km).sum();
        let rate = if pkm > 1.0 && pk > 0.0 { pk / pkm } else if tdist > 0.0 { te / tdist } else { 0.0 };
        measured_km += pkm;
        let est: Vec<f64> = rs.iter().map(|r| r.pw_kwh + (r.dist_km - r.dist_pw_km) * rate).collect();
        let sum: f64 = est.iter().sum();
        let scale = if te > 0.0 && sum > 0.0 { te / sum } else { 1.0 };
        // odometer distance may differ slightly from the drive's distance: scale too
        let dscale = if tdist > 0.0 && segkm > 0.0 { tdist / segkm } else { 1.0 };
        for (r, e) in rs.iter().zip(est) {
            let b = r.band.clamp(0, 2) as usize;
            dist[b] += r.dist_km * dscale; energy[b] += e * scale; dur[b] += r.dt_s;
        }
    }
    let total_km: f64 = dist.iter().sum();
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    let names = [("city", "市区"), ("suburb", "郊外"), ("highway", "高速")];
    let bands: Vec<Band> = (0..3).map(|b| Band {
        key: names[b].0, label: names[b].1, distance_km: r1(dist[b]), energy_kwh: (energy[b] * 100.0).round() / 100.0,
        wh_km: (dist[b] >= 0.5).then(|| (energy[b] * 1000.0 / dist[b]).round()), duration_min: r1(dur[b] / 60.0),
        share: if total_km > 0.0 { (dist[b] / total_km * 1000.0).round() / 10.0 } else { 0.0 },
    }).collect();
    let method = if total_km > 0.0 && measured_km / total_km > 0.5 { "power" } else if measured_km > 0.0 { "mixed" } else { "distance" };
    Ok(Json(serde_json::json!({"bands": bands, "method": method, "thresholds_kmh": [40, 80]})).into_response())
}

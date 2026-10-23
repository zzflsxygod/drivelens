// DriveLens - a companion app for TeslaMate.
// Copyright (C) 2026 zzflsxygod
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
// for more details. You should have received a copy of it along with this
// program (the LICENSE file); if not, see <https://www.gnu.org/licenses/>.

//! DriveLens API: reads TeslaMate data. All numeric/timestamp columns are cast in SQL
//! (float8 / ISO8601 text) so the code is robust to TeslaMate's numeric & timestamp types.
use axum::{
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, FromRow, PgPool};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

mod summary;
mod report;
mod journey;
mod phase2;
mod insights;
mod push;
mod auth;

#[derive(Clone)]
struct AppState {
    db: PgPool,
    /// drivelens.charge_costs exists (checked lazily; once true it stays true)
    costs_ok: Arc<std::sync::atomic::AtomicBool>,
    journeys_ok: Arc<std::sync::atomic::AtomicBool>,
    dismiss_ok: Arc<std::sync::atomic::AtomicBool>,
    cover_ok: Arc<std::sync::atomic::AtomicBool>,
    weather_ok: Arc<std::sync::atomic::AtomicBool>,
    push_ok: Arc<std::sync::atomic::AtomicBool>,
    /// VAPID key pair (env override or generated once and stored in drivelens.push_state)
    vapid: Arc<tokio::sync::RwLock<Option<Arc<push::Vapid>>>>,
    /// Web Push deliveries only (see push::push_client: no redirects, public addresses only)
    http: reqwest::Client,
    /// owner key, device-token index and failure limits (see auth.rs)
    auth: Arc<auth::AuthState>,
}

/// Is the optional manual-cost table available? Re-checked until it appears, so re-running
/// drivelens-init.sql takes effect without restarting the API.
pub(crate) async fn costs_ok(s: &AppState) -> Result<bool, ApiError> {
    use std::sync::atomic::Ordering;
    if s.costs_ok.load(Ordering::Relaxed) { return Ok(true); }
    let t: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.charge_costs')::text").fetch_one(&s.db).await?;
    let ok = t.is_some() && sqlx::query_scalar::<_, bool>(
        "SELECT has_table_privilege('drivelens.charge_costs', 'SELECT,INSERT,UPDATE,DELETE')").fetch_one(&s.db).await?;
    if ok { s.costs_ok.store(true, Ordering::Relaxed); }
    Ok(ok)
}

/// Currency guessed from the charge location: TeslaMate's addresses.country (localized name
/// or English), then a Japan bounding box on the position. NULL = unknown (client default).
pub(crate) const LOC_CURRENCY: &str = r#"(CASE
    WHEN a.country ILIKE ANY (ARRAY['japan','日本%','jp']) THEN 'JPY'
    WHEN a.country ILIKE ANY (ARRAY['china','中国','中华人民共和国','cn']) THEN 'CNY'
    WHEN a.country ILIKE ANY (ARRAY['taiwan','台湾','臺灣','台灣']) THEN 'TWD'
    WHEN a.country ILIKE ANY (ARRAY['hong kong','香港%']) THEN 'HKD'
    WHEN a.country ILIKE ANY (ARRAY['south korea','korea%','大韩民国','韓国','대한민국']) THEN 'KRW'
    WHEN a.country ILIKE ANY (ARRAY['united states%','usa','美国','アメリカ合衆国']) THEN 'USD'
    WHEN a.country ILIKE ANY (ARRAY['united kingdom','英国','イギリス']) THEN 'GBP'
    WHEN a.country ILIKE ANY (ARRAY['canada','加拿大','カナダ']) THEN 'CAD'
    WHEN a.country ILIKE ANY (ARRAY['australia','澳大利亚','オーストラリア']) THEN 'AUD'
    WHEN a.country ILIKE ANY (ARRAY['singapore','新加坡','シンガポール']) THEN 'SGD'
    WHEN a.country ILIKE ANY (ARRAY['switzerland','schweiz%','suisse','瑞士','スイス']) THEN 'CHF'
    WHEN a.country ILIKE ANY (ARRAY['germany','deutschland','france','italia','italy','españa','spain','nederland','netherlands','belgi%','österreich','austria','portugal','suomi%','finland','ireland','éire%','ελλάδα','greece','德国','法国','意大利','西班牙','荷兰','ドイツ','フランス','イタリア','スペイン']) THEN 'EUR'
    WHEN a.country IS NULL AND p.latitude BETWEEN 24 AND 45.6 AND p.longitude BETWEEN 129 AND 146 THEN 'JPY'
    ELSE NULL END)"#;


struct ApiError(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self { ApiError(e.into()) }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::error!("{:#}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "internal error"}))).into_response()
    }
}
type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Deserialize)]
struct ListParams {
    car_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
    #[serde(skip)]
    id: Option<i64>,
    /// keyset cursor "<start_date ISO>~<id>" (exclusive); a bare date (e.g. month jump) is allowed
    before: Option<String>,
    /// paged=true → {items, next_cursor}; otherwise a plain array (compatibility)
    paged: Option<bool>,
}
impl ListParams {
    /// (timestamp text without zone, id) for keyset pagination
    fn cursor(&self) -> (Option<String>, i32) {
        let Some(b) = self.before.as_deref().filter(|b| !b.is_empty()) else { return (None, i32::MAX) };
        let (d, id) = match b.rsplit_once('~') { Some((d, i)) => (d, i.parse().unwrap_or(i32::MAX)), None => (b, i32::MAX) };
        (Some(d.to_string()), id)
    }
    fn limit(&self) -> i64 { self.limit.unwrap_or(50).clamp(1, 500) }
    fn offset(&self) -> i64 { self.offset.unwrap_or(0).max(0) }
}

const TS: &str = "YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"";

#[derive(Serialize, FromRow)]
struct Car {
    id: i64,
    name: Option<String>,
    model: Option<String>,
    marketing_name: Option<String>,
    vin: Option<String>,
    efficiency: Option<f64>,
}

#[derive(Serialize, FromRow)]
struct ChargeSummary {
    id: i64,
    car_id: i64,
    start_date: Option<String>,
    end_date: Option<String>,
    address: Option<String>,
    geofence: Option<String>,
    address_id: Option<i64>,
    /// user-defined alias (if any); already applied to `address`
    alias: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    charge_energy_added: Option<f64>,
    charge_energy_used: Option<f64>,
    /// effective cost: manual entry > TeslaMate cost
    cost: Option<f64>,
    /// ISO 4217; NULL for a TeslaMate cost at an unknown location (client applies its default)
    currency: Option<String>,
    /// 'manual' | 'teslamate' | NULL
    cost_source: Option<String>,
    cost_note: Option<String>,
    teslamate_cost: Option<f64>,
    /// currency guessed from the charge location (for the entry dialog)
    default_currency: Option<String>,
    start_battery_level: Option<i32>,
    end_battery_level: Option<i32>,
    duration_min: Option<i32>,
    outside_temp_avg: Option<f64>,
}

#[derive(Serialize, FromRow)]
struct ChargePoint {
    date: Option<String>,
    battery_level: Option<i32>,
    charge_energy_added: Option<f64>,
    charger_power: Option<i32>,
    charger_voltage: Option<i32>,
    charger_actual_current: Option<i32>,
    charger_phases: Option<i32>,
    fast_charger_present: Option<bool>,
    /// Best-effort charging power in kW (see `fill_power`)
    #[sqlx(default)]
    power_kw: Option<f64>,
    /// "reported" | "voltage_current" | "energy_delta"
    #[sqlx(default)]
    power_source: Option<String>,
    #[serde(skip)]
    #[sqlx(default)]
    epoch: Option<f64>,
}

/// TeslaMate stores `charger_power` as reported by the car (0 when the API returned null).
/// On some cars / API paths it stays 0 for the whole session (seen especially on DC fast charging,
/// where charger_voltage/current describe the idle onboard AC charger, e.g. ~2 V / 0 A).
/// Fallbacks: AC voltage × current × phases, then the slope of charge_energy_added over time.
fn fill_power(points: &mut [ChargePoint]) {
    // If the car reported power at all during this session, trust it (a 0 then really means "not charging").
    let reported = points.iter().any(|p| p.charger_power.unwrap_or(0) > 0);
    for i in 0..points.len() {
        let p = &points[i];
        let (power, src) = if reported {
            (p.charger_power.map(|v| v.max(0) as f64), "reported")
        } else if p.charger_power.unwrap_or(0) > 0 {
            (Some(p.charger_power.unwrap() as f64), "reported")
        } else if !p.fast_charger_present.unwrap_or(false)
            && p.charger_voltage.unwrap_or(0) > 50 && p.charger_actual_current.unwrap_or(0) > 0 {
            let phases = p.charger_phases.filter(|&ph| ph >= 1 && ph <= 3).unwrap_or(1) as f64;
            (Some(p.charger_voltage.unwrap() as f64 * p.charger_actual_current.unwrap() as f64 * phases / 1000.0), "voltage_current")
        } else {
            // energy slope over a window of neighbours (energy is reported with 0.01 kWh resolution)
            let lo = i.saturating_sub(2);
            let hi = (i + 2).min(points.len() - 1);
            match (points[lo].epoch, points[hi].epoch, points[lo].charge_energy_added, points[hi].charge_energy_added) {
                (Some(t0), Some(t1), Some(e0), Some(e1)) if t1 - t0 >= 20.0 && e1 >= e0 =>
                    (Some((e1 - e0) / ((t1 - t0) / 3600.0)), "energy_delta"),
                _ => (None, "energy_delta"),
            }
        };
        points[i].power_kw = power.map(|v| (v * 10.0).round() / 10.0);
        points[i].power_source = power.map(|_| src.to_string());
    }
}

#[derive(Serialize)]
struct ChargeDetail {
    #[serde(flatten)]
    summary: ChargeSummary,
    points: Vec<ChargePoint>,
}

#[derive(Serialize, FromRow)]
struct Drive {
    id: i64,
    car_id: i64,
    start_date: Option<String>,
    end_date: Option<String>,
    start_address: Option<String>,
    end_address: Option<String>,
    start_address_id: Option<i64>,
    end_address_id: Option<i64>,
    start_alias: Option<String>,
    end_alias: Option<String>,
    distance_km: Option<f64>,
    duration_min: Option<i32>,
    speed_max: Option<i32>,
    start_battery_level: Option<i32>,
    end_battery_level: Option<i32>,
    /// kWh consumed (estimated from rated range * car efficiency, same as TeslaMate's Grafana)
    energy_kwh: Option<f64>,
    /// Wh/km
    efficiency_wh_km: Option<f64>,
    outside_temp_avg: Option<f64>,
    /// journey this drive belongs to (absent when the journeys tables are not installed)
    start_lat: Option<f64>,
    start_lng: Option<f64>,
    end_lat: Option<f64>,
    end_lng: Option<f64>,
    #[sqlx(default)]
    journey_id: Option<i64>,
    #[sqlx(default)]
    journey_name: Option<String>,
}

#[derive(Serialize, FromRow)]
struct PathPoint {
    date: Option<String>,
    lat: f64,
    lng: f64,
    speed: Option<i32>,
    elevation: Option<i32>,
    battery_level: Option<i32>,
}

pub(crate) fn charge_select(costs: bool) -> String {
    let (cost_cols, cost_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)::float8 AS cost,
          CASE WHEN cc.amount IS NOT NULL THEN cc.currency::text WHEN cp.cost IS NOT NULL THEN LOCCUR END AS currency,
          CASE WHEN cc.amount IS NOT NULL THEN 'manual' WHEN cp.cost IS NOT NULL THEN 'teslamate' END AS cost_source,
          cc.note AS cost_note,", "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else {
        ("cp.cost::float8 AS cost,
          CASE WHEN cp.cost IS NOT NULL THEN LOCCUR END AS currency,
          CASE WHEN cp.cost IS NOT NULL THEN 'teslamate' END AS cost_source,
          NULL::text AS cost_note,", "")
    };
    let cost_cols = cost_cols.replace("LOCCUR", LOC_CURRENCY);
    format!(
        r#"SELECT cp.id::int8 AS id, cp.car_id::int8 AS car_id,
          to_char(cp.start_date, '{TS}') AS start_date, to_char(cp.end_date, '{TS}') AS end_date,
          COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city)) AS address,
          g.name AS geofence, cp.address_id::int8 AS address_id, al.name AS alias,
          p.latitude::float8 AS latitude, p.longitude::float8 AS longitude,
          cp.charge_energy_added::float8 AS charge_energy_added,
          cp.charge_energy_used::float8 AS charge_energy_used,
          {cost_cols} cp.cost::float8 AS teslamate_cost, {LOC_CURRENCY} AS default_currency,
          cp.start_battery_level::int4 AS start_battery_level, cp.end_battery_level::int4 AS end_battery_level,
          cp.duration_min::int4 AS duration_min, cp.outside_temp_avg::float8 AS outside_temp_avg
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        LEFT JOIN drivelens.address_aliases al ON al.address_id = cp.address_id
        LEFT JOIN geofences g ON g.id = cp.geofence_id
        LEFT JOIN positions p ON p.id = cp.position_id
        {cost_join}"#
    )
}

/// Bump when endpoints are added or changed (the app gates features on it).
/// 3 = split home endpoints (v0.3.1) · 4 = charge power_kw (v0.3.2) · 5 = manual costs (v0.4.0)
/// 6 = monthly report (v0.5.0) · 7 = JSON /health with version (v0.5.1) · 8 = journeys (v0.6.0) · 9 = dismiss suggestions (v0.6.1) · 10 = keyset paging + /cars/:id/months (v0.6.2) · 11 = journey cover, weather, speed bands (v0.7.0) · 12 = battery degradation, report footprint + 12-month trends (v0.9.0) · 13 = web push (v0.12.0) · 14 = TeslaMate-identical battery health, /battery `tm` (v0.13.0) · 15 = device auth: /api/auth/*, device tokens, pairing codes, read-only devices (v0.14.0)
pub(crate) const API_LEVEL: u32 = 15;

/// Unauthenticated and DB-free (cheap; also used as the container health/version probe).
/// {items, next_cursor} when ?paged=true, else the plain array (old clients).
fn paged<T: Serialize>(rows: Vec<T>, limit: i64, paged: bool, key: impl Fn(&T) -> String) -> Response {
    if !paged { return Json(rows).into_response(); }
    let next = (rows.len() as i64 == limit).then(|| rows.last().map(&key)).flatten();
    Json(serde_json::json!({"items": rows, "next_cursor": next})).into_response()
}
async fn drives_route(State(s): State<AppState>, Query(q): Query<ListParams>) -> Result<Response, ApiError> {
    let (limit, pg) = (q.limit(), q.paged.unwrap_or(false));
    let Json(rows) = list_drives(State(s), Query(q)).await?;
    Ok(paged(rows, limit, pg, |d| format!("{}~{}", d.start_date.clone().unwrap_or_default(), d.id)))
}
async fn charges_route(State(s): State<AppState>, Query(q): Query<ListParams>) -> Result<Response, ApiError> {
    let (limit, pg) = (q.limit(), q.paged.unwrap_or(false));
    let Json(rows) = list_charges(State(s), Query(q)).await?;
    Ok(paged(rows, limit, pg, |c| format!("{}~{}", c.start_date.clone().unwrap_or_default(), c.id)))
}

#[derive(Deserialize)]
struct MonthsParams { tz: Option<String> }
#[derive(Serialize, FromRow)]
struct MonthRow { month: String, drive_count: i64, distance_km: f64, duration_min: i64, charge_count: i64, energy_added_kwh: f64 }

/// Per-month totals (user's tz) for list section headers and the month picker.
async fn car_months(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<MonthsParams>) -> Result<Response, ApiError> {
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let r = sqlx::query_as::<_, MonthRow>(
        "WITH d AS (SELECT to_char((start_date AT TIME ZONE 'UTC') AT TIME ZONE $2, 'YYYY-MM') AS month, count(*) AS n,
                      COALESCE(sum(distance), 0)::float8 AS km, COALESCE(sum(duration_min), 0)::int8 AS dur
                    FROM drives WHERE car_id = $1 AND end_date IS NOT NULL GROUP BY 1),
              c AS (SELECT to_char((start_date AT TIME ZONE 'UTC') AT TIME ZONE $2, 'YYYY-MM') AS month, count(*) AS n,
                      COALESCE(sum(charge_energy_added), 0)::float8 AS kwh
                    FROM charging_processes WHERE car_id = $1 AND end_date IS NOT NULL GROUP BY 1)
         SELECT COALESCE(d.month, c.month) AS month, COALESCE(d.n, 0)::int8 AS drive_count, round(COALESCE(d.km, 0)::numeric, 1)::float8 AS distance_km,
                COALESCE(d.dur, 0)::int8 AS duration_min, COALESCE(c.n, 0)::int8 AS charge_count, round(COALESCE(c.kwh, 0)::numeric, 1)::float8 AS energy_added_kwh
         FROM d FULL JOIN c ON c.month = d.month ORDER BY 1 DESC").bind(id).bind(&tz).fetch_all(&s.db).await;
    Ok(match r {
        Ok(rows) => Json(rows).into_response(),
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => bad(StatusCode::BAD_REQUEST, "unknown tz"),
        Err(e) => return Err(e.into()),
    })
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok", "version": env!("CARGO_PKG_VERSION"), "api_level": API_LEVEL}))
}

/// Authenticated variant: also checks the database connection.
async fn health_full(State(s): State<AppState>) -> Response {
    let db = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&s.db).await.is_ok();
    let code = if db { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, Json(serde_json::json!({"status": if db {"ok"} else {"db_error"}, "version": env!("CARGO_PKG_VERSION"),
        "api_level": API_LEVEL, "database": db, "manual_costs": costs_ok(&s).await.unwrap_or(false),
        "journeys": journey::tables_ok(&s).await.unwrap_or(false),
        "suggestion_dismissal": journey::dismiss_ok(&s).await.unwrap_or(false),
        "journey_cover": phase2::cover_ok(&s).await.unwrap_or(false), "weather": phase2::weather_ok(&s).await.unwrap_or(false),
        "web_push": push::push_ok(&s).await.unwrap_or(false)}))).into_response()
}

async fn list_cars(State(s): State<AppState>) -> ApiResult<Vec<Car>> {
    let rows = sqlx::query_as::<_, Car>(
        "SELECT id::int8 AS id, name, model, marketing_name, vin, efficiency::float8 AS efficiency FROM cars ORDER BY display_priority, id",
    ).fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn list_charges(State(s): State<AppState>, Query(q): Query<ListParams>) -> ApiResult<Vec<ChargeSummary>> {
    let sql = format!(
        "{} WHERE ($1::int8 IS NULL OR cp.car_id = $1) AND cp.end_date IS NOT NULL
           AND ($4::timestamptz IS NULL OR (cp.start_date, cp.id) < (($4::timestamptz AT TIME ZONE 'UTC'), $5::int4))
         ORDER BY cp.start_date DESC, cp.id DESC LIMIT $2 OFFSET $3",
        charge_select(costs_ok(&s).await?)
    );
    let (before, bid) = q.cursor();
    let rows = sqlx::query_as::<_, ChargeSummary>(&sql)
        .bind(q.car_id).bind(q.limit()).bind(q.offset()).bind(before).bind(bid)
        .fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn get_charge(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    let sql = format!("{} WHERE cp.id = $1", charge_select(costs_ok(&s).await?));
    let Some(summary) = sqlx::query_as::<_, ChargeSummary>(&sql).bind(id).fetch_optional(&s.db).await? else {
        return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response());
    };
    let points = sqlx::query_as::<_, ChargePoint>(&format!(
        r#"SELECT to_char(date, '{TS}') AS date, battery_level::int4 AS battery_level,
             charge_energy_added::float8 AS charge_energy_added, charger_power::int4 AS charger_power,
             charger_voltage::int4 AS charger_voltage, charger_actual_current::int4 AS charger_actual_current,
             charger_phases::int4 AS charger_phases, fast_charger_present,
             extract(epoch from charges.date)::float8 AS epoch
           FROM charges WHERE charging_process_id = $1 ORDER BY charges.date"#
    )).bind(id).fetch_all(&s.db).await?;
    let mut points = points;
    fill_power(&mut points);
    Ok(Json(ChargeDetail { summary, points }).into_response())
}

/// Drive columns + joins (no WHERE). With `journeys`, also the journey id/name of each drive.
pub(crate) fn drive_select(journeys: bool) -> String {
    let (jcols, jjoin) = if journeys {
        (", jd.journey_id::int8 AS journey_id, j.name AS journey_name",
         "LEFT JOIN drivelens.journey_drives jd ON jd.drive_id = d.id LEFT JOIN drivelens.journeys j ON j.id = jd.journey_id")
    } else { ("", "") };
    format!(
        r#"SELECT d.id::int8 AS id, d.car_id::int8 AS car_id,
             to_char(d.start_date, '{TS}') AS start_date, to_char(d.end_date, '{TS}') AS end_date,
             COALESCE(sal.name, gs.name, CONCAT_WS(', ', COALESCE(sa.name, NULLIF(CONCAT_WS(' ', sa.road, sa.house_number), '')), sa.city)) AS start_address,
             COALESCE(eal.name, ge.name, CONCAT_WS(', ', COALESCE(ea.name, NULLIF(CONCAT_WS(' ', ea.road, ea.house_number), '')), ea.city)) AS end_address,
             d.start_address_id::int8 AS start_address_id, d.end_address_id::int8 AS end_address_id,
             sal.name AS start_alias, eal.name AS end_alias,
             d.distance::float8 AS distance_km, d.duration_min::int4 AS duration_min, d.speed_max::int4 AS speed_max,
             sp.battery_level::int4 AS start_battery_level, ep.battery_level::int4 AS end_battery_level,
             ((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::float8 AS energy_kwh,
             CASE WHEN d.distance > 0 THEN ((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency * 1000 / d.distance)::float8 END AS efficiency_wh_km,
             d.outside_temp_avg::float8 AS outside_temp_avg,
             sp.latitude::float8 AS start_lat, sp.longitude::float8 AS start_lng,
             ep.latitude::float8 AS end_lat, ep.longitude::float8 AS end_lng{jcols}
           FROM drives d
           JOIN cars c ON c.id = d.car_id
           LEFT JOIN addresses sa ON sa.id = d.start_address_id
           LEFT JOIN addresses ea ON ea.id = d.end_address_id
           LEFT JOIN drivelens.address_aliases sal ON sal.address_id = d.start_address_id
           LEFT JOIN drivelens.address_aliases eal ON eal.address_id = d.end_address_id
           LEFT JOIN geofences gs ON gs.id = d.start_geofence_id
           LEFT JOIN geofences ge ON ge.id = d.end_geofence_id
           LEFT JOIN positions sp ON sp.id = d.start_position_id
           LEFT JOIN positions ep ON ep.id = d.end_position_id
           {jjoin}"#
    )
}

async fn list_drives(State(s): State<AppState>, Query(q): Query<ListParams>) -> ApiResult<Vec<Drive>> {
    let sql = format!(
        "{} WHERE ($1::int8 IS NULL OR d.car_id = $1) AND ($4::int8 IS NULL OR d.id = $4) AND d.end_date IS NOT NULL
           AND ($5::timestamptz IS NULL OR (d.start_date, d.id) < (($5::timestamptz AT TIME ZONE 'UTC'), $6::int4))
           ORDER BY d.start_date DESC, d.id DESC LIMIT $2 OFFSET $3",
        drive_select(journey::tables_ok(&s).await?)
    );
    let (before, bid) = q.cursor();
    let rows = sqlx::query_as::<_, Drive>(&sql)
        .bind(q.car_id).bind(q.limit()).bind(q.offset()).bind(q.id).bind(before).bind(bid)
        .fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn get_drive(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    let q = ListParams { car_id: None, limit: Some(1), offset: None, id: Some(id), before: None, paged: None };
    let Json(mut rows) = list_drives(State(s), Query(q)).await?;
    Ok(match rows.pop() {
        Some(d) => Json(d).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response(),
    })
}

#[derive(Serialize, FromRow)]
struct AliasRow {
    address_id: i64,
    name: String,
    original_name: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct AliasBody { name: String }

fn alias_select() -> String {
    format!(
        r#"SELECT al.address_id::int8 AS address_id, al.name,
             COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), ''), a.display_name) AS original_name,
             to_char(al.updated_at AT TIME ZONE 'UTC', '{TS}') AS updated_at
           FROM drivelens.address_aliases al LEFT JOIN addresses a ON a.id = al.address_id"#
    )
}

async fn list_aliases(State(s): State<AppState>) -> ApiResult<Vec<AliasRow>> {
    let rows = sqlx::query_as::<_, AliasRow>(&format!("{} ORDER BY al.name", alias_select()))
        .fetch_all(&s.db).await?;
    Ok(Json(rows))
}

fn bad(code: StatusCode, msg: &str) -> Response {
    (code, Json(serde_json::json!({"error": msg}))).into_response()
}

async fn put_alias(State(s): State<AppState>, Path(id): Path<i64>, Json(b): Json<AliasBody>) -> Result<Response, ApiError> {
    let name = b.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Ok(bad(StatusCode::BAD_REQUEST, "name must be 1-200 characters"));
    }
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM addresses WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    if exists.is_none() { return Ok(bad(StatusCode::NOT_FOUND, "address not found")); }
    sqlx::query(
        "INSERT INTO drivelens.address_aliases (address_id, name, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (address_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
    ).bind(id as i32).bind(name).execute(&s.db).await?;
    let row = sqlx::query_as::<_, AliasRow>(&format!("{} WHERE al.address_id = $1", alias_select()))
        .bind(id as i32).fetch_one(&s.db).await?;
    Ok(Json(row).into_response())
}

async fn delete_alias(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    let r = sqlx::query("DELETE FROM drivelens.address_aliases WHERE address_id = $1").bind(id as i32).execute(&s.db).await?;
    Ok(if r.rows_affected() == 0 { bad(StatusCode::NOT_FOUND, "no alias") } else { StatusCode::NO_CONTENT.into_response() })
}

#[derive(Deserialize)]
struct CostBody { amount: f64, currency: String, note: Option<String> }

const COSTS_MISSING: &str = "manual cost table drivelens.charge_costs is missing or not writable; run deploy/setup.sql and restart the API (see docs/install.md)";

async fn charge_response(s: &AppState, id: i64) -> Result<Response, ApiError> {
    let sql = format!("{} WHERE cp.id = $1", charge_select(costs_ok(s).await?));
    Ok(match sqlx::query_as::<_, ChargeSummary>(&sql).bind(id).fetch_optional(&s.db).await? {
        Some(c) => Json(c).into_response(),
        None => bad(StatusCode::NOT_FOUND, "charge not found"),
    })
}

async fn put_cost(State(s): State<AppState>, Path(id): Path<i64>, Json(b): Json<CostBody>) -> Result<Response, ApiError> {
    if !costs_ok(&s).await? { return Ok(bad(StatusCode::SERVICE_UNAVAILABLE, COSTS_MISSING)); }
    if !b.amount.is_finite() || b.amount < 0.0 || b.amount >= 1e9 {
        return Ok(bad(StatusCode::BAD_REQUEST, "amount must be 0..1e9"));
    }
    let cur = b.currency.trim().to_ascii_uppercase();
    if cur.len() != 3 || !cur.bytes().all(|c| c.is_ascii_uppercase()) {
        return Ok(bad(StatusCode::BAD_REQUEST, "currency must be a 3-letter ISO 4217 code"));
    }
    let note = b.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if note.map_or(false, |n| n.chars().count() > 500) { return Ok(bad(StatusCode::BAD_REQUEST, "note too long")); }
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM charging_processes WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    if exists.is_none() { return Ok(bad(StatusCode::NOT_FOUND, "charge not found")); }
    sqlx::query(
        "INSERT INTO drivelens.charge_costs (charging_process_id, amount, currency, note, updated_at)
         VALUES ($1, $2::float8::numeric(12,2), $3, $4, now())
         ON CONFLICT (charging_process_id) DO UPDATE
         SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, note = EXCLUDED.note, updated_at = now()",
    ).bind(id as i32).bind(b.amount).bind(&cur).bind(note).execute(&s.db).await?;
    charge_response(&s, id).await
}

async fn delete_cost(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    if !costs_ok(&s).await? { return Ok(bad(StatusCode::SERVICE_UNAVAILABLE, COSTS_MISSING)); }
    sqlx::query("DELETE FROM drivelens.charge_costs WHERE charging_process_id = $1").bind(id as i32).execute(&s.db).await?;
    // idempotent: returns the charge with the TeslaMate cost (if any) now in effect
    charge_response(&s, id).await
}

const SETUP_HINT: &str = "run deploy/setup.sql once as the TeslaMate DB admin (see docs/install.md)";

/// Our own schema; TeslaMate's tables are never modified. Idempotent and never fatal:
/// - fresh install (setup.sql made the API role owner of / CREATE on schema `drivelens`): everything is created here;
/// - older installs where an admin pre-created the tables and the API role has no CREATE right: every step sees
///   the object already exists and does nothing; anything missing just disables that feature with a log line.
/// (Deliberately not sqlx's migrator: its bookkeeping table would itself need CREATE rights and would conflict
///  with schemas created by the old SQL files.)
async fn migrate(db: &PgPool) -> anyhow::Result<()> {
    let has_schema: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drivelens')").fetch_one(db).await?;
    if !has_schema {
        if let Err(e) = sqlx::query("CREATE SCHEMA IF NOT EXISTS drivelens").execute(db).await {
            tracing::error!("schema drivelens does not exist and cannot be created ({e}); {SETUP_HINT}. Read-only features still work.");
            return Ok(());
        }
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.address_aliases')::text").fetch_one(db).await?;
    if exists.is_none() {
        if let Err(e) = sqlx::query(
            "CREATE TABLE IF NOT EXISTS drivelens.address_aliases (
                address_id integer PRIMARY KEY REFERENCES public.addresses(id) ON DELETE CASCADE,
                name text NOT NULL CHECK (length(btrim(name)) > 0),
                updated_at timestamptz NOT NULL DEFAULT now())",
        ).execute(db).await { tracing::warn!("place aliases disabled: cannot create drivelens.address_aliases ({e}); {SETUP_HINT}"); }
    }
    let has: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.charge_costs')::text").fetch_one(db).await?;
    if has.is_none() {
        if let Err(e) = sqlx::query(
            "CREATE TABLE IF NOT EXISTS drivelens.charge_costs (
                charging_process_id integer PRIMARY KEY REFERENCES public.charging_processes(id) ON DELETE CASCADE,
                amount numeric(12,2) NOT NULL CHECK (amount >= 0),
                currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
                note text,
                updated_at timestamptz NOT NULL DEFAULT now())",
        ).execute(db).await { tracing::warn!("manual charge costs disabled: cannot create drivelens.charge_costs ({e}); {SETUP_HINT}"); }
    }
    journey::try_create_tables(db).await;
    phase2::try_migrate(db).await;
    push::try_migrate(db).await;
    auth::try_migrate(db).await;   // after push: links push_subscriptions to devices
    Ok(())
}

/// One startup line per feature so a misconfigured install is obvious in `docker compose logs drivelens-api`.
async fn log_features(s: &AppState) {
    let teslamate: bool = sqlx::query_scalar("SELECT to_regclass('public.drives') IS NOT NULL AND has_table_privilege('public.drives', 'SELECT')")
        .fetch_one(&s.db).await.unwrap_or(false);
    if !teslamate { tracing::error!("cannot read TeslaMate tables (public.drives); {SETUP_HINT}"); }
    let aliases: bool = sqlx::query_scalar("SELECT to_regclass('drivelens.address_aliases') IS NOT NULL AND has_table_privilege('drivelens.address_aliases', 'SELECT,INSERT,UPDATE,DELETE')")
        .fetch_one(&s.db).await.unwrap_or(false);
    let f = [("teslamate read", teslamate), ("place aliases", aliases),
        ("manual costs", costs_ok(s).await.unwrap_or(false)), ("journeys", journey::tables_ok(s).await.unwrap_or(false)),
        ("suggestion dismissal", journey::dismiss_ok(s).await.unwrap_or(false)),
        ("journey cover", phase2::cover_ok(s).await.unwrap_or(false)), ("weather cache", phase2::weather_ok(s).await.unwrap_or(false)),
        ("web push", push::push_ok(s).await.unwrap_or(false)), ("device auth", s.auth.available())];
    let off: Vec<&str> = f.iter().filter(|x| !x.1).map(|x| x.0).collect();
    if off.is_empty() { tracing::info!("all features enabled (API level {API_LEVEL})"); }
    else { tracing::warn!("disabled features: {} — {SETUP_HINT}", off.join(", ")); }
}

async fn drive_path(State(s): State<AppState>, Path(id): Path<i64>) -> ApiResult<Vec<PathPoint>> {
    let rows = sqlx::query_as::<_, PathPoint>(&format!(
        r#"SELECT to_char(date, '{TS}') AS date, latitude::float8 AS lat, longitude::float8 AS lng,
             speed::int4 AS speed, elevation::int4 AS elevation, battery_level::int4 AS battery_level
           FROM positions WHERE drive_id = $1 ORDER BY positions.date"#
    )).bind(id).fetch_all(&s.db).await?;
    Ok(Json(rows))
}

/// Official hosted web app (PWA). Apps (Tauri) are always allowed as well.
const DEFAULT_WEB_ORIGIN: &str = "https://drivelens-app.oharuru.com";
/// Tauri webview origins: macOS/iOS (tauri://localhost), Windows/Android (http(s)://tauri.localhost).
const TAURI_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// Parsed CORS policy: `None` = any origin, else the explicit list (always incl. the Tauri origins).
/// DRIVELENS_CORS_ORIGINS (or the older CORS_ORIGINS): comma-separated origins, `*` = any origin.
/// Unset → the official web app + Tauri apps. Auth is a bearer token (no cookies), so CORS is about
/// which web pages may use the API from a browser, not about authentication.
fn cors_origins(raw: Option<String>) -> Option<Vec<String>> {
    let raw = raw.filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_WEB_ORIGIN.to_string());
    let mut list: Vec<String> = Vec::new();
    for o in raw.split(',').map(|o| o.trim().trim_end_matches('/')).filter(|o| !o.is_empty()) {
        if o == "*" { return None; }
        if !list.iter().any(|x| x.eq_ignore_ascii_case(o)) { list.push(o.to_ascii_lowercase()); }
    }
    for t in TAURI_ORIGINS { if !list.iter().any(|x| x == t) { list.push(t.to_string()); } }
    Some(list)
}

fn cors_layer() -> CorsLayer {
    let raw = std::env::var("DRIVELENS_CORS_ORIGINS").ok().filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("CORS_ORIGINS").ok());
    let base = CorsLayer::new()
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::PATCH, axum::http::Method::PUT, axum::http::Method::DELETE, axum::http::Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600))
        // Chrome Private Network Access: lets the https web app reach an https server on a LAN / tailnet address
        .allow_private_network(true);
    match cors_origins(raw) {
        None => { tracing::info!("CORS: any origin"); base.allow_origin(Any) }
        Some(list) => {
            tracing::info!("CORS: allowed origins {}", list.join(", "));
            let vals: Vec<axum::http::HeaderValue> = list.iter().filter_map(|o| match o.parse() {
                Ok(v) => Some(v), Err(_) => { tracing::warn!("CORS: ignoring invalid origin {o:?}"); None } }).collect();
            base.allow_origin(vals)
        }
    }
}

#[cfg(test)]
mod cors_tests {
    use super::*;
    #[test]
    fn default_is_official_web_plus_tauri() {
        let l = cors_origins(None).unwrap();
        assert_eq!(l[0], DEFAULT_WEB_ORIGIN);
        assert!(l.contains(&"tauri://localhost".to_string()) && l.contains(&"http://tauri.localhost".to_string()));
    }
    #[test]
    fn star_means_any() { assert!(cors_origins(Some("https://a.example, *".into())).is_none()); }
    #[test]
    fn custom_list_keeps_tauri_and_dedups() {
        let l = cors_origins(Some(" https://A.example/ ,https://a.example,,tauri://localhost".into())).unwrap();
        assert_eq!(l, vec!["https://a.example", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
    }
    async fn preflight(origin: &str) -> axum::http::Response<axum::body::Body> {
        use tower::ServiceExt;
        let app: Router = Router::new().route("/api/cars", get(|| async { "x" })).layer(cors_layer());
        app.oneshot(axum::http::Request::builder().method("OPTIONS").uri("/api/cars")
            .header("origin", origin).header("access-control-request-method", "GET")
            .header("access-control-request-headers", "authorization")
            .body(axum::body::Body::empty()).unwrap()).await.unwrap()
    }
    #[tokio::test]
    async fn preflight_default_policy() {
        let r = preflight(DEFAULT_WEB_ORIGIN).await;
        let h = r.headers();
        assert_eq!(h.get("access-control-allow-origin").unwrap(), DEFAULT_WEB_ORIGIN);
        assert!(h.get("access-control-allow-headers").unwrap().to_str().unwrap().contains("authorization"));
        assert_eq!(preflight("http://tauri.localhost").await.headers().get("access-control-allow-origin").unwrap(), "http://tauri.localhost");
        assert!(preflight("https://evil.example").await.headers().get("access-control-allow-origin").is_none());
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use auth::{client_key, record_failure, FailMap, FAIL_MAX_KEYS};
    fn req(peer: &str, hdrs: &[(&str, &str)]) -> Request {
        let mut b = axum::http::Request::builder().uri("/api/cars");
        for (k, v) in hdrs { b = b.header(*k, *v); }
        let mut r = b.body(axum::body::Body::empty()).unwrap();
        r.extensions_mut().insert(axum::extract::ConnectInfo::<std::net::SocketAddr>(peer.parse().unwrap()));
        r
    }
    #[test]
    fn headers_ignored_by_default() {
        let r = req("203.0.113.9:5555", &[("cf-connecting-ip", "1.2.3.4"), ("x-forwarded-for", "5.6.7.8")]);
        assert_eq!(client_key(&r, false), "203.0.113.9");
        let r = req("127.0.0.1:5555", &[("cf-connecting-ip", "1.2.3.4")]);
        assert_eq!(client_key(&r, false), "127.0.0.1");
    }
    #[test]
    fn headers_trusted_only_from_local_proxy() {
        assert_eq!(client_key(&req("172.18.0.3:1", &[("cf-connecting-ip", "1.2.3.4")]), true), "1.2.3.4");
        assert_eq!(client_key(&req("127.0.0.1:1", &[("x-forwarded-for", "9.9.9.9, 5.6.7.8")]), true), "5.6.7.8");
        // a public peer cannot pick its own bucket
        assert_eq!(client_key(&req("203.0.113.9:1", &[("cf-connecting-ip", "1.2.3.4")]), true), "203.0.113.9");
        // garbage header values are ignored (no unbounded keys)
        assert_eq!(client_key(&req("127.0.0.1:1", &[("x-forwarded-for", &"a".repeat(5000))]), true), "127.0.0.1");
        assert_eq!(client_key(&req("[2001:db8:1:2:3:4:5:6]:1", &[]), false), "2001:db8:1:2::/64");
    }
    #[test]
    fn map_is_bounded() {
        let m: FailMap = Default::default();
        let now = std::time::Instant::now();
        for i in 0..(FAIL_MAX_KEYS + 500) { record_failure(&m, format!("10.0.{}.{}", i / 256, i % 256), now); }
        assert_eq!(m.lock().unwrap().len(), FAIL_MAX_KEYS + 1);   // + the shared overflow bucket
        assert_eq!(record_failure(&m, "10.0.0.0".into(), now), 2);
    }

    fn test_state(db: PgPool, a: auth::AuthState) -> AppState {
        AppState { db, costs_ok: Arc::new(Default::default()), journeys_ok: Arc::new(Default::default()), dismiss_ok: Arc::new(Default::default()),
            cover_ok: Arc::new(Default::default()), weather_ok: Arc::new(Default::default()), push_ok: Arc::new(Default::default()),
            vapid: Arc::new(Default::default()), http: push::push_client().unwrap(), auth: Arc::new(a) }
    }
    /// The real router, with a lazy (never connected) pool: only routes that need no database are reached.
    fn real_app(a: auth::AuthState) -> Router {
        router(test_state(PgPoolOptions::new().connect_lazy("postgres://nobody@127.0.0.1:1/none").unwrap(), a))
    }

    async fn send(app: &Router, method: &str, path: &str, token: Option<&str>, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
        use tower::ServiceExt;
        let mut b = axum::http::Request::builder().method(method).uri(path).header("user-agent", "drivelens-test");
        if let Some(t) = token { b = b.header("authorization", format!("Bearer {t}")); }
        if body.is_some() { b = b.header("content-type", "application/json"); }
        let r = b.body(body.map_or(axum::body::Body::empty(), |v| axum::body::Body::from(v.to_string()))).unwrap();
        let res = app.clone().oneshot(r).await.unwrap();
        let st = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (st, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    /// Needs a throwaway database with the testdata schema: DRIVELENS_TEST_DATABASE_URL=postgres://… cargo test
    /// (skipped otherwise). Migration twice (idempotent), owner key → device → pairing → read device → revoke.
    #[tokio::test]
    async fn db_device_flow() {
        let Ok(url) = std::env::var("DRIVELENS_TEST_DATABASE_URL") else { eprintln!("db_device_flow skipped: DRIVELENS_TEST_DATABASE_URL is not set"); return };
        let db = PgPoolOptions::new().max_connections(3).connect(&url).await.unwrap();
        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();
        let key = "test-owner-key-0123456789abcdef";
        let a = auth::AuthState::init(db.clone(), key, auth::OwnerKeyMode::Full).await;
        assert!(a.available(), "device auth tables");
        let state = test_state(db.clone(), a);
        let app = router(state.clone());
        let (st, me) = send(&app, "GET", "/api/auth/me", Some(key), None).await;
        assert_eq!((st, me["kind"].as_str(), me["device_auth"].as_bool()), (StatusCode::OK, Some("owner"), Some(true)));
        let (st, v) = send(&app, "POST", "/api/auth/devices", Some(key), Some(serde_json::json!({"name": " db test \u{0007}"}))).await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
        let t1 = v["token"].as_str().unwrap().to_string();
        assert_eq!(v["device"]["name"], "db test");
        assert_eq!(v["device"]["user_agent"], "drivelens-test");
        let id1 = v["device"]["id"].as_i64().unwrap();
        assert_eq!(send(&app, "GET", "/api/cars", Some(&t1), None).await.0, StatusCode::OK);
        // a device cannot exchange the owner key; full devices issue codes
        assert_eq!(send(&app, "POST", "/api/auth/devices", Some(&t1), Some(serde_json::json!({"name": "x"}))).await.0, StatusCode::FORBIDDEN);
        assert_eq!(send(&app, "POST", "/api/auth/pairings", Some(&t1), Some(serde_json::json!({"scope": "full", "device_ttl_days": 7}))).await.0, StatusCode::BAD_REQUEST);
        let (st, v) = send(&app, "POST", "/api/auth/pairings", Some(&t1), Some(serde_json::json!({"scope": "read", "device_ttl_days": 7}))).await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
        let code = v["code"].as_str().unwrap().to_lowercase();
        assert_eq!(code.len(), 9);
        let (st, v) = send(&app, "POST", "/api/auth/pair", None, Some(serde_json::json!({"code": code, "name": "family"}))).await;
        assert_eq!(st, StatusCode::CREATED, "{v}");
        let t2 = v["token"].as_str().unwrap().to_string();
        let id2 = v["device"]["id"].as_i64().unwrap();
        assert_eq!(v["device"]["scope"], "read");
        assert!(v["device"]["expires_at"].is_string());
        let (st, v) = send(&app, "POST", "/api/auth/pair", None, Some(serde_json::json!({"code": code, "name": "again"}))).await;
        assert_eq!((st, v["code"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_code")), "single use");
        assert_eq!(send(&app, "GET", "/api/cars", Some(&t2), None).await.0, StatusCode::OK);
        let (st, v) = send(&app, "PUT", "/api/addresses/1/alias", Some(&t2), Some(serde_json::json!({"name": "x"}))).await;
        assert_eq!((st, v["code"].as_str()), (StatusCode::FORBIDDEN, Some("read_only")));
        assert_eq!(send(&app, "GET", "/api/auth/devices", Some(&t2), None).await.0, StatusCode::FORBIDDEN);
        let (st, list) = send(&app, "GET", "/api/auth/devices", Some(&t1), None).await;
        assert_eq!(st, StatusCode::OK);
        let list = list.as_array().unwrap();
        assert!(list.iter().any(|d| d["id"] == id1 && d["current"] == true));
        assert!(list.iter().any(|d| d["id"] == id2 && d["current"] == false));
        let (st, v) = send(&app, "PATCH", "/api/auth/devices/current", Some(&t2), Some(serde_json::json!({"name": "family iPad"}))).await;
        assert_eq!((st, v["name"].as_str()), (StatusCode::OK, Some("family iPad")));
        assert_eq!(send(&app, "DELETE", &format!("/api/auth/devices/{id2}"), Some(&t1), None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(send(&app, "GET", "/api/cars", Some(&t2), None).await.0, StatusCode::UNAUTHORIZED, "revoked at once");
        // a reload from the database (as after a restart) keeps device 1 and does not bring device 2 back
        state.auth.refresh(&db).await;
        assert_eq!(send(&app, "GET", "/api/cars", Some(&t1), None).await.0, StatusCode::OK);
        assert_eq!(send(&app, "GET", "/api/cars", Some(&t2), None).await.0, StatusCode::UNAUTHORIZED);
        let fresh = router(test_state(db.clone(), auth::AuthState::init(db.clone(), key, auth::OwnerKeyMode::Full).await));
        assert_eq!(send(&fresh, "GET", "/api/cars", Some(&t1), None).await.0, StatusCode::OK, "after restart");
        assert_eq!(send(&app, "DELETE", "/api/auth/devices/current", Some(&t1), None).await.0, StatusCode::NO_CONTENT);
        assert_eq!(send(&app, "GET", "/api/cars", Some(&t1), None).await.0, StatusCode::UNAUTHORIZED);
    }

    /// Every route of the real router: only POST /api/auth/pair is reachable without Authorization.
    #[tokio::test]
    async fn only_pair_is_public() {
        use tower::ServiceExt;
        let routes = [("GET", "/api/health"), ("GET", "/api/cars"), ("GET", "/api/cars/1/summary"), ("GET", "/api/cars/1/status"),
            ("GET", "/api/cars/1/last-activity"), ("GET", "/api/cars/1/stats"), ("GET", "/api/cars/1/report"), ("GET", "/api/cars/1/trends"),
            ("GET", "/api/cars/1/footprint"), ("GET", "/api/cars/1/battery"), ("GET", "/api/charges"), ("GET", "/api/charges/1"),
            ("PUT", "/api/charges/1/cost"), ("DELETE", "/api/charges/1/cost"), ("GET", "/api/drives"), ("GET", "/api/cars/1/months"),
            ("GET", "/api/journeys"), ("POST", "/api/journeys"), ("GET", "/api/journeys/suggestions"), ("POST", "/api/journeys/suggestions/dismiss"),
            ("DELETE", "/api/journeys/suggestions/dismissed"), ("GET", "/api/journeys/1"), ("PATCH", "/api/journeys/1"), ("DELETE", "/api/journeys/1"),
            ("PUT", "/api/journeys/1/drives"), ("GET", "/api/journeys/1/path"), ("GET", "/api/journeys/1/cover"), ("PUT", "/api/journeys/1/cover"),
            ("DELETE", "/api/journeys/1/cover"), ("GET", "/api/journeys/1/weather"), ("GET", "/api/journeys/1/speed-bands"), ("GET", "/api/drives/1"),
            ("GET", "/api/drives/1/path"), ("GET", "/api/push/key"), ("POST", "/api/push/subscription"), ("POST", "/api/push/subscription/status"),
            ("POST", "/api/push/unsubscribe"), ("POST", "/api/push/test"), ("GET", "/api/addresses/aliases"), ("PUT", "/api/addresses/1/alias"),
            ("DELETE", "/api/addresses/1/alias"), ("GET", "/api/auth/me"), ("GET", "/api/auth/devices"), ("POST", "/api/auth/devices"),
            ("DELETE", "/api/auth/devices?except=current"), ("PATCH", "/api/auth/devices/current"), ("DELETE", "/api/auth/devices/current"),
            ("PATCH", "/api/auth/devices/3"), ("DELETE", "/api/auth/devices/3"), ("POST", "/api/auth/pairings")];
        for (i, (m, p)) in routes.iter().enumerate() {
            let app = real_app(auth::AuthState::for_tests(&"k".repeat(32), auth::OwnerKeyMode::Full, false));
            let mut r = axum::http::Request::builder().method(*m).uri(*p).body(axum::body::Body::empty()).unwrap();
            // a fresh client address per request, so the failure limit (429) does not kick in
            r.extensions_mut().insert(axum::extract::ConnectInfo::<std::net::SocketAddr>(format!("10.1.{}.{}:1", i / 200, i % 200).parse().unwrap()));
            assert_eq!(app.oneshot(r).await.unwrap().status(), StatusCode::UNAUTHORIZED, "{m} {p}");
        }
        // the public pairing route is reached (no 401): without device auth it answers 503 device_auth_unavailable
        let app = real_app(auth::AuthState::for_tests(&"k".repeat(32), auth::OwnerKeyMode::Full, false));
        let mut r = axum::http::Request::builder().method("POST").uri("/api/auth/pair").header("content-type", "application/json")
            .body(axum::body::Body::from(r#"{"code":"7KQ2-M9XD","name":"x"}"#)).unwrap();
        r.extensions_mut().insert(axum::extract::ConnectInfo::<std::net::SocketAddr>("10.2.0.1:1".parse().unwrap()));
        let res = app.oneshot(r).await.unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("device_auth_unavailable"));
        // unauthenticated /health still works and reports level 15
        let app = real_app(auth::AuthState::for_tests(&"k".repeat(32), auth::OwnerKeyMode::Full, false));
        let res = app.oneshot(axum::http::Request::builder().uri("/health").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("\"api_level\":15"));
    }

    /// GET /api/auth/me without device auth: owner, device_auth false, mode full.
    #[tokio::test]
    async fn me_without_device_auth() {
        use tower::ServiceExt;
        let key = "k".repeat(32);
        let app = real_app(auth::AuthState::for_tests(&key, auth::OwnerKeyMode::Full, false));
        let res = app.oneshot(axum::http::Request::builder().uri("/api/auth/me").header("authorization", format!("Bearer {key}"))
            .body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: serde_json::Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "owner", "device": null, "device_auth": false, "owner_key_mode": "full"}));
    }
}

/// All routes. /api/* except /api/auth/pair go through the auth middleware (`route_layer` only wraps the routes
/// added before it; the pairing route is merged afterwards and stays public).
fn router(state: AppState) -> Router {
    use axum::routing::{delete, patch, post, put};
    let api = Router::new()
        .route("/health", get(health_full))
        .route("/cars", get(list_cars))
        .route("/cars/:id/summary", get(summary::car_summary))
        .route("/cars/:id/status", get(summary::car_status))
        .route("/cars/:id/last-activity", get(summary::car_last_activity))
        .route("/cars/:id/stats", get(summary::car_stats))
        .route("/cars/:id/report", get(report::car_report))
        .route("/cars/:id/trends", get(report::car_trends))
        .route("/cars/:id/footprint", get(insights::footprint))
        .route("/cars/:id/battery", get(insights::battery))
        .route("/charges", get(charges_route))
        .route("/charges/:id", get(get_charge))
        .route("/charges/:id/cost", put(put_cost).delete(delete_cost))
        .route("/drives", get(drives_route))
        .route("/cars/:id/months", get(car_months))
        .route("/journeys", get(journey::list).post(journey::create))
        .route("/journeys/suggestions", get(journey::suggestions))
        .route("/journeys/suggestions/dismiss", post(journey::dismiss))
        .route("/journeys/suggestions/dismissed", delete(journey::restore_dismissed))
        .route("/journeys/:id", get(journey::get).patch(journey::update).delete(journey::delete))
        .route("/journeys/:id/drives", put(journey::set_drives))
        .route("/journeys/:id/path", get(journey::path))
        .route("/journeys/:id/cover", get(phase2::get_cover).put(phase2::put_cover).delete(phase2::delete_cover))
        .route("/journeys/:id/weather", get(phase2::weather))
        .route("/journeys/:id/speed-bands", get(phase2::speed_bands))
        .route("/drives/:id", get(get_drive))
        .route("/drives/:id/path", get(drive_path))
        .route("/push/key", get(push::key))
        .route("/push/subscription", post(push::subscribe))
        .route("/push/subscription/status", post(push::status))
        .route("/push/unsubscribe", post(push::unsubscribe))
        .route("/push/test", post(push::test))
        .route("/addresses/aliases", get(list_aliases))
        .route("/addresses/:id/alias", put(put_alias).delete(delete_alias))
        .route("/auth/me", get(auth::me))
        .route("/auth/devices", get(auth::list).post(auth::exchange).delete(auth::revoke_others))
        .route("/auth/devices/current", patch(auth::rename_current).delete(auth::revoke_current))
        .route("/auth/devices/:id", patch(auth::rename).delete(auth::revoke))
        .route("/auth/pairings", post(auth::create_pairing))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::middleware))
        .merge(Router::new().route("/auth/pair", post(auth::pair)));

    Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .layer(cors_layer())
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=info".into()))
        .init();
    let db_url = std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let token = std::env::var("API_TOKEN").map_err(|_| anyhow::anyhow!("API_TOKEN is required"))?;
    anyhow::ensure!(token.len() >= 16, "API_TOKEN must be at least 16 characters (recommended: 32+ random characters, e.g. `openssl rand -hex 24`)");
    let classes = [token.bytes().any(|b| b.is_ascii_lowercase()), token.bytes().any(|b| b.is_ascii_uppercase()), token.bytes().any(|b| b.is_ascii_digit()), token.bytes().any(|b| !b.is_ascii_alphanumeric())].iter().filter(|x| **x).count();
    let distinct = token.bytes().collect::<std::collections::HashSet<_>>().len();
    if token.len() < 32 || distinct < 10 || classes < 2 { tracing::warn!("API_TOKEN looks weak (use 32+ random characters, e.g. `openssl rand -hex 24`)"); }
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let mode = auth::OwnerKeyMode::from_env()?;

    let db = PgPoolOptions::new().max_connections(5).connect(&db_url).await?;
    migrate(&db).await?;
    let auth = auth::AuthState::init(db.clone(), &token, mode).await;
    let state = AppState { db, costs_ok: Arc::new(Default::default()), journeys_ok: Arc::new(Default::default()), dismiss_ok: Arc::new(Default::default()), cover_ok: Arc::new(Default::default()), weather_ok: Arc::new(Default::default()),
        push_ok: Arc::new(Default::default()), vapid: Arc::new(Default::default()),
        http: push::push_client()?, auth: Arc::new(auth) };
    log_features(&state).await;
    push::spawn(state.clone());
    auth::spawn(state.clone());
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on {bind}");
    // ConnectInfo: the TCP peer address is the rate-limit key (see client_key)
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await?;
    Ok(())
}

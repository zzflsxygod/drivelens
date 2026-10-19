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

#[derive(Clone)]
struct AppState {
    db: PgPool,
    token: Arc<String>,
    /// drivelens.charge_costs exists (checked lazily; once true it stays true)
    costs_ok: Arc<std::sync::atomic::AtomicBool>,
    journeys_ok: Arc<std::sync::atomic::AtomicBool>,
    dismiss_ok: Arc<std::sync::atomic::AtomicBool>,
    cover_ok: Arc<std::sync::atomic::AtomicBool>,
    weather_ok: Arc<std::sync::atomic::AtomicBool>,
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
/// 6 = monthly report (v0.5.0) · 7 = JSON /health with version (v0.5.1) · 8 = journeys (v0.6.0) · 9 = dismiss suggestions (v0.6.1) · 10 = keyset paging + /cars/:id/months (v0.6.2) · 11 = journey cover, weather, speed bands (v0.7.0) · 12 = battery degradation, report footprint + 12-month trends (v0.9.0)
pub(crate) const API_LEVEL: u32 = 12;

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
        "journey_cover": phase2::cover_ok(&s).await.unwrap_or(false), "weather": phase2::weather_ok(&s).await.unwrap_or(false)}))).into_response()
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

const COSTS_MISSING: &str = "manual cost table drivelens.charge_costs is missing or not writable; re-run deploy/drivelens-init.sql (see README)";

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

/// Our own schema; TeslaMate's tables are never modified.
async fn migrate(db: &PgPool) -> anyhow::Result<()> {
    // If an admin pre-created the table (recommended for a least-privilege DB user), do nothing:
    // CREATE SCHEMA IF NOT EXISTS still requires CREATE privilege on the database.
    let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.address_aliases')::text")
        .fetch_one(db).await?;
    if exists.is_none() {
        sqlx::query("CREATE SCHEMA IF NOT EXISTS drivelens").execute(db).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS drivelens.address_aliases (
            address_id integer PRIMARY KEY REFERENCES public.addresses(id) ON DELETE CASCADE,
            name text NOT NULL CHECK (length(btrim(name)) > 0),
            updated_at timestamptz NOT NULL DEFAULT now())",
    ).execute(db).await?;
    }
    // Manual costs (v0.4.0). A least-privilege user cannot create it: then the feature stays
    // disabled (PUT returns 503) until drivelens-init.sql is re-run. Never fatal.
    let has: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.charge_costs')::text").fetch_one(db).await?;
    if has.is_none() {
        if let Err(e) = sqlx::query(
            "CREATE TABLE IF NOT EXISTS drivelens.charge_costs (
                charging_process_id integer PRIMARY KEY REFERENCES public.charging_processes(id) ON DELETE CASCADE,
                amount numeric(12,2) NOT NULL CHECK (amount >= 0),
                currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
                note text,
                updated_at timestamptz NOT NULL DEFAULT now())",
        ).execute(db).await {
            tracing::warn!("manual charge costs disabled: cannot create drivelens.charge_costs ({e}); re-run drivelens-init.sql");
        }
    }
    journey::try_create_tables(db).await;
    phase2::try_migrate(db).await;
    Ok(())
}

async fn drive_path(State(s): State<AppState>, Path(id): Path<i64>) -> ApiResult<Vec<PathPoint>> {
    let rows = sqlx::query_as::<_, PathPoint>(&format!(
        r#"SELECT to_char(date, '{TS}') AS date, latitude::float8 AS lat, longitude::float8 AS lng,
             speed::int4 AS speed, elevation::int4 AS elevation, battery_level::int4 AS battery_level
           FROM positions WHERE drive_id = $1 ORDER BY positions.date"#
    )).bind(id).fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn auth(State(s): State<AppState>, req: Request, next: Next) -> Response {
    let ok = req.headers().get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| constant_time_eq(t.as_bytes(), s.token.as_bytes()))
        .unwrap_or(false);
    if ok { next.run(req).await } else {
        (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response()
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=info".into()))
        .init();
    let db_url = std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let token = std::env::var("API_TOKEN").map_err(|_| anyhow::anyhow!("API_TOKEN is required"))?;
    anyhow::ensure!(token.len() >= 16, "API_TOKEN must be at least 16 characters");
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());

    let db = PgPoolOptions::new().max_connections(5).connect(&db_url).await?;
    migrate(&db).await?;
    let state = AppState { db, token: Arc::new(token), costs_ok: Arc::new(Default::default()), journeys_ok: Arc::new(Default::default()), dismiss_ok: Arc::new(Default::default()), cover_ok: Arc::new(Default::default()), weather_ok: Arc::new(Default::default()) };

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
        .route("/charges/:id/cost", axum::routing::put(put_cost).delete(delete_cost))
        .route("/drives", get(drives_route))
        .route("/cars/:id/months", get(car_months))
        .route("/journeys", get(journey::list).post(journey::create))
        .route("/journeys/suggestions", get(journey::suggestions))
        .route("/journeys/suggestions/dismiss", axum::routing::post(journey::dismiss))
        .route("/journeys/suggestions/dismissed", axum::routing::delete(journey::restore_dismissed))
        .route("/journeys/:id", get(journey::get).patch(journey::update).delete(journey::delete))
        .route("/journeys/:id/drives", axum::routing::put(journey::set_drives))
        .route("/journeys/:id/path", get(journey::path))
        .route("/journeys/:id/cover", get(phase2::get_cover).put(phase2::put_cover).delete(phase2::delete_cover))
        .route("/journeys/:id/weather", get(phase2::weather))
        .route("/journeys/:id/speed-bands", get(phase2::speed_bands))
        .route("/drives/:id", get(get_drive))
        .route("/drives/:id/path", get(drive_path))
        .route("/addresses/aliases", get(list_aliases))
        .route("/addresses/:id/alias", axum::routing::put(put_alias).delete(delete_alias))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::PATCH, axum::http::Method::PUT, axum::http::Method::DELETE, axum::http::Method::OPTIONS]).allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

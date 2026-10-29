// SPDX-License-Identifier: AGPL-3.0-or-later
//! GET /api/cars/:id/summary — home screen data.
use super::*;

#[derive(Serialize, FromRow)]
pub struct CarInfo {
    id: i64,
    name: Option<String>,
    model: Option<String>,
    marketing_name: Option<String>,
    trim_badging: Option<String>,
    exterior_color: Option<String>,
    wheel_type: Option<String>,
    vin: Option<String>,
    efficiency: Option<f64>,
}

#[derive(Serialize, FromRow)]
pub struct LatestPosition {
    date: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    battery_level: Option<i32>,
    usable_battery_level: Option<i32>,
    rated_battery_range_km: Option<f64>,
    ideal_battery_range_km: Option<f64>,
    est_battery_range_km: Option<f64>,
    odometer_km: Option<f64>,
    outside_temp: Option<f64>,
    inside_temp: Option<f64>,
    speed: Option<i32>,
}

#[derive(Serialize, FromRow)]
pub struct CarState {
    state: Option<String>,
    since: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct Software {
    version: Option<String>,
    installed_at: Option<String>,
}

/// Latest tire pressures (bar) from TeslaMate `positions`. One snapshot = the most recent
/// row that has any wheel non-null; individual wheels may still be null on that row.
#[derive(Serialize, FromRow, Debug, PartialEq)]
pub struct Tpms {
    date: Option<String>,
    fl: Option<f64>,
    fr: Option<f64>,
    rl: Option<f64>,
    rr: Option<f64>,
}

#[derive(Serialize, FromRow, Default)]
pub struct Stats {
    total_distance_km: Option<f64>,
    drive_count: Option<i64>,
    charge_count: Option<i64>,
    total_energy_added_kwh: Option<f64>,
    total_cost: Option<f64>,
    /// effective costs (manual > TeslaMate) summed per currency
    #[sqlx(skip)]
    costs: Vec<CurrencyAmount>,
}

#[derive(Serialize, FromRow, Default, Clone)]
pub struct CurrencyAmount { currency: String, amount: f64, count: i64 }

#[derive(Serialize, FromRow, Default)]
pub struct MonthStats {
    month: Option<String>,
    distance_km: Option<f64>,
    drive_count: Option<i64>,
    drive_energy_kwh: Option<f64>,
    charge_count: Option<i64>,
    charge_energy_added_kwh: Option<f64>,
    charge_cost: Option<f64>,
    #[sqlx(skip)]
    charge_costs: Vec<CurrencyAmount>,
}

#[derive(Serialize)]
pub struct Location {
    /// alias > geofence > TeslaMate address, from the most recent drive end / charge
    name: Option<String>,
    address_id: Option<i64>,
    source: &'static str,
}

#[derive(Serialize)]
pub struct Status {
    car: CarInfo,
    state: Option<CarState>,
    position: Option<LatestPosition>,
    software: Option<Software>,
    /// Latest TPMS snapshot (api_level ≥ 16). Omitted/null when no recent reading.
    #[serde(skip_serializing_if = "Option::is_none")]
    tpms: Option<Tpms>,
}

#[derive(Serialize)]
pub struct LastActivity {
    location: Option<Location>,
    last_drive: Option<Drive>,
    last_charge: Option<ChargeSummary>,
}

#[derive(Serialize)]
pub struct StatsResp {
    stats: Stats,
    this_month: MonthStats,
    timezone: String,
}

#[derive(Serialize)]
pub struct Summary {
    #[serde(flatten)]
    status: Status,
    #[serde(flatten)]
    activity: LastActivity,
    #[serde(flatten)]
    stats: StatsResp,
}

#[derive(Deserialize)]
pub struct SummaryParams { tz: Option<String>, currency: Option<String> }

fn not_found(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": msg}))).into_response()
}

/// Car info + state + latest position + software. Every query is index-backed.
async fn load_status(db: &PgPool, id: i64) -> Result<Option<Status>, ApiError> {
    let Some(car) = sqlx::query_as::<_, CarInfo>(
        "SELECT id::int8 AS id, name, model, marketing_name, trim_badging, exterior_color, wheel_type, vin,
                efficiency::float8 AS efficiency FROM cars WHERE id = $1",
    ).bind(id).fetch_optional(db).await? else { return Ok(None) };

    let state = sqlx::query_as::<_, CarState>(&format!(
        "SELECT state::text AS state, to_char(start_date, '{TS}') AS since FROM states
         WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    // The `ideal_battery_range_km IS NOT NULL` predicate matches TeslaMate's partial index
    // positions(car_id, date) WHERE ideal_battery_range_km IS NOT NULL (same query TeslaMate itself uses).
    // Without it Postgres scans/sorts every position of the car (seconds on a large history).
    let position = sqlx::query_as::<_, LatestPosition>(&format!(
        "SELECT to_char(date, '{TS}') AS date, latitude::float8 AS latitude, longitude::float8 AS longitude,
                battery_level::int4 AS battery_level, usable_battery_level::int4 AS usable_battery_level,
                rated_battery_range_km::float8 AS rated_battery_range_km, ideal_battery_range_km::float8 AS ideal_battery_range_km,
                est_battery_range_km::float8 AS est_battery_range_km, odometer::float8 AS odometer_km,
                outside_temp::float8 AS outside_temp, inside_temp::float8 AS inside_temp, speed::int4 AS speed
         FROM positions WHERE car_id = $1 AND ideal_battery_range_km IS NOT NULL
         ORDER BY positions.date DESC LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    let software = sqlx::query_as::<_, Software>(&format!(
        "SELECT version, to_char(COALESCE(end_date, start_date), '{TS}') AS installed_at FROM updates
         WHERE car_id = $1 AND version IS NOT NULL ORDER BY start_date DESC LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    // TPMS: one LIMIT-1 over recent positions with any wheel set.
    // TeslaMate indexes: BRIN(date), (car_id), partial (car_id, date) WHERE ideal_battery_range_km IS NOT NULL
    // (battery-only — not usable for TPMS). Bound by 90 days so BRIN(date) + car_id prune; avoid a full
    // history scan on large `positions` tables. No new index / migration (TeslaMate read-only).
    let tpms = sqlx::query_as::<_, Tpms>(&format!(
        "SELECT to_char(date, '{TS}') AS date,
                tpms_pressure_fl::float8 AS fl, tpms_pressure_fr::float8 AS fr,
                tpms_pressure_rl::float8 AS rl, tpms_pressure_rr::float8 AS rr
         FROM positions
         WHERE car_id = $1
           AND date >= (now() AT TIME ZONE 'UTC') - interval '90 days'
           AND (tpms_pressure_fl IS NOT NULL OR tpms_pressure_fr IS NOT NULL
                OR tpms_pressure_rl IS NOT NULL OR tpms_pressure_rr IS NOT NULL)
         ORDER BY date DESC
         LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    Ok(Some(Status { car, state, position, software, tpms }))
}

async fn load_activity(s: &AppState, id: i64) -> Result<LastActivity, ApiError> {
    let one = |car_id| ListParams { car_id: Some(car_id), limit: Some(1), offset: None, id: None, before: None, paged: None, q: None };
    let (Json(mut drives), Json(mut charges)) = tokio::try_join!(
        list_drives(State(s.clone()), Query(one(id))),
        super::list_charges(State(s.clone()), Query(one(id))),
    )?;
    let (last_drive, last_charge) = (drives.pop(), charges.pop());
    // Current location = whichever happened last: end of last drive, or last charge
    let location = match (&last_drive, &last_charge) {
        (Some(d), Some(c)) if c.start_date >= d.end_date =>
            Some(Location { name: c.address.clone(), address_id: c.address_id, source: "charge" }),
        (Some(d), _) => Some(Location { name: d.end_address.clone(), address_id: d.end_address_id, source: "drive" }),
        (None, Some(c)) => Some(Location { name: c.address.clone(), address_id: c.address_id, source: "charge" }),
        _ => None,
    };
    Ok(LastActivity { location, last_drive, last_charge })
}

/// Aggregates only over drives / charging_processes (small tables), never positions.
/// Returns Ok(None) for an invalid timezone.
async fn load_stats(s: &AppState, id: i64, tz: &str, cur: &str) -> Result<Option<StatsResp>, ApiError> {
    let db = &s.db;
    let mut stats = sqlx::query_as::<_, Stats>(
        "SELECT (SELECT SUM(distance)::float8 FROM drives WHERE car_id = $1) AS total_distance_km,
                (SELECT COUNT(*) FROM drives WHERE car_id = $1 AND end_date IS NOT NULL) AS drive_count,
                (SELECT COUNT(*) FROM charging_processes WHERE car_id = $1 AND end_date IS NOT NULL) AS charge_count,
                (SELECT SUM(charge_energy_added)::float8 FROM charging_processes WHERE car_id = $1) AS total_energy_added_kwh,
                (SELECT SUM(cost)::float8 FROM charging_processes WHERE car_id = $1) AS total_cost",
    ).bind(id).fetch_one(db).await?;
    // TeslaMate stores naive UTC timestamps; month boundaries in the user's timezone
    let month = sqlx::query_as::<_, MonthStats>(
        "WITH b AS (SELECT (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2) AT TIME ZONE 'UTC' AS m0)
         SELECT to_char(date_trunc('month', now() AT TIME ZONE $2), 'YYYY-MM') AS month,
           (SELECT SUM(d.distance)::float8 FROM drives d, b WHERE d.car_id = $1 AND d.start_date >= b.m0) AS distance_km,
           (SELECT COUNT(*) FROM drives d, b WHERE d.car_id = $1 AND d.start_date >= b.m0 AND d.end_date IS NOT NULL) AS drive_count,
           (SELECT SUM((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::float8
              FROM drives d JOIN cars c ON c.id = d.car_id, b WHERE d.car_id = $1 AND d.start_date >= b.m0) AS drive_energy_kwh,
           (SELECT COUNT(*) FROM charging_processes cp, b WHERE cp.car_id = $1 AND cp.start_date >= b.m0 AND cp.end_date IS NOT NULL) AS charge_count,
           (SELECT SUM(cp.charge_energy_added)::float8 FROM charging_processes cp, b WHERE cp.car_id = $1 AND cp.start_date >= b.m0) AS charge_energy_added_kwh,
           (SELECT SUM(cp.cost)::float8 FROM charging_processes cp, b WHERE cp.car_id = $1 AND cp.start_date >= b.m0) AS charge_cost",
    ).bind(id).bind(tz).fetch_one(db).await;
    let mut this_month = match month {
        Ok(m) => m,
        // invalid_parameter_value: "time zone ... not recognized"
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    // effective cost per charge, then grouped by currency; month split by the same tz boundary
    let (cc_cols, cc_join) = if super::costs_ok(s).await? {
        ("COALESCE(cc.amount, cp.cost)", "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", "") };
    let rows: Vec<(String, bool, f64, i64)> = sqlx::query_as(&format!(
        "WITH b AS (SELECT (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2) AT TIME ZONE 'UTC' AS m0),
         e AS (SELECT {cc_cols}::float8 AS amount,
                 COALESCE({cur_expr}, $3) AS currency, cp.start_date >= b.m0 AS this_month
               FROM charging_processes cp CROSS JOIN b
               LEFT JOIN addresses a ON a.id = cp.address_id
               LEFT JOIN positions p ON p.id = cp.position_id
               {cc_join}
               WHERE cp.car_id = $1)
         SELECT currency, this_month, round(SUM(amount)::numeric, 2)::float8, COUNT(*) FROM e WHERE amount IS NOT NULL
         GROUP BY 1, 2 ORDER BY 1",
        cur_expr = if cc_join.is_empty() { super::LOC_CURRENCY.to_string() } else { format!("cc.currency::text, {}", super::LOC_CURRENCY) },
    )).bind(id).bind(tz).bind(cur).fetch_all(db).await?;
    for (currency, m, amount, count) in rows {
        let ca = CurrencyAmount { currency, amount, count };
        if let Some(t) = stats.costs.iter_mut().find(|t| t.currency == ca.currency) { t.amount += ca.amount; t.count += ca.count; }
        else { stats.costs.push(CurrencyAmount { ..ca.clone() }); }
        if m { this_month.charge_costs.push(ca); }
    }
    Ok(Some(StatsResp { stats, this_month, timezone: tz.to_string() }))
}

async fn car_exists(db: &PgPool, id: i64) -> Result<bool, ApiError> {
    Ok(sqlx::query_scalar::<_, i32>("SELECT 1 FROM cars WHERE id = $1").bind(id).fetch_optional(db).await?.is_some())
}

fn bad_tz() -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "unknown tz"}))).into_response()
}

pub async fn car_status(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    Ok(match load_status(&s.db, id).await? { Some(st) => Json(st).into_response(), None => not_found("car not found") })
}

pub async fn car_last_activity(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    if !car_exists(&s.db, id).await? { return Ok(not_found("car not found")); }
    Ok(Json(load_activity(&s, id).await?).into_response())
}

pub async fn car_stats(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<SummaryParams>) -> Result<Response, ApiError> {
    if !car_exists(&s.db, id).await? { return Ok(not_found("car not found")); }
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let cur = currency_param(p.currency);
    Ok(match load_stats(&s, id, &tz, &cur).await? { Some(r) => Json(r).into_response(), None => bad_tz() })
}

/// Everything in one response (kept for compatibility with app v0.3.0); sections are loaded in parallel.
pub async fn car_summary(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<SummaryParams>) -> Result<Response, ApiError> {
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let cur = currency_param(p.currency);
    let (status, activity, stats) = tokio::try_join!(load_status(&s.db, id), load_activity(&s, id), load_stats(&s, id, &tz, &cur))?;
    let Some(status) = status else { return Ok(not_found("car not found")) };
    let Some(stats) = stats else { return Ok(bad_tz()) };
    Ok(Json(Summary { status, activity, stats }).into_response())
}

/// Default currency for costs whose currency is unknown (TeslaMate cost at an unrecognised location).
fn currency_param(c: Option<String>) -> String {
    c.map(|c| c.trim().to_ascii_uppercase()).filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
        .unwrap_or_else(|| "JPY".into())
}

#[cfg(test)]
mod tpms_tests {
    use super::Tpms;
    #[test]
    fn tpms_serializes_wheels_and_skips_none_fields_via_option() {
        let j = serde_json::to_value(Tpms {
            date: Some("2026-10-29 04:00:00".into()),
            fl: Some(2.3), fr: Some(2.8), rl: None, rr: Some(2.7),
        }).unwrap();
        assert_eq!(j["fl"], 2.3);
        assert_eq!(j["fr"], 2.8);
        assert!(j.get("rl").unwrap().is_null());
        assert_eq!(j["rr"], 2.7);
        assert_eq!(j["date"], "2026-10-29 04:00:00");
    }
}

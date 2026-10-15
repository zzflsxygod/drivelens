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

#[derive(Serialize, FromRow, Default)]
pub struct Stats {
    total_distance_km: Option<f64>,
    drive_count: Option<i64>,
    charge_count: Option<i64>,
    total_energy_added_kwh: Option<f64>,
    total_cost: Option<f64>,
}

#[derive(Serialize, FromRow, Default)]
pub struct MonthStats {
    month: Option<String>,
    distance_km: Option<f64>,
    drive_count: Option<i64>,
    drive_energy_kwh: Option<f64>,
    charge_count: Option<i64>,
    charge_energy_added_kwh: Option<f64>,
    charge_cost: Option<f64>,
}

#[derive(Serialize)]
pub struct Location {
    /// alias > geofence > TeslaMate address, from the most recent drive end / charge
    name: Option<String>,
    address_id: Option<i64>,
    source: &'static str,
}

#[derive(Serialize)]
pub struct Summary {
    car: CarInfo,
    state: Option<CarState>,
    position: Option<LatestPosition>,
    location: Option<Location>,
    software: Option<Software>,
    last_drive: Option<Drive>,
    last_charge: Option<ChargeSummary>,
    stats: Stats,
    this_month: MonthStats,
    timezone: String,
}

#[derive(Deserialize)]
pub struct SummaryParams { tz: Option<String> }

pub async fn car_summary(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<SummaryParams>) -> Result<Response, ApiError> {
    let db = &s.db;
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let tz_ok: Option<i32> = sqlx::query_scalar("SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1").bind(&tz).fetch_optional(db).await?;
    if tz_ok.is_none() {
        return Ok((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "unknown tz"}))).into_response());
    }

    let Some(car) = sqlx::query_as::<_, CarInfo>(
        "SELECT id::int8 AS id, name, model, marketing_name, trim_badging, exterior_color, wheel_type, vin,
                efficiency::float8 AS efficiency FROM cars WHERE id = $1",
    ).bind(id).fetch_optional(db).await? else {
        return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "car not found"}))).into_response());
    };

    let state = sqlx::query_as::<_, CarState>(&format!(
        "SELECT state::text AS state, to_char(start_date, '{TS}') AS since FROM states
         WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    let position = sqlx::query_as::<_, LatestPosition>(&format!(
        "SELECT to_char(date, '{TS}') AS date, latitude::float8 AS latitude, longitude::float8 AS longitude,
                battery_level::int4 AS battery_level, usable_battery_level::int4 AS usable_battery_level,
                rated_battery_range_km::float8 AS rated_battery_range_km, ideal_battery_range_km::float8 AS ideal_battery_range_km,
                est_battery_range_km::float8 AS est_battery_range_km, odometer::float8 AS odometer_km,
                outside_temp::float8 AS outside_temp, inside_temp::float8 AS inside_temp, speed::int4 AS speed
         FROM positions WHERE car_id = $1 ORDER BY date DESC LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    let software = sqlx::query_as::<_, Software>(&format!(
        "SELECT version, to_char(COALESCE(end_date, start_date), '{TS}') AS installed_at FROM updates
         WHERE car_id = $1 AND version IS NOT NULL ORDER BY start_date DESC LIMIT 1"
    )).bind(id).fetch_optional(db).await?;

    let one = |car_id| ListParams { car_id: Some(car_id), limit: Some(1), offset: None, id: None };
    let Json(mut drives) = list_drives(State(s.clone()), Query(one(id))).await?;
    let Json(mut charges) = super::list_charges(State(s.clone()), Query(one(id))).await?;
    let last_drive = drives.pop();
    let last_charge = charges.pop();

    // Current location = whichever happened last: end of last drive, or last charge
    let location = match (&last_drive, &last_charge) {
        (Some(d), Some(c)) if c.start_date >= d.end_date =>
            Some(Location { name: c.address.clone(), address_id: c.address_id, source: "charge" }),
        (Some(d), _) => Some(Location { name: d.end_address.clone(), address_id: d.end_address_id, source: "drive" }),
        (None, Some(c)) => Some(Location { name: c.address.clone(), address_id: c.address_id, source: "charge" }),
        _ => None,
    };

    let stats = sqlx::query_as::<_, Stats>(
        "SELECT (SELECT SUM(distance)::float8 FROM drives WHERE car_id = $1) AS total_distance_km,
                (SELECT COUNT(*) FROM drives WHERE car_id = $1 AND end_date IS NOT NULL) AS drive_count,
                (SELECT COUNT(*) FROM charging_processes WHERE car_id = $1 AND end_date IS NOT NULL) AS charge_count,
                (SELECT SUM(charge_energy_added)::float8 FROM charging_processes WHERE car_id = $1) AS total_energy_added_kwh,
                (SELECT SUM(cost)::float8 FROM charging_processes WHERE car_id = $1) AS total_cost",
    ).bind(id).fetch_one(db).await?;

    // TeslaMate stores naive UTC timestamps; month boundaries in the user's timezone
    let this_month = sqlx::query_as::<_, MonthStats>(
        "WITH b AS (SELECT (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2) AT TIME ZONE 'UTC' AS m0)
         SELECT to_char(date_trunc('month', now() AT TIME ZONE $2), 'YYYY-MM') AS month,
           (SELECT SUM(d.distance)::float8 FROM drives d, b WHERE d.car_id = $1 AND d.start_date >= b.m0) AS distance_km,
           (SELECT COUNT(*) FROM drives d, b WHERE d.car_id = $1 AND d.start_date >= b.m0 AND d.end_date IS NOT NULL) AS drive_count,
           (SELECT SUM((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::float8
              FROM drives d JOIN cars c ON c.id = d.car_id, b WHERE d.car_id = $1 AND d.start_date >= b.m0) AS drive_energy_kwh,
           (SELECT COUNT(*) FROM charging_processes cp, b WHERE cp.car_id = $1 AND cp.start_date >= b.m0 AND cp.end_date IS NOT NULL) AS charge_count,
           (SELECT SUM(cp.charge_energy_added)::float8 FROM charging_processes cp, b WHERE cp.car_id = $1 AND cp.start_date >= b.m0) AS charge_energy_added_kwh,
           (SELECT SUM(cp.cost)::float8 FROM charging_processes cp, b WHERE cp.car_id = $1 AND cp.start_date >= b.m0) AS charge_cost",
    ).bind(id).bind(&tz).fetch_one(db).await?;

    Ok(Json(Summary { car, state, position, location, software, last_drive, last_charge, stats, this_month, timezone: tz }).into_response())
}

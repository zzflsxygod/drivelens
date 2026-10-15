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

#[derive(Clone)]
struct AppState {
    db: PgPool,
    token: Arc<String>,
}

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
}
impl ListParams {
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
    cost: Option<f64>,
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
    fast_charger_present: Option<bool>,
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

fn charge_select() -> String {
    format!(
        r#"SELECT cp.id::int8 AS id, cp.car_id::int8 AS car_id,
          to_char(cp.start_date, '{TS}') AS start_date, to_char(cp.end_date, '{TS}') AS end_date,
          COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city)) AS address,
          g.name AS geofence, cp.address_id::int8 AS address_id, al.name AS alias,
          p.latitude::float8 AS latitude, p.longitude::float8 AS longitude,
          cp.charge_energy_added::float8 AS charge_energy_added,
          cp.charge_energy_used::float8 AS charge_energy_used,
          cp.cost::float8 AS cost,
          cp.start_battery_level::int4 AS start_battery_level, cp.end_battery_level::int4 AS end_battery_level,
          cp.duration_min::int4 AS duration_min, cp.outside_temp_avg::float8 AS outside_temp_avg
        FROM charging_processes cp
        LEFT JOIN addresses a ON a.id = cp.address_id
        LEFT JOIN drivelens.address_aliases al ON al.address_id = cp.address_id
        LEFT JOIN geofences g ON g.id = cp.geofence_id
        LEFT JOIN positions p ON p.id = cp.position_id"#
    )
}

async fn health() -> &'static str { "ok" }

async fn list_cars(State(s): State<AppState>) -> ApiResult<Vec<Car>> {
    let rows = sqlx::query_as::<_, Car>(
        "SELECT id::int8 AS id, name, model, marketing_name, vin, efficiency::float8 AS efficiency FROM cars ORDER BY display_priority, id",
    ).fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn list_charges(State(s): State<AppState>, Query(q): Query<ListParams>) -> ApiResult<Vec<ChargeSummary>> {
    let sql = format!(
        "{} WHERE ($1::int8 IS NULL OR cp.car_id = $1) AND cp.end_date IS NOT NULL ORDER BY cp.start_date DESC LIMIT $2 OFFSET $3",
        charge_select()
    );
    let rows = sqlx::query_as::<_, ChargeSummary>(&sql)
        .bind(q.car_id).bind(q.limit()).bind(q.offset())
        .fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn get_charge(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    let sql = format!("{} WHERE cp.id = $1", charge_select());
    let Some(summary) = sqlx::query_as::<_, ChargeSummary>(&sql).bind(id).fetch_optional(&s.db).await? else {
        return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response());
    };
    let points = sqlx::query_as::<_, ChargePoint>(&format!(
        r#"SELECT to_char(date, '{TS}') AS date, battery_level::int4 AS battery_level,
             charge_energy_added::float8 AS charge_energy_added, charger_power::int4 AS charger_power,
             charger_voltage::int4 AS charger_voltage, charger_actual_current::int4 AS charger_actual_current,
             fast_charger_present
           FROM charges WHERE charging_process_id = $1 ORDER BY date"#
    )).bind(id).fetch_all(&s.db).await?;
    Ok(Json(ChargeDetail { summary, points }).into_response())
}

async fn list_drives(State(s): State<AppState>, Query(q): Query<ListParams>) -> ApiResult<Vec<Drive>> {
    let sql = format!(
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
             d.outside_temp_avg::float8 AS outside_temp_avg
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
           WHERE ($1::int8 IS NULL OR d.car_id = $1) AND ($4::int8 IS NULL OR d.id = $4) AND d.end_date IS NOT NULL
           ORDER BY d.start_date DESC LIMIT $2 OFFSET $3"#
    );
    let rows = sqlx::query_as::<_, Drive>(&sql)
        .bind(q.car_id).bind(q.limit()).bind(q.offset()).bind(q.id)
        .fetch_all(&s.db).await?;
    Ok(Json(rows))
}

async fn get_drive(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    let q = ListParams { car_id: None, limit: Some(1), offset: None, id: Some(id) };
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

/// Our own schema; TeslaMate's tables are never modified.
async fn migrate(db: &PgPool) -> anyhow::Result<()> {
    // If an admin pre-created the table (recommended for a least-privilege DB user), do nothing:
    // CREATE SCHEMA IF NOT EXISTS still requires CREATE privilege on the database.
    let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.address_aliases')::text")
        .fetch_one(db).await?;
    if exists.is_some() { return Ok(()); }
    sqlx::query("CREATE SCHEMA IF NOT EXISTS drivelens").execute(db).await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS drivelens.address_aliases (
            address_id integer PRIMARY KEY REFERENCES public.addresses(id) ON DELETE CASCADE,
            name text NOT NULL CHECK (length(btrim(name)) > 0),
            updated_at timestamptz NOT NULL DEFAULT now())",
    ).execute(db).await?;
    Ok(())
}

async fn drive_path(State(s): State<AppState>, Path(id): Path<i64>) -> ApiResult<Vec<PathPoint>> {
    let rows = sqlx::query_as::<_, PathPoint>(&format!(
        r#"SELECT to_char(date, '{TS}') AS date, latitude::float8 AS lat, longitude::float8 AS lng,
             speed::int4 AS speed, elevation::int4 AS elevation, battery_level::int4 AS battery_level
           FROM positions WHERE drive_id = $1 ORDER BY date"#
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
    let state = AppState { db, token: Arc::new(token) };

    let api = Router::new()
        .route("/cars", get(list_cars))
        .route("/cars/:id/summary", get(summary::car_summary))
        .route("/charges", get(list_charges))
        .route("/charges/:id", get(get_charge))
        .route("/drives", get(list_drives))
        .route("/drives/:id", get(get_drive))
        .route("/drives/:id/path", get(drive_path))
        .route("/addresses/aliases", get(list_aliases))
        .route("/addresses/:id/alias", axum::routing::put(put_alias).delete(delete_alias))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods([axum::http::Method::GET, axum::http::Method::PUT, axum::http::Method::DELETE, axum::http::Method::OPTIONS]).allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

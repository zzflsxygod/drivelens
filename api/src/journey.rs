// SPDX-License-Identifier: AGPL-3.0-or-later
//! 旅程 (journeys): user-defined groups of TeslaMate drives, stored in drivelens.journeys / journey_drives.
//! TeslaMate tables are only read. If the tables are missing the endpoints answer 503 with a clear message.
use super::*;
use std::sync::atomic::Ordering;

const MISSING: &str = "journey tables drivelens.journeys / journey_drives are missing or not writable; run deploy/setup.sql and restart the API";

const DDL: [&str; 3] = [
    "CREATE TABLE IF NOT EXISTS drivelens.journeys (
        id serial PRIMARY KEY,
        car_id integer NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(btrim(name)) > 0),
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now())",
    "CREATE TABLE IF NOT EXISTS drivelens.journey_drives (
        drive_id integer PRIMARY KEY REFERENCES public.drives(id) ON DELETE CASCADE,
        journey_id integer NOT NULL REFERENCES drivelens.journeys(id) ON DELETE CASCADE)",
    "CREATE INDEX IF NOT EXISTS journey_drives_journey_id_idx ON drivelens.journey_drives (journey_id)",
];

const DISMISS_DDL: &str = "CREATE TABLE IF NOT EXISTS drivelens.dismissed_suggestions (
        drive_id integer PRIMARY KEY REFERENCES public.drives(id) ON DELETE CASCADE,
        dismissed_at timestamptz NOT NULL DEFAULT now())";
const DISMISS_MISSING: &str = "table drivelens.dismissed_suggestions is missing or not writable; run the v0.6.1 SQL (deploy/drivelens-v0.6.1.sql)";

/// Suggestion dismissal table usable (cached once true).
pub async fn dismiss_ok(s: &AppState) -> Result<bool, ApiError> {
    if s.dismiss_ok.load(Ordering::Relaxed) { return Ok(true); }
    let ok: bool = sqlx::query_scalar(
        "SELECT to_regclass('drivelens.dismissed_suggestions') IS NOT NULL
           AND has_table_privilege('drivelens.dismissed_suggestions', 'SELECT,INSERT,DELETE')").fetch_one(&s.db).await
        .or_else(|e| match &e { sqlx::Error::Database(_) => Ok(false), _ => Err(e) })?;
    if ok { s.dismiss_ok.store(true, Ordering::Relaxed); }
    Ok(ok)
}

pub async fn try_create_tables(db: &PgPool) {
    let d: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.dismissed_suggestions')::text").fetch_one(db).await.ok().flatten();
    if d.is_none() { let _ = sqlx::query(DISMISS_DDL).execute(db).await; }
    let has: Option<String> = sqlx::query_scalar("SELECT to_regclass('drivelens.journey_drives')::text").fetch_one(db).await.ok().flatten();
    if has.is_some() { return; }
    for q in DDL {
        if let Err(e) = sqlx::query(q).execute(db).await {
            tracing::warn!("journeys disabled: cannot create tables ({e}); run deploy/setup.sql and restart the API");
            return;
        }
    }
}

/// Both tables exist and are writable (cached once true).
pub async fn tables_ok(s: &AppState) -> Result<bool, ApiError> {
    if s.journeys_ok.load(Ordering::Relaxed) { return Ok(true); }
    let ok: bool = sqlx::query_scalar(
        "SELECT to_regclass('drivelens.journeys') IS NOT NULL AND to_regclass('drivelens.journey_drives') IS NOT NULL
           AND has_table_privilege('drivelens.journeys', 'SELECT,INSERT,UPDATE,DELETE')
           AND has_table_privilege('drivelens.journey_drives', 'SELECT,INSERT,UPDATE,DELETE')
           AND has_sequence_privilege('drivelens.journeys_id_seq', 'USAGE')").fetch_one(&s.db).await
        .or_else(|e| match &e { sqlx::Error::Database(_) => Ok(false), _ => Err(e) })?;
    if ok { s.journeys_ok.store(true, Ordering::Relaxed); }
    Ok(ok)
}

fn err(code: StatusCode, msg: &str) -> Response { (code, Json(serde_json::json!({"error": msg}))).into_response() }
macro_rules! need_tables { ($s:expr) => { if !tables_ok(&$s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)); } } }

/// "YYYY-MM-DDTHH:MM:SSZ" → unix seconds
fn epoch(t: &Option<String>) -> i64 {
    let Some(t) = t else { return 0 };
    let n = |a: usize, b: usize| t.get(a..b).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let (mut y, m, d) = (n(0, 4), n(5, 7), n(8, 10));
    if m <= 2 { y -= 1; }
    let era = y.div_euclid(400); let yoe = y - era * 400;
    let mp = (m + 9) % 12; let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146097 + doe - 719468) * 86400 + n(11, 13) * 3600 + n(14, 16) * 60 + n(17, 19)
}
fn haversine(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let (dl, dn) = (la2 - la1, (b.1 - a.1).to_radians());
    let h = (dl / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dn / 2.0).sin().powi(2);
    6371.0 * 2.0 * h.sqrt().asin()
}

#[derive(Serialize, FromRow)]
pub struct JourneyRow {
    id: i64, car_id: i64, name: String, note: Option<String>,
    start_date: Option<String>, end_date: Option<String>,
    start_address: Option<String>, end_address: Option<String>,
    drive_count: i64, distance_km: Option<f64>, duration_min: Option<i64>, energy_kwh: Option<f64>,
}

fn journey_list_sql(filter: &str) -> String {
    format!(r#"
      WITH s AS (
        SELECT jd.journey_id, count(*) AS drive_count, round(sum(d.distance)::numeric, 1)::float8 AS distance_km, sum(d.duration_min)::int8 AS duration_min,
               round(sum((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::numeric, 1)::float8 AS energy_kwh,
               min(d.start_date) AS s0, max(d.end_date) AS s1,
               (array_agg(d.id ORDER BY d.start_date))[1] AS first_id, (array_agg(d.id ORDER BY d.start_date DESC))[1] AS last_id
        FROM drivelens.journey_drives jd JOIN drives d ON d.id = jd.drive_id JOIN cars c ON c.id = d.car_id
        GROUP BY jd.journey_id)
      SELECT j.id::int8 AS id, j.car_id::int8 AS car_id, j.name, j.note,
        to_char(s.s0, '{TS}') AS start_date, to_char(s.s1, '{TS}') AS end_date,
        (SELECT COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city))
           FROM drives d LEFT JOIN addresses a ON a.id = d.start_address_id LEFT JOIN geofences g ON g.id = d.start_geofence_id
           LEFT JOIN drivelens.address_aliases al ON al.address_id = d.start_address_id WHERE d.id = s.first_id) AS start_address,
        (SELECT COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city))
           FROM drives d LEFT JOIN addresses a ON a.id = d.end_address_id LEFT JOIN geofences g ON g.id = d.end_geofence_id
           LEFT JOIN drivelens.address_aliases al ON al.address_id = d.end_address_id WHERE d.id = s.last_id) AS end_address,
        COALESCE(s.drive_count, 0)::int8 AS drive_count, s.distance_km, s.duration_min, s.energy_kwh
      FROM drivelens.journeys j LEFT JOIN s ON s.journey_id = j.id
      WHERE {filter}
      ORDER BY s.s0 DESC NULLS LAST, j.id DESC"#)
}

pub async fn list(State(s): State<AppState>, Query(q): Query<ListParams>) -> Result<Response, ApiError> {
    need_tables!(s);
    let rows = sqlx::query_as::<_, JourneyRow>(&format!("{} LIMIT $2 OFFSET $3", journey_list_sql("($1::int8 IS NULL OR j.car_id = $1)")))
        .bind(q.car_id).bind(q.limit()).bind(q.offset()).fetch_all(&s.db).await?;
    Ok(Json(rows).into_response())
}

#[derive(Deserialize)]
pub struct CreateBody { name: String, note: Option<String>, drive_ids: Vec<i64> }
#[derive(Deserialize)]
pub struct PatchBody { name: Option<String>, note: Option<Option<String>> }
#[derive(Deserialize)]
pub struct DrivesBody { drive_ids: Vec<i64> }

fn clean_name(n: &str) -> Result<String, Response> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 200 { return Err(err(StatusCode::BAD_REQUEST, "name must be 1-200 characters")); }
    Ok(n.to_string())
}
fn clean_note(n: Option<&str>) -> Result<Option<String>, Response> {
    let n = n.map(str::trim).filter(|x| !x.is_empty());
    if n.map_or(false, |x| x.chars().count() > 2000) { return Err(err(StatusCode::BAD_REQUEST, "note too long")); }
    Ok(n.map(String::from))
}

/// Checks drive ids: exist, finished, one car, not in another journey. Returns the car id.
async fn check_drives(db: &PgPool, ids: &[i64], own: Option<i64>) -> Result<Result<i64, Response>, ApiError> {
    let mut ids = ids.to_vec(); ids.sort(); ids.dedup();
    if ids.is_empty() || ids.len() > 500 { return Ok(Err(err(StatusCode::BAD_REQUEST, "drive_ids must contain 1-500 drives"))); }
    let rows: Vec<(i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT d.id::int8, d.car_id::int8, jd.journey_id::int8 FROM drives d
         LEFT JOIN drivelens.journey_drives jd ON jd.drive_id = d.id
         WHERE d.id = ANY($1::int4[]) AND d.end_date IS NOT NULL")
        .bind(ids.iter().map(|&i| i as i32).collect::<Vec<_>>()).fetch_all(db).await?;
    if rows.len() != ids.len() { return Ok(Err(err(StatusCode::NOT_FOUND, "some drives were not found"))); }
    let car = rows[0].1;
    if rows.iter().any(|r| r.1 != car) { return Ok(Err(err(StatusCode::BAD_REQUEST, "drives belong to different cars"))); }
    let taken: Vec<i64> = rows.iter().filter(|r| r.2.is_some() && r.2 != own).map(|r| r.0).collect();
    if !taken.is_empty() {
        return Ok(Err((StatusCode::CONFLICT, Json(serde_json::json!({"error": "some drives already belong to another journey", "drive_ids": taken}))).into_response()));
    }
    Ok(Ok(car))
}

pub async fn create(State(s): State<AppState>, Json(b): Json<CreateBody>) -> Result<Response, ApiError> {
    need_tables!(s);
    let name = match clean_name(&b.name) { Ok(n) => n, Err(r) => return Ok(r) };
    let note = match clean_note(b.note.as_deref()) { Ok(n) => n, Err(r) => return Ok(r) };
    let car = match check_drives(&s.db, &b.drive_ids, None).await? { Ok(c) => c, Err(r) => return Ok(r) };
    let mut tx = s.db.begin().await?;
    let id: i32 = sqlx::query_scalar("INSERT INTO drivelens.journeys (car_id, name, note) VALUES ($1, $2, $3) RETURNING id")
        .bind(car as i32).bind(&name).bind(&note).fetch_one(&mut *tx).await?;
    let ins = sqlx::query("INSERT INTO drivelens.journey_drives (journey_id, drive_id) SELECT $1, unnest($2::int4[])")
        .bind(id).bind(b.drive_ids.iter().map(|&i| i as i32).collect::<Vec<_>>()).execute(&mut *tx).await;
    if let Err(sqlx::Error::Database(e)) = &ins { if e.code().as_deref() == Some("23505") {
        return Ok(err(StatusCode::CONFLICT, "some drives already belong to another journey"));
    } }
    ins?;
    tx.commit().await?;
    detail(&s, id as i64).await
}

pub async fn update(State(s): State<AppState>, Path(id): Path<i64>, Json(b): Json<PatchBody>) -> Result<Response, ApiError> {
    need_tables!(s);
    let name = match b.name.as_deref().map(clean_name).transpose() { Ok(n) => n, Err(r) => return Ok(r) };
    let (set_note, note) = match &b.note { None => (false, None), Some(n) => match clean_note(n.as_deref()) { Ok(v) => (true, v), Err(r) => return Ok(r) } };
    let r = sqlx::query("UPDATE drivelens.journeys SET name = COALESCE($2, name), note = CASE WHEN $3 THEN $4 ELSE note END, updated_at = now() WHERE id = $1")
        .bind(id as i32).bind(name).bind(set_note).bind(note).execute(&s.db).await?;
    if r.rows_affected() == 0 { return Ok(err(StatusCode::NOT_FOUND, "journey not found")); }
    detail(&s, id).await
}

pub async fn delete(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    need_tables!(s);
    // journey_drives rows cascade; TeslaMate drives are untouched
    let r = sqlx::query("DELETE FROM drivelens.journeys WHERE id = $1").bind(id as i32).execute(&s.db).await?;
    Ok(if r.rows_affected() == 0 { err(StatusCode::NOT_FOUND, "journey not found") } else { StatusCode::NO_CONTENT.into_response() })
}

pub async fn set_drives(State(s): State<AppState>, Path(id): Path<i64>, Json(b): Json<DrivesBody>) -> Result<Response, ApiError> {
    need_tables!(s);
    let car: Option<i32> = sqlx::query_scalar("SELECT car_id FROM drivelens.journeys WHERE id = $1").bind(id as i32).fetch_optional(&s.db).await?;
    let Some(car) = car else { return Ok(err(StatusCode::NOT_FOUND, "journey not found")) };
    let dcar = match check_drives(&s.db, &b.drive_ids, Some(id)).await? { Ok(c) => c, Err(r) => return Ok(r) };
    if dcar != car as i64 { return Ok(err(StatusCode::BAD_REQUEST, "drives belong to a different car")); }
    let ids: Vec<i32> = b.drive_ids.iter().map(|&i| i as i32).collect();
    let mut tx = s.db.begin().await?;
    sqlx::query("DELETE FROM drivelens.journey_drives WHERE journey_id = $1 AND NOT (drive_id = ANY($2))").bind(id as i32).bind(&ids).execute(&mut *tx).await?;
    let ins = sqlx::query("INSERT INTO drivelens.journey_drives (journey_id, drive_id) SELECT $1, unnest($2::int4[]) ON CONFLICT (drive_id) DO NOTHING")
        .bind(id as i32).bind(&ids).execute(&mut *tx).await;
    ins?;
    // a concurrent request may have grabbed one of the drives: verify
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM drivelens.journey_drives WHERE journey_id = $1").bind(id as i32).fetch_one(&mut *tx).await?;
    if n != ids.len() as i64 { tx.rollback().await?; return Ok(err(StatusCode::CONFLICT, "some drives already belong to another journey")); }
    sqlx::query("UPDATE drivelens.journeys SET updated_at = now() WHERE id = $1").bind(id as i32).execute(&mut *tx).await?;
    tx.commit().await?;
    detail(&s, id).await
}

#[derive(Serialize, Default)]
struct Money { currency: String, amount: f64 }
#[derive(Serialize)]
struct Stop {
    after_drive_id: i64, before_drive_id: i64, start_date: Option<String>, end_date: Option<String>, duration_min: i64,
    address: Option<String>, lat: Option<f64>, lng: Option<f64>, charge_ids: Vec<i64>, charged_kwh: f64,
}
#[derive(Serialize, Default)]
struct JSummary {
    start_date: Option<String>, end_date: Option<String>, start_address: Option<String>, end_address: Option<String>,
    distance_km: f64, driving_min: i64, stop_min: i64, elapsed_min: i64, energy_used_kwh: f64,
    charged_kwh: f64, charge_count: i64, costs: Vec<Money>, efficiency_wh_km: Option<f64>, speed_max: Option<i32>,
}
#[derive(Serialize)]
struct Detail {
    id: i64, car_id: i64, name: String, note: Option<String>,
    /// v0.7.0: a custom cover is stored (GET /journeys/:id/cover)
    has_cover: bool,
    summary: JSummary, drives: Vec<Drive>, charges: Vec<ChargeSummary>, stops: Vec<Stop>,
    /// nearby drives (±24 h) that can be added; journey_id set when they belong to another journey
    candidates: Vec<Drive>,
}

pub async fn get(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    need_tables!(s);
    detail(&s, id).await
}

async fn detail(s: &AppState, id: i64) -> Result<Response, ApiError> {
    let j: Option<(i64, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id::int8, car_id::int8, name, note FROM drivelens.journeys WHERE id = $1").bind(id as i32).fetch_optional(&s.db).await?;
    let Some((id, car_id, name, note)) = j else { return Ok(err(StatusCode::NOT_FOUND, "journey not found")) };
    let drives = sqlx::query_as::<_, Drive>(&format!(
        "{} WHERE d.id IN (SELECT drive_id FROM drivelens.journey_drives WHERE journey_id = $1) ORDER BY d.start_date", drive_select(true)))
        .bind(id as i32).fetch_all(&s.db).await?;
    let (t0, t1) = (drives.first().map(|d| d.start_date.clone()), drives.last().map(|d| d.end_date.clone()));
    let costs = costs_ok(s).await?;
    // charges that started between the first drive's start and the last drive's end
    let (charges, candidates) = if let (Some(Some(a)), Some(Some(b))) = (&t0, &t1) {
        let ch = sqlx::query_as::<_, ChargeSummary>(&format!(
            "{} WHERE cp.car_id = $1 AND cp.start_date >= $2::timestamp AND cp.start_date <= $3::timestamp AND cp.end_date IS NOT NULL ORDER BY cp.start_date",
            charge_select(costs))).bind(car_id).bind(a.trim_end_matches('Z')).bind(b.trim_end_matches('Z')).fetch_all(&s.db).await?;
        let cand = sqlx::query_as::<_, Drive>(&format!(
            "{} WHERE d.car_id = $1 AND d.start_date >= $2::timestamp - interval '24 hours' AND d.start_date <= $3::timestamp + interval '24 hours'
               AND d.end_date IS NOT NULL AND d.id NOT IN (SELECT drive_id FROM drivelens.journey_drives WHERE journey_id = $4)
             ORDER BY d.start_date", drive_select(true)))
            .bind(car_id).bind(a.trim_end_matches('Z')).bind(b.trim_end_matches('Z')).bind(id as i32).fetch_all(&s.db).await?;
        (ch, cand)
    } else { (vec![], vec![]) };

    let mut sm = JSummary::default();
    if let (Some(f), Some(l)) = (drives.first(), drives.last()) {
        sm.start_date = f.start_date.clone(); sm.end_date = l.end_date.clone();
        sm.start_address = f.start_address.clone(); sm.end_address = l.end_address.clone();
        sm.elapsed_min = (epoch(&l.end_date) - epoch(&f.start_date)) / 60;
    }
    for d in &drives {
        sm.distance_km += d.distance_km.unwrap_or(0.0);
        sm.driving_min += d.duration_min.unwrap_or(0) as i64;
        sm.energy_used_kwh += d.energy_kwh.unwrap_or(0.0).max(0.0);
        sm.speed_max = sm.speed_max.max(d.speed_max);
    }
    sm.stop_min = (sm.elapsed_min - sm.driving_min).max(0);
    for c in &charges {
        sm.charged_kwh += c.charge_energy_added.unwrap_or(0.0); sm.charge_count += 1;
        if let Some(a) = c.cost {
            let cur = c.currency.clone().or(c.default_currency.clone()).unwrap_or_else(|| "JPY".into());
            match sm.costs.iter_mut().find(|m| m.currency == cur) { Some(m) => m.amount += a, None => sm.costs.push(Money { currency: cur, amount: a }) }
        }
    }
    for m in &mut sm.costs { m.amount = (m.amount * 100.0).round() / 100.0; }
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    sm.efficiency_wh_km = (sm.distance_km > 0.0).then(|| r1(sm.energy_used_kwh * 1000.0 / sm.distance_km));
    sm.distance_km = r1(sm.distance_km); sm.energy_used_kwh = r1(sm.energy_used_kwh); sm.charged_kwh = r1(sm.charged_kwh);

    let stops = drives.windows(2).map(|w| {
        let (a, b) = (epoch(&w[0].end_date), epoch(&w[1].start_date));
        let ch: Vec<&ChargeSummary> = charges.iter().filter(|c| { let t = epoch(&c.start_date); t >= a - 120 && t <= b }).collect();
        Stop { after_drive_id: w[0].id, before_drive_id: w[1].id, start_date: w[0].end_date.clone(), end_date: w[1].start_date.clone(),
            duration_min: ((b - a) / 60).max(0), address: w[0].end_address.clone(), lat: w[0].end_lat, lng: w[0].end_lng,
            charge_ids: ch.iter().map(|c| c.id).collect(), charged_kwh: r1(ch.iter().map(|c| c.charge_energy_added.unwrap_or(0.0)).sum()) }
    }).collect();
    let has_cover = super::phase2::has_cover(s, id).await?;
    Ok(Json(Detail { id, car_id, name, note, has_cover, summary: sm, drives, charges, stops, candidates }).into_response())
}

#[derive(Deserialize)]
pub struct SuggestParams { car_id: Option<i64>, gap_min: Option<i64>, charge_gap_min: Option<i64>, limit: Option<i64> }

#[derive(Serialize)]
struct Suggestion {
    drive_ids: Vec<i64>, name: String, start_date: Option<String>, end_date: Option<String>,
    start_address: Option<String>, end_address: Option<String>, distance_km: f64, duration_min: i64, charge_count: usize,
}

/// Consecutive ungrouped drives with a short gap (< gap_min, default 60) or a gap with a charge
/// in between (< charge_gap_min, default 120) → one suggestion (max span 3 days). Looks at the latest 400 drives.
/// Drives that already belong to a journey or were dismissed (drivelens.dismissed_suggestions) are
/// skipped and break a chain, so a dismissed suggestion never comes back; drives recorded later can
/// still form a new suggestion of their own.
pub async fn suggestions(State(s): State<AppState>, Query(q): Query<SuggestParams>) -> Result<Response, ApiError> {
    need_tables!(s);
    let gap = q.gap_min.unwrap_or(60).clamp(1, 24 * 60) * 60;
    let cgap = q.charge_gap_min.unwrap_or(120).clamp(1, 24 * 60) * 60;
    let limit = q.limit.unwrap_or(10).clamp(1, 50) as usize;
    let car = match q.car_id { Some(c) => c, None => sqlx::query_scalar::<_, i32>("SELECT id::int4 FROM cars ORDER BY display_priority, id LIMIT 1")
        .fetch_optional(&s.db).await?.map(i64::from).unwrap_or(0) };
    let mut drives = sqlx::query_as::<_, Drive>(&format!(
        "{} WHERE d.car_id = $1 AND d.end_date IS NOT NULL ORDER BY d.start_date DESC LIMIT 400", drive_select(true)))
        .bind(car).fetch_all(&s.db).await?;
    drives.reverse();
    let dismissed: std::collections::HashSet<i64> = if dismiss_ok(&s).await? {
        sqlx::query_scalar::<_, i64>("SELECT drive_id::int8 FROM drivelens.dismissed_suggestions WHERE drive_id = ANY($1::int4[])")
            .bind(drives.iter().map(|d| d.id as i32).collect::<Vec<_>>()).fetch_all(&s.db).await?.into_iter().collect()
    } else { Default::default() };
    let Some(first) = drives.first() else { return Ok(Json(Vec::<Suggestion>::new()).into_response()) };
    let charge_starts: Vec<i64> = sqlx::query_scalar::<_, String>(&format!(
        "SELECT to_char(start_date, '{TS}') FROM charging_processes WHERE car_id = $1 AND start_date >= $2::timestamp ORDER BY start_date"))
        .bind(car).bind(first.start_date.clone().unwrap_or_default().trim_end_matches('Z').to_string())
        .fetch_all(&s.db).await?.into_iter().map(|t| epoch(&Some(t))).collect();
    let charges_between = |a: i64, b: i64| charge_starts.iter().filter(|&&t| t >= a - 120 && t <= b).count();

    let mut groups: Vec<(Vec<usize>, usize)> = vec![];
    let mut cur: Vec<usize> = vec![]; let mut cc = 0;
    for i in 0..drives.len() {
        if drives[i].journey_id.is_some() || dismissed.contains(&drives[i].id) { if cur.len() > 1 { groups.push((cur.clone(), cc)); } cur.clear(); cc = 0; continue; }
        if let Some(&last) = cur.last() {
            let (a, b) = (epoch(&drives[last].end_date), epoch(&drives[i].start_date));
            let n = charges_between(a, b);
            // a suggestion never spans more than 3 days (avoids chaining a whole commute history)
            let span_ok = epoch(&drives[i].end_date) - epoch(&drives[cur[0]].start_date) <= 3 * 86400;
            if span_ok && ((b - a) < gap || (n > 0 && (b - a) < cgap)) { cur.push(i); cc += n; continue; }
            if cur.len() > 1 { groups.push((cur.clone(), cc)); }
        }
        cur = vec![i]; cc = 0;
    }
    if cur.len() > 1 { groups.push((cur, cc)); }

    let out: Vec<Suggestion> = groups.into_iter().rev().take(limit).map(|(g, cc)| {
        let ds: Vec<&Drive> = g.iter().map(|&i| &drives[i]).collect();
        let (f, l) = (ds[0], ds[ds.len() - 1]);
        // name: start → farthest point (往返 when it ends near the start)
        let origin = f.start_lat.zip(f.start_lng);
        let far = origin.and_then(|o| ds.iter().filter_map(|d| d.end_lat.zip(d.end_lng).map(|p| (haversine(o, p), d)))
            .max_by(|a, b| a.0.total_cmp(&b.0)));
        let round = origin.zip(l.end_lat.zip(l.end_lng)).map_or(false, |(o, e)| haversine(o, e) < 1.0);
        let dest = far.map(|(_, d)| d.end_address.clone()).unwrap_or(l.end_address.clone());
        let name = format!("{} → {}{}", f.start_address.clone().unwrap_or_else(|| "?".into()), dest.unwrap_or_else(|| "?".into()), if round { "（往返）" } else { "" });
        Suggestion { drive_ids: ds.iter().map(|d| d.id).collect(), name, start_date: f.start_date.clone(), end_date: l.end_date.clone(),
            start_address: f.start_address.clone(), end_address: l.end_address.clone(),
            distance_km: (ds.iter().map(|d| d.distance_km.unwrap_or(0.0)).sum::<f64>() * 10.0).round() / 10.0,
            duration_min: ds.iter().map(|d| d.duration_min.unwrap_or(0) as i64).sum(), charge_count: cc }
    }).collect();
    Ok(Json(out).into_response())
}

#[derive(FromRow)]
struct Pos { drive_id: i64, lat: f64, lng: f64, speed: Option<i32>, elevation: Option<i32> }
#[derive(Serialize)]
struct JPoint { drive_id: i64, lat: f64, lng: f64, speed: Option<i32>, elevation: Option<i32>, km: f64 }
#[derive(Serialize)]
struct JPath { points: Vec<JPoint>, total_points: usize, downsampled: bool }

const MAX_POINTS: usize = 3000;

/// All drive paths of a journey, in time order, with cumulative distance (km, computed on the full
/// track) and downsampled to ≤ ~3000 points (first/last point of every drive is kept).
/// Uses positions' BRIN (date) index via the journey's time window + car_id.
pub async fn path(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Response, ApiError> {
    need_tables!(s);
    let w: Option<(i64, Option<String>, Option<String>, Vec<i32>)> = sqlx::query_as(
        "SELECT j.car_id::int8, to_char(min(d.start_date), 'YYYY-MM-DD HH24:MI:SS'), to_char(max(d.end_date), 'YYYY-MM-DD HH24:MI:SS'), array_agg(d.id)
         FROM drivelens.journeys j JOIN drivelens.journey_drives jd ON jd.journey_id = j.id JOIN drives d ON d.id = jd.drive_id
         WHERE j.id = $1 GROUP BY j.car_id").bind(id as i32).fetch_optional(&s.db).await?;
    let Some((car, Some(t0), Some(t1), ids)) = w else {
        let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM drivelens.journeys WHERE id = $1").bind(id as i32).fetch_optional(&s.db).await?;
        return Ok(if exists.is_some() { Json(JPath { points: vec![], total_points: 0, downsampled: false }).into_response() } else { err(StatusCode::NOT_FOUND, "journey not found") });
    };
    let rows = sqlx::query_as::<_, Pos>(
        "SELECT drive_id::int8 AS drive_id, latitude::float8 AS lat, longitude::float8 AS lng, speed::int4 AS speed, elevation::int4 AS elevation
         FROM positions WHERE car_id = $1 AND positions.date >= $2::timestamp AND positions.date <= $3::timestamp AND drive_id = ANY($4)
         ORDER BY positions.date")
        .bind(car as i16).bind(&t0).bind(&t1).bind(&ids).fetch_all(&s.db).await?;
    let total = rows.len();
    let step = total.div_ceil(MAX_POINTS).max(1);
    let mut km = 0.0; let mut out = Vec::with_capacity(total.min(MAX_POINTS + 2 * ids.len()));
    for i in 0..total {
        let p = &rows[i];
        let same_prev = i > 0 && rows[i - 1].drive_id == p.drive_id;
        if same_prev { km += haversine((rows[i - 1].lat, rows[i - 1].lng), (p.lat, p.lng)); }
        let edge = !same_prev || i + 1 == total || rows[i + 1].drive_id != p.drive_id;
        if edge || i % step == 0 {
            out.push(JPoint { drive_id: p.drive_id, lat: p.lat, lng: p.lng, speed: p.speed, elevation: p.elevation, km: (km * 100.0).round() / 100.0 });
        }
    }
    Ok(Json(JPath { points: out, total_points: total, downsampled: step > 1 }).into_response())
}

#[derive(Deserialize)]
pub struct DismissBody { drive_ids: Vec<i64> }

/// Dismiss a suggestion: remembers its drives so they are no longer suggested.
pub async fn dismiss(State(s): State<AppState>, Json(b): Json<DismissBody>) -> Result<Response, ApiError> {
    if !dismiss_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, DISMISS_MISSING)); }
    if b.drive_ids.is_empty() || b.drive_ids.len() > 1000 { return Ok(err(StatusCode::BAD_REQUEST, "drive_ids must contain 1-1000 drives")); }
    let r = sqlx::query(
        "INSERT INTO drivelens.dismissed_suggestions (drive_id)
         SELECT d.id FROM drives d WHERE d.id = ANY($1::int4[]) ON CONFLICT (drive_id) DO NOTHING")
        .bind(b.drive_ids.iter().map(|&i| i as i32).collect::<Vec<_>>()).execute(&s.db).await?;
    Ok(Json(serde_json::json!({"dismissed": r.rows_affected()})).into_response())
}

/// Restore all dismissed suggestions.
pub async fn restore_dismissed(State(s): State<AppState>) -> Result<Response, ApiError> {
    if !dismiss_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, DISMISS_MISSING)); }
    let r = sqlx::query("DELETE FROM drivelens.dismissed_suggestions").execute(&s.db).await?;
    Ok(Json(serde_json::json!({"restored": r.rows_affected()})).into_response())
}

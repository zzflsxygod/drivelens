// SPDX-License-Identifier: AGPL-3.0-or-later
//! Monthly report: GET /api/cars/:id/report?month=YYYY-MM&tz=Asia/Tokyo
//! Read-only. Reads only drives / charging_processes (+ an indexed per-process probe of `charges`), never positions.
//!
//! Charge type rule (3 buckets):
//! - 超充 (supercharger): a DC session (any `charges` row with `fast_charger_present`) that is a Tesla
//!   Supercharger — any row with `fast_charger_brand` = "Tesla" (case-insensitive) or `fast_charger_type`
//!   starting with "Tesla" (same signals TeslaMate uses for free-SuC cost / Grafana SuC panels), OR the
//!   place alias / geofence / address name matches `(supercharger|超充|スーパーチャージャー|tesla)` as a
//!   fallback when the car reports `<invalid>` / null for brand and type.
//! - 家充 (home): an AC session (not DC) at a home-named place (alias/geofence containing home/自宅/家/うち),
//!   or at the car's most frequent AC charging location over the last 12 months.
//! - 其他 (other): everything else (other AC, and non-Tesla DC fast chargers such as CHAdeMO / CCS).
use super::*;
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub struct ReportParams { month: Option<String>, tz: Option<String>, currency: Option<String> }

#[derive(Serialize, Default, Clone)]
pub struct Money { currency: String, amount: f64 }

fn add_money(v: &mut Vec<Money>, cur: &str, amount: f64) {
    match v.iter_mut().find(|m| m.currency == cur) {
        Some(m) => m.amount += amount,
        None => { v.push(Money { currency: cur.to_string(), amount }); v.sort_by(|a, b| a.currency.cmp(&b.currency)); }
    }
}
fn round_money(v: &mut [Money]) { for m in v { m.amount = (m.amount * 100.0).round() / 100.0; } }

#[derive(Serialize, Default)]
pub struct Overview {
    distance_km: f64,
    drive_duration_min: i64,
    drive_count: i64,
    energy_used_kwh: f64,
    energy_added_kwh: f64,
    charge_count: i64,
    costs: Vec<Money>,
    efficiency_wh_km: Option<f64>,
}

#[derive(Serialize)]
pub struct Bucket { kind: &'static str, count: i64, energy_kwh: f64, costs: Vec<Money> }

#[derive(Serialize)]
pub struct Day { date: String, distance_km: f64, energy_added_kwh: f64 }

#[derive(Serialize)]
pub struct DriveRecord { id: i64, start_date: Option<String>, start_address: Option<String>, end_address: Option<String>,
    distance_km: Option<f64>, duration_min: Option<i32>, speed_max: Option<i32> }
#[derive(Serialize)]
pub struct ChargeRecord { id: i64, start_date: Option<String>, address: Option<String>, energy_kwh: Option<f64>,
    cost: Option<f64>, currency: Option<String>, peak_kw: Option<f64>, start_battery_level: Option<i32>,
    end_battery_level: Option<i32>, duration_min: Option<i32> }

#[derive(Serialize)]
pub struct Records { longest_drive: Option<DriveRecord>, top_speed_drive: Option<DriveRecord>,
    most_expensive_charge: Option<ChargeRecord>, fastest_charge: Option<ChargeRecord> }

#[derive(Serialize)]
pub struct Report {
    month: String, timezone: String, is_current: bool, first_month: Option<String>,
    /// local date range covered so far (for the current month: up to today)
    days_in_month: i32, days_elapsed: i32,
    overview: Overview, previous: Overview,
    split: Vec<Bucket>, daily: Vec<Day>, records: Records,
}

#[derive(FromRow)]
pub(crate) struct DriveRow { pub(crate) id: i64, start_date: Option<String>, day: Option<String>, start_address: Option<String>, end_address: Option<String>,
    distance_km: Option<f64>, duration_min: Option<i32>, speed_max: Option<i32>, energy_kwh: Option<f64>, cur: bool }

#[derive(FromRow)]
pub(crate) struct ChargeRow { id: i64, start_date: Option<String>, day: Option<String>, address: Option<String>, energy_kwh: Option<f64>,
    cost: Option<f64>, currency: Option<String>, kind: String, peak_kw: Option<f64>, start_battery_level: Option<i32>,
    end_battery_level: Option<i32>, duration_min: Option<i32>, cur: bool }

#[derive(FromRow)]
struct Bounds { month: String, p0: String, m0: String, m1: String, is_current: bool, days_in_month: i32, days_elapsed: i32 }

const PLACE: &str = "COALESCE(al.name, g.name, CONCAT_WS(', ', COALESCE(a.name, NULLIF(CONCAT_WS(' ', a.road, a.house_number), '')), a.city))";

fn valid_month(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
        && matches!(m[5..].parse::<u32>(), Ok(1..=12))
}

pub async fn car_report(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<ReportParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    if let Some(m) = &p.month { if !valid_month(m) { return Ok(bad("month must be YYYY-MM")); } }
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let def_cur = p.currency.map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())).unwrap_or_else(|| "JPY".into());
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM cars WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    if exists.is_none() { return Ok((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "car not found"}))).into_response()); }

    // Month boundaries in the user's tz, expressed as TeslaMate's naive-UTC timestamps.
    let bounds = sqlx::query_as::<_, Bounds>(
        "WITH x AS (SELECT COALESCE($1::text, to_char(now() AT TIME ZONE $2, 'YYYY-MM')) AS month),
              l AS (SELECT month, (month || '-01')::timestamp AS lm0 FROM x)
         SELECT month,
           to_char(((lm0 - interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS p0,
           to_char((lm0 AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS m0,
           to_char(((lm0 + interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS m1,
           month = to_char(now() AT TIME ZONE $2, 'YYYY-MM') AS is_current,
           extract(day from lm0 + interval '1 month' - interval '1 day')::int4 AS days_in_month,
           LEAST(GREATEST(extract(day from (now() AT TIME ZONE $2) - lm0)::int4 + 1, 0),
                 extract(day from lm0 + interval '1 month' - interval '1 day')::int4) AS days_elapsed
         FROM l",
    ).bind(&p.month).bind(&tz).fetch_one(&s.db).await;
    let b = match bounds {
        Ok(b) => b,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };
    if b.month.as_str() > sqlx::query_scalar::<_, String>("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM')").bind(&tz).fetch_one(&s.db).await?.as_str() {
        return Ok(bad("month is in the future"));
    }
    let costs = costs_ok(&s).await?;
    let (cc_amount, cc_cur, cc_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)", format!("COALESCE(cc.currency::text, {LOC_CURRENCY})"), "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", LOC_CURRENCY.to_string(), "") };

    let drives_sql = drives_sql();
    let charges_sql = charges_sql(cc_amount, &cc_cur, cc_join);
    let (drives, charges, first) = tokio::try_join!(
        sqlx::query_as::<_, DriveRow>(&drives_sql).bind(id).bind(&b.p0).bind(&b.m0).bind(&b.m1).bind(&tz).fetch_all(&s.db),
        sqlx::query_as::<_, ChargeRow>(&charges_sql).bind(id).bind(&b.p0).bind(&b.m0).bind(&b.m1).bind(&tz).fetch_all(&s.db),
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT to_char((min(start_date) AT TIME ZONE 'UTC') AT TIME ZONE $2, 'YYYY-MM') FROM drives WHERE car_id = $1").bind(id).bind(&tz).fetch_one(&s.db),
    )?;

    let (mut ov, mut prev) = (Overview::default(), Overview::default());
    let mut days: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for i in 0..b.days_in_month { days.insert(format!("{}-{:02}", b.month, i + 1), (0.0, 0.0)); }
    for d in &drives {
        let o = if d.cur { &mut ov } else { &mut prev };
        o.distance_km += d.distance_km.unwrap_or(0.0);
        o.drive_duration_min += d.duration_min.unwrap_or(0) as i64;
        o.drive_count += 1;
        o.energy_used_kwh += d.energy_kwh.unwrap_or(0.0).max(0.0);
        if d.cur { if let Some(e) = d.day.as_ref().and_then(|k| days.get_mut(k)) { e.0 += d.distance_km.unwrap_or(0.0); } }
    }
    let mut split: Vec<Bucket> = ["home", "supercharger", "other"].iter()
        .map(|k| Bucket { kind: k, count: 0, energy_kwh: 0.0, costs: vec![] }).collect();
    for c in &charges {
        let cur = c.currency.clone().unwrap_or_else(|| def_cur.clone());
        let o = if c.cur { &mut ov } else { &mut prev };
        o.energy_added_kwh += c.energy_kwh.unwrap_or(0.0);
        o.charge_count += 1;
        if let Some(a) = c.cost { add_money(&mut o.costs, &cur, a); }
        if c.cur {
            if let Some(e) = c.day.as_ref().and_then(|k| days.get_mut(k)) { e.1 += c.energy_kwh.unwrap_or(0.0); }
            let bk = split.iter_mut().find(|x| x.kind == c.kind).unwrap();
            bk.count += 1; bk.energy_kwh += c.energy_kwh.unwrap_or(0.0);
            if let Some(a) = c.cost { add_money(&mut bk.costs, &cur, a); }
        }
    }
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    for o in [&mut ov, &mut prev] {
        o.efficiency_wh_km = (o.distance_km > 0.0).then(|| r1(o.energy_used_kwh * 1000.0 / o.distance_km));
        o.distance_km = r1(o.distance_km); o.energy_used_kwh = r1(o.energy_used_kwh); o.energy_added_kwh = r1(o.energy_added_kwh);
        round_money(&mut o.costs);
    }
    for bk in &mut split { bk.energy_kwh = r1(bk.energy_kwh); round_money(&mut bk.costs); }

    let cur_d: Vec<&DriveRow> = drives.iter().filter(|d| d.cur).collect();
    let cur_c: Vec<&ChargeRow> = charges.iter().filter(|c| c.cur).collect();
    let dr = |d: &DriveRow| DriveRecord { id: d.id, start_date: d.start_date.clone(), start_address: d.start_address.clone(),
        end_address: d.end_address.clone(), distance_km: d.distance_km, duration_min: d.duration_min, speed_max: d.speed_max };
    let cr = |c: &ChargeRow| ChargeRecord { id: c.id, start_date: c.start_date.clone(), address: c.address.clone(), energy_kwh: c.energy_kwh,
        cost: c.cost, currency: c.cost.map(|_| c.currency.clone().unwrap_or_else(|| def_cur.clone())), peak_kw: c.peak_kw,
        start_battery_level: c.start_battery_level, end_battery_level: c.end_battery_level, duration_min: c.duration_min };
    let fmax = |a: Option<f64>, b: Option<f64>| a.unwrap_or(f64::MIN).total_cmp(&b.unwrap_or(f64::MIN));
    // Most expensive: compare within the main currency (default currency first), other currencies only if none.
    let exp = cur_c.iter().filter(|c| c.cost.is_some() && c.currency.as_deref().unwrap_or(&def_cur) == def_cur)
        .max_by(|a, b| fmax(a.cost, b.cost))
        .or_else(|| cur_c.iter().filter(|c| c.cost.is_some()).max_by(|a, b| fmax(a.cost, b.cost)));
    let records = Records {
        longest_drive: cur_d.iter().filter(|d| d.distance_km.is_some()).max_by(|a, b| fmax(a.distance_km, b.distance_km)).map(|d| dr(d)),
        top_speed_drive: cur_d.iter().filter(|d| d.speed_max.is_some()).max_by_key(|d| d.speed_max).map(|d| dr(d)),
        most_expensive_charge: exp.map(|c| cr(c)),
        fastest_charge: cur_c.iter().filter(|c| c.peak_kw.unwrap_or(0.0) > 0.0).max_by(|a, b| fmax(a.peak_kw, b.peak_kw)).map(|c| cr(c)),
    };
    let daily = days.into_iter().map(|(date, (km, kwh))| Day { date, distance_km: r1(km), energy_added_kwh: r1(kwh) }).collect();
    Ok(Json(Report { month: b.month, timezone: tz, is_current: b.is_current, first_month: first, days_in_month: b.days_in_month,
        days_elapsed: b.days_elapsed, overview: ov, previous: prev, split, daily, records }).into_response())
}

pub(crate) fn drives_sql() -> String { format!(
        r#"SELECT d.id::int8 AS id, to_char(d.start_date, '{TS}') AS start_date,
             to_char((d.start_date AT TIME ZONE 'UTC') AT TIME ZONE $5, 'YYYY-MM-DD') AS day,
             COALESCE(sal.name, gs.name, CONCAT_WS(', ', COALESCE(sa.name, NULLIF(CONCAT_WS(' ', sa.road, sa.house_number), '')), sa.city)) AS start_address,
             COALESCE(eal.name, ge.name, CONCAT_WS(', ', COALESCE(ea.name, NULLIF(CONCAT_WS(' ', ea.road, ea.house_number), '')), ea.city)) AS end_address,
             d.distance::float8 AS distance_km, d.duration_min::int4 AS duration_min, d.speed_max::int4 AS speed_max,
             ((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::float8 AS energy_kwh,
             d.start_date >= $3::timestamp AS cur
           FROM drives d JOIN cars c ON c.id = d.car_id
           LEFT JOIN addresses sa ON sa.id = d.start_address_id
           LEFT JOIN addresses ea ON ea.id = d.end_address_id
           LEFT JOIN drivelens.address_aliases sal ON sal.address_id = d.start_address_id
           LEFT JOIN drivelens.address_aliases eal ON eal.address_id = d.end_address_id
           LEFT JOIN geofences gs ON gs.id = d.start_geofence_id
           LEFT JOIN geofences ge ON ge.id = d.end_geofence_id
           WHERE d.car_id = $1 AND d.start_date >= $2::timestamp AND d.start_date < $4::timestamp AND d.end_date IS NOT NULL"#
    ) }
// home_addr: most frequent AC-rate (< 22 kW average) charging location in the last 12 months — no charges scan needed.
pub(crate) fn charges_sql(cc_amount: &str, cc_cur: &str, cc_join: &str) -> String { format!(
        r#"WITH home_addr AS (
             SELECT address_id FROM charging_processes
             WHERE car_id = $1 AND address_id IS NOT NULL AND start_date >= $4::timestamp - interval '12 months'
               AND duration_min > 0 AND charge_energy_added * 60 / duration_min < 22
             GROUP BY address_id ORDER BY count(*) DESC LIMIT 1)
           SELECT cp.id::int8 AS id, to_char(cp.start_date, '{TS}') AS start_date,
             to_char((cp.start_date AT TIME ZONE 'UTC') AT TIME ZONE $5, 'YYYY-MM-DD') AS day,
             {PLACE} AS address, cp.charge_energy_added::float8 AS energy_kwh,
             {cc_amount}::float8 AS cost, {cc_cur} AS currency,
             CASE WHEN fx.fast AND (fx.tesla_fc
                       OR CONCAT_WS(' ', al.name, g.name, a.name, a.display_name) ~* '(supercharger|超充|スーパーチャージャー|tesla)') THEN 'supercharger'
                  WHEN NOT fx.fast AND (CONCAT_WS(' ', al.name, g.name) ~* '(home|自宅|家|うち|house)'
                       OR cp.address_id = (SELECT address_id FROM home_addr)) THEN 'home'
                  ELSE 'other' END AS kind,
             fx.peak_kw, cp.start_battery_level::int4 AS start_battery_level, cp.end_battery_level::int4 AS end_battery_level,
             cp.duration_min::int4 AS duration_min, cp.start_date >= $3::timestamp AS cur
           FROM charging_processes cp
           LEFT JOIN addresses a ON a.id = cp.address_id
           LEFT JOIN drivelens.address_aliases al ON al.address_id = cp.address_id
           LEFT JOIN geofences g ON g.id = cp.geofence_id
           LEFT JOIN positions p ON p.id = cp.position_id
           {cc_join}
           -- per-process probe via TeslaMate's charges(charging_process_id) index
           CROSS JOIN LATERAL (SELECT COALESCE(bool_or(ch.fast_charger_present), false) AS fast,
                                      COALESCE(bool_or(
                                        ch.fast_charger_brand ~* '^tesla$'
                                        OR ch.fast_charger_type ~* '^tesla'
                                      ), false) AS tesla_fc,
                                      max(ch.charger_power)::float8 AS peak_kw
                               FROM charges ch WHERE ch.charging_process_id = cp.id) fx
           WHERE cp.car_id = $1 AND cp.start_date >= $2::timestamp AND cp.start_date < $4::timestamp AND cp.end_date IS NOT NULL"#
    ) }

// ---------------- 12-month trends (api_level 12) ----------------
#[derive(Serialize, Default)]
pub struct TrendMonth { month: String, distance_km: f64, energy_used_kwh: f64, energy_added_kwh: f64, efficiency_wh_km: Option<f64>,
    drive_count: i64, charge_count: i64, costs: Vec<Money>, home_kwh: f64, supercharger_kwh: f64, other_kwh: f64 }

/// GET /api/cars/:id/trends?month=YYYY-MM&tz=&currency= → the 12 months ending with `month` (same rules as the report).
pub async fn car_trends(State(s): State<AppState>, Path(id): Path<i64>, Query(p): Query<ReportParams>) -> Result<Response, ApiError> {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": m}))).into_response();
    if let Some(m) = &p.month { if !valid_month(m) { return Ok(bad("month must be YYYY-MM")); } }
    let tz = p.tz.unwrap_or_else(|| "UTC".into());
    let def_cur = p.currency.map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase())).unwrap_or_else(|| "JPY".into());
    let r: Result<(String, String, Vec<String>), _> = sqlx::query_as(
        "WITH x AS (SELECT (COALESCE($1::text, to_char(now() AT TIME ZONE $2, 'YYYY-MM')) || '-01')::timestamp AS lm0)
         SELECT to_char(((lm0 - interval '11 months') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                to_char(((lm0 + interval '1 month') AT TIME ZONE $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
                ARRAY(SELECT to_char(lm0 - make_interval(months => g), 'YYYY-MM') FROM generate_series(11, 0, -1) g)
         FROM x").bind(&p.month).bind(&tz).fetch_one(&s.db).await;
    let (t0, t1, months) = match r {
        Ok(v) => v,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("22023") => return Ok(bad("unknown tz")),
        Err(e) => return Err(e.into()),
    };
    let costs = costs_ok(&s).await?;
    let (cc_amount, cc_cur, cc_join) = if costs {
        ("COALESCE(cc.amount, cp.cost)", format!("COALESCE(cc.currency::text, {LOC_CURRENCY})"), "LEFT JOIN drivelens.charge_costs cc ON cc.charging_process_id = cp.id")
    } else { ("cp.cost", LOC_CURRENCY.to_string(), "") };
    let (dsql, csql) = (drives_sql(), charges_sql(cc_amount, &cc_cur, cc_join));
    let (drives, charges) = tokio::try_join!(
        sqlx::query_as::<_, DriveRow>(&dsql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
        sqlx::query_as::<_, ChargeRow>(&csql).bind(id).bind(&t0).bind(&t0).bind(&t1).bind(&tz).fetch_all(&s.db),
    )?;
    let mut by: BTreeMap<String, TrendMonth> = months.iter().map(|m| (m.clone(), TrendMonth { month: m.clone(), ..Default::default() })).collect();
    for d in &drives {
        let Some(m) = d.day.as_ref().and_then(|x| by.get_mut(&x[..7])) else { continue };
        m.distance_km += d.distance_km.unwrap_or(0.0); m.energy_used_kwh += d.energy_kwh.unwrap_or(0.0).max(0.0); m.drive_count += 1;
    }
    for c in &charges {
        let Some(m) = c.day.as_ref().and_then(|x| by.get_mut(&x[..7])) else { continue };
        let e = c.energy_kwh.unwrap_or(0.0);
        m.energy_added_kwh += e; m.charge_count += 1;
        match c.kind.as_str() { "home" => m.home_kwh += e, "supercharger" => m.supercharger_kwh += e, _ => m.other_kwh += e }
        if let Some(a) = c.cost { add_money(&mut m.costs, &c.currency.clone().unwrap_or_else(|| def_cur.clone()), a); }
    }
    let r1 = |v: f64| (v * 10.0).round() / 10.0;
    let out: Vec<TrendMonth> = by.into_values().map(|mut m| {
        m.efficiency_wh_km = (m.distance_km > 1.0).then(|| r1(m.energy_used_kwh * 1000.0 / m.distance_km));
        m.distance_km = r1(m.distance_km); m.energy_used_kwh = r1(m.energy_used_kwh); m.energy_added_kwh = r1(m.energy_added_kwh);
        m.home_kwh = r1(m.home_kwh); m.supercharger_kwh = r1(m.supercharger_kwh); m.other_kwh = r1(m.other_kwh);
        round_money(&mut m.costs); m }).collect();
    Ok(Json(serde_json::json!({"months": out, "timezone": tz})).into_response())
}

#[cfg(test)]
mod tests {
    use super::charges_sql;

    #[test]
    fn charges_sql_classifies_tesla_fc_before_name_fallback() {
        let s = charges_sql("NULL", "NULL", "");
        assert!(s.contains("fx.tesla_fc"), "session probe must expose tesla_fc");
        assert!(
            s.contains("fast_charger_brand ~* '^tesla$'")
                && s.contains("fast_charger_type ~* '^tesla'"),
            "must match TeslaMate brand=Tesla / type starting with Tesla"
        );
        assert!(
            s.contains("(supercharger|超充|スーパーチャージャー|tesla)"),
            "name-based match remains as fallback"
        );
        assert!(
            s.contains("fx.fast AND (fx.tesla_fc"),
            "supercharger requires DC (fast) plus tesla_fc or name"
        );
    }
}

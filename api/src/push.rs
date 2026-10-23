// SPDX-License-Identifier: AGPL-3.0-or-later
//! Web Push notifications (api_level 13): trip summary when a TeslaMate drive ends, monthly-report reminder on the 1st.
//! Pure-Rust stack (web-push-native: RFC 8291 aes128gcm + RFC 8292 VAPID, RustCrypto) — no OpenSSL in the image.
//! Only drivelens.push_subscriptions / drivelens.push_state are written; TeslaMate tables are read only (polled).
use super::*;
use base64ct::{Base64UrlUnpadded, Encoding as _};
use std::sync::atomic::Ordering;
use web_push_native::{jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair}, p256::PublicKey, Auth, WebPushBuilder};

const MISSING: &str = "push tables drivelens.push_subscriptions / drivelens.push_state are missing or not writable; run deploy/drivelens-v0.16.0.sql as the TeslaMate DB admin (picked up within a minute, no restart needed)";
const DEFAULT_SUBJECT: &str = "https://github.com/zzflsxygod/drivelens";
/// Poll interval for finished drives / due monthly reminders.
const TICK: std::time::Duration = std::time::Duration::from_secs(60);
/// Drives that ended longer ago than this are marked as seen without a notification (API was down, catch-up).
const STALE_HOURS: i32 = 6;
/// Monthly reminder goes out on the 1st from this local hour on.
const MONTHLY_HOUR: i32 = 9;
/// Consecutive delivery failures (other than 404/410) after which a subscription is dropped.
const MAX_FAILS: i32 = 10;

pub const DDL: [&str; 2] = [
    "CREATE TABLE IF NOT EXISTS drivelens.push_subscriptions (
        id bigserial PRIMARY KEY,
        endpoint text NOT NULL UNIQUE,
        p256dh text NOT NULL,
        auth text NOT NULL,
        trip_summary boolean NOT NULL DEFAULT true,
        monthly_report boolean NOT NULL DEFAULT true,
        car_ids integer[],
        tz text NOT NULL DEFAULT 'UTC',
        locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('zh', 'en', 'ja')),
        user_agent text,
        last_monthly text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_success_at timestamptz,
        last_error text,
        fail_count integer NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS drivelens.push_state (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now())",
];

pub async fn try_migrate(db: &PgPool) {
    let done: bool = sqlx::query_scalar("SELECT to_regclass('drivelens.push_subscriptions') IS NOT NULL AND to_regclass('drivelens.push_state') IS NOT NULL")
        .fetch_one(db).await.unwrap_or(false);
    if done { return; }
    for q in DDL { if let Err(e) = sqlx::query(q).execute(db).await { tracing::warn!("web push disabled: cannot create tables ({e}); {MISSING}"); return; } }
}

pub async fn push_ok(s: &AppState) -> Result<bool, ApiError> {
    if s.push_ok.load(Ordering::Relaxed) { return Ok(true); }
    let ok: bool = sqlx::query_scalar(
        "SELECT to_regclass('drivelens.push_subscriptions') IS NOT NULL AND to_regclass('drivelens.push_state') IS NOT NULL
           AND has_table_privilege('drivelens.push_subscriptions', 'SELECT,INSERT,UPDATE,DELETE')
           AND has_table_privilege('drivelens.push_state', 'SELECT,INSERT,UPDATE,DELETE')
           AND has_sequence_privilege('drivelens.push_subscriptions_id_seq', 'USAGE')").fetch_one(&s.db).await
        .or_else(|e| match &e { sqlx::Error::Database(_) => Ok(false), _ => Err(e) })?;
    if ok { s.push_ok.store(true, Ordering::Relaxed); }
    Ok(ok)
}

// ---------------- VAPID ----------------
pub struct Vapid { kp: ES256KeyPair, pub public_b64: String, subject: String }

fn vapid_from(private_b64: &str, subject: String) -> anyhow::Result<Vapid> {
    let raw = Base64UrlUnpadded::decode_vec(private_b64.trim().trim_end_matches('='))
        .map_err(|_| anyhow::anyhow!("VAPID private key is not base64url"))?;
    let kp = ES256KeyPair::from_bytes(&raw).map_err(|e| anyhow::anyhow!("invalid VAPID private key: {e}"))?;
    let public_b64 = Base64UrlUnpadded::encode_string(&kp.public_key().public_key().to_bytes_uncompressed());
    Ok(Vapid { kp, public_b64, subject })
}

fn subject() -> String {
    let s = std::env::var("DRIVELENS_VAPID_SUBJECT").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_SUBJECT.to_string());
    if s.starts_with("mailto:") || s.starts_with("https://") { s } else {
        tracing::warn!("DRIVELENS_VAPID_SUBJECT must start with mailto: or https:// — using {DEFAULT_SUBJECT}");
        DEFAULT_SUBJECT.to_string()
    }
}

/// Env override (DRIVELENS_VAPID_PRIVATE_KEY, base64url 32-byte P-256 scalar) or the key generated on first start and
/// stored in drivelens.push_state (so a self-hoster needs no setup and subscriptions survive restarts / image updates).
pub async fn load_vapid(s: &AppState) -> Result<Option<Arc<Vapid>>, ApiError> {
    if let Some(v) = s.vapid.read().await.clone() { return Ok(Some(v)); }
    let v = if let Some(k) = std::env::var("DRIVELENS_VAPID_PRIVATE_KEY").ok().filter(|v| !v.trim().is_empty()) {
        vapid_from(&k, subject())?
    } else {
        if !push_ok(s).await? { return Ok(None); }
        let gen = Base64UrlUnpadded::encode_string(&ES256KeyPair::generate().to_bytes());
        // race-safe: whoever inserts first wins, everyone reads the stored key
        sqlx::query("INSERT INTO drivelens.push_state (key, value) VALUES ('vapid_private_key', $1) ON CONFLICT (key) DO NOTHING")
            .bind(&gen).execute(&s.db).await?;
        let k: String = sqlx::query_scalar("SELECT value FROM drivelens.push_state WHERE key = 'vapid_private_key'").fetch_one(&s.db).await?;
        vapid_from(&k, subject())?
    };
    let v = Arc::new(v);
    *s.vapid.write().await = Some(v.clone());
    Ok(Some(v))
}

// ---------------- delivery ----------------
#[derive(Serialize)]
pub struct Message { pub title: String, pub body: String, pub tag: String, pub url: String, pub kind: &'static str }

#[derive(FromRow, Clone)]
struct Sub { id: i64, endpoint: String, p256dh: String, auth: String, tz: String, locale: String, car_ids: Option<Vec<i32>>, fail_count: i32 }

pub enum Outcome { Sent, Gone(u16), Failed(String) }

fn builder(sub: &Sub) -> anyhow::Result<WebPushBuilder> {
    let key = PublicKey::from_sec1_bytes(&Base64UrlUnpadded::decode_vec(sub.p256dh.trim_end_matches('=')).map_err(|_| anyhow::anyhow!("bad p256dh"))?)
        .map_err(|_| anyhow::anyhow!("bad p256dh"))?;
    let auth = Base64UrlUnpadded::decode_vec(sub.auth.trim_end_matches('=')).map_err(|_| anyhow::anyhow!("bad auth"))?;
    anyhow::ensure!(auth.len() == 16, "bad auth");
    Ok(WebPushBuilder::new(sub.endpoint.parse()?, key, Auth::clone_from_slice(&auth)))
}

async fn deliver(s: &AppState, v: &Vapid, sub: &Sub, msg: &Message, ttl_secs: u64) -> Outcome {
    let req = match builder(sub).and_then(|b| {
        let b = b.with_valid_duration(std::time::Duration::from_secs(ttl_secs));
        b.with_vapid(&v.kp, &v.subject).build(serde_json::to_vec(msg)?).map_err(|e| anyhow::anyhow!("{e}"))
    }) { Ok(r) => r, Err(e) => return Outcome::Failed(format!("encrypt: {e}")) };
    if !valid_endpoint(&sub.endpoint) { return Outcome::Failed("endpoint is not a known push service".into()); }
    let (parts, body) = req.into_parts();
    let mut rb = s.http.post(parts.uri.to_string()).body(body).header("Urgency", "normal")
        .timeout(std::time::Duration::from_secs(15));
    for (k, val) in parts.headers.iter() { rb = rb.header(k.as_str(), val.as_bytes()); }
    match rb.send().await {
        Ok(r) if r.status().is_success() => Outcome::Sent,
        Ok(r) if matches!(r.status().as_u16(), 404 | 410) => Outcome::Gone(r.status().as_u16()),
        // status only: the response body is never stored or returned (it is whatever the remote host sent)
        Ok(r) => Outcome::Failed(format!("HTTP {}", r.status().as_u16())),
        Err(e) => { tracing::debug!("push: network error: {e}"); Outcome::Failed(if e.is_timeout() { "timeout".into() } else if e.is_connect() { "connection failed".into() } else { "network error".into() }) }
    }
}

/// Send + bookkeeping (404/410 → subscription deleted; MAX_FAILS consecutive failures → deleted).
async fn send(s: &AppState, v: &Vapid, sub: &Sub, msg: &Message, ttl: u64) -> Outcome {
    let o = deliver(s, v, sub, msg, ttl).await;
    let r = match &o {
        Outcome::Sent => sqlx::query("UPDATE drivelens.push_subscriptions SET last_success_at = now(), fail_count = 0, last_error = NULL WHERE id = $1").bind(sub.id).execute(&s.db).await,
        Outcome::Gone(code) => {
            tracing::info!("push: subscription {} expired ({code}); removed", sub.id);
            sqlx::query("DELETE FROM drivelens.push_subscriptions WHERE id = $1").bind(sub.id).execute(&s.db).await
        }
        Outcome::Failed(e) => {
            tracing::warn!("push: delivery to subscription {} failed: {e}", sub.id);
            if sub.fail_count + 1 >= MAX_FAILS {
                tracing::warn!("push: subscription {} failed {MAX_FAILS} times in a row; removed", sub.id);
                sqlx::query("DELETE FROM drivelens.push_subscriptions WHERE id = $1").bind(sub.id).execute(&s.db).await
            } else {
                sqlx::query("UPDATE drivelens.push_subscriptions SET fail_count = fail_count + 1, last_error = $2 WHERE id = $1").bind(sub.id).bind(e).execute(&s.db).await
            }
        }
    };
    if let Err(e) = r { tracing::warn!("push: bookkeeping failed: {e}"); }
    o
}

// ---------------- texts (zh / en / ja) ----------------
fn lang(l: &str) -> &'static str { match l { "zh" => "zh", "ja" => "ja", _ => "en" } }

pub fn fmt_dur(min: i32, l: &str) -> String {
    let (h, m) = (min / 60, min % 60);
    match (lang(l), h) {
        ("zh", 0) => format!("{m} 分钟"), ("zh", _) => format!("{h} 小时 {m} 分钟"),
        ("ja", 0) => format!("{m}分"), ("ja", _) => format!("{h}時間{m}分"),
        (_, 0) => format!("{m} min"), _ => format!("{h} h {m} min"),
    }
}
fn thousands(v: i64) -> String {
    let s = v.abs().to_string(); let mut o = String::new();
    for (i, c) in s.chars().enumerate() { if i > 0 && (s.len() - i) % 3 == 0 { o.push(','); } o.push(c); }
    if v < 0 { format!("-{o}") } else { o }
}

#[derive(FromRow)]
pub struct TripRow { id: i64, car_id: i64, car_name: Option<String>, start_place: Option<String>, end_place: Option<String>,
    distance_km: Option<f64>, duration_min: Option<i32>, energy_kwh: Option<f64>, efficiency_wh_km: Option<f64>, ended_recently: bool }

pub fn trip_message(t: &TripRow, l: &str, multi_car: bool) -> Message {
    let l = lang(l);
    let dist = t.distance_km.map(|d| format!("{d:.1} km")).unwrap_or_else(|| "—".into());
    let head = match l { "zh" => "行程结束", "ja" => "走行終了", _ => "Trip finished" };
    let car = if multi_car { t.car_name.as_deref().map(|n| format!("{n} · ")).unwrap_or_default() } else { String::new() };
    let mut lines = Vec::new();
    match (t.start_place.as_deref(), t.end_place.as_deref()) {
        (Some(a), Some(b)) if a == b => lines.push(a.to_string()),
        (Some(a), Some(b)) => lines.push(format!("{a} → {b}")),
        (None, Some(b)) => lines.push(format!("→ {b}")),
        (Some(a), None) => lines.push(format!("{a} →")),
        _ => {}
    }
    let mut stats = Vec::new();
    if let Some(m) = t.duration_min { stats.push(fmt_dur(m, l)); }
    if let Some(e) = t.energy_kwh.filter(|e| e.is_finite() && *e > 0.0) { stats.push(format!("{e:.1} kWh")); }
    if let Some(e) = t.efficiency_wh_km.filter(|e| e.is_finite() && *e > 0.0) { stats.push(format!("{e:.0} Wh/km")); }
    if !stats.is_empty() { lines.push(stats.join(" · ")); }
    Message { title: format!("{car}{head} · {dist}"), body: lines.join("\n"), tag: format!("drive-{}", t.id),
        url: format!("/?view=drive:{}&car={}", t.id, t.car_id), kind: "trip" }
}

const EN_MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
pub fn monthly_message(month: &str, l: &str, km: Option<f64>, drives: i64) -> Message {
    let mo: usize = month.get(5..7).and_then(|m| m.parse().ok()).filter(|m| (1..=12).contains(m)).unwrap_or(1);
    let km = km.map(|k| thousands(k.round() as i64));
    let (title, body) = match lang(l) {
        "zh" => (format!("{mo} 月月报已生成"), match &km { Some(k) if drives > 0 => format!("上月行驶 {k} km，共 {drives} 次行程。点按查看报告。"), _ => "点按查看上个月的报告。".into() }),
        "ja" => (format!("{mo}月のレポートができました"), match &km { Some(k) if drives > 0 => format!("先月は {drives} 回、{k} km 走行しました。タップしてレポートを表示。"), _ => "タップして先月のレポートを表示。".into() }),
        _ => (format!("Your {} report is ready", EN_MONTHS[mo - 1]), match &km { Some(k) if drives > 0 => format!("{k} km over {drives} drive{} last month. Tap to open the report.", if drives == 1 { "" } else { "s" }), _ => "Tap to open last month's report.".into() }),
    };
    Message { title, body, tag: format!("report-{month}"), url: format!("/?view=report:{month}"), kind: "report" }
}
fn test_message(l: &str) -> Message {
    let (title, body) = match lang(l) {
        "zh" => ("DriveLens 测试通知", "通知已开启：行程结束时和每月 1 日会在这里提醒你。"),
        "ja" => ("DriveLens テスト通知", "通知がオンになりました。走行終了時と毎月1日にお知らせします。"),
        _ => ("DriveLens test notification", "Notifications are on: you'll hear from DriveLens when a trip ends and on the 1st of each month."),
    };
    Message { title: title.into(), body: body.into(), tag: "test".into(), url: "/?view=settings".into(), kind: "test" }
}

// ---------------- notifier (background task) ----------------
async fn get_state(s: &AppState, key: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM drivelens.push_state WHERE key = $1").bind(key).fetch_optional(&s.db).await
}
async fn set_state(s: &AppState, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO drivelens.push_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()")
        .bind(key).bind(value).execute(&s.db).await.map(|_| ())
}

pub fn spawn(s: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let mut iv = tokio::time::interval(TICK);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            if !push_ok(&s).await.unwrap_or(false) { continue; }   // re-checked every tick until the SQL was run
            let v = match load_vapid(&s).await { Ok(Some(v)) => v, Ok(None) => continue, Err(e) => { tracing::warn!("push: VAPID key: {}", e.0); continue; } };
            if let Err(e) = trips(&s, &v).await { tracing::warn!("push: trip check failed: {e}"); }
            if let Err(e) = monthly(&s, &v).await { tracing::warn!("push: monthly check failed: {e}"); }
        }
    });
}

/// Finished-drive detection. State: `drive_watermark` (every drive id ≤ it is handled) + `drive_sent` (ids above the
/// watermark already handled — drives of several cars can finish out of id order). First run: watermark = newest drive,
/// so nothing is backfilled. A drive that never gets an end_date (TeslaMate crashed) stops holding the watermark after 1 day.
async fn trips(s: &AppState, v: &Vapid) -> anyhow::Result<()> {
    let wm: Option<i64> = get_state(s, "drive_watermark").await?.and_then(|x| x.parse().ok());
    let Some(wm) = wm else {
        let max: i64 = sqlx::query_scalar("SELECT COALESCE(max(id), 0)::int8 FROM drives").fetch_one(&s.db).await?;
        set_state(s, "drive_watermark", &max.to_string()).await?;
        tracing::info!("push: trip notifications start after drive {max}");
        return Ok(());
    };
    let mut sent: Vec<i64> = get_state(s, "drive_sent").await?.unwrap_or_default().split(',').filter_map(|x| x.trim().parse().ok()).collect();
    let rows: Vec<(i64, bool, bool)> = sqlx::query_as(
        "SELECT id::int8, end_date IS NOT NULL, start_date < (now() AT TIME ZONE 'UTC') - interval '1 day' FROM drives WHERE id > $1 ORDER BY id")
        .bind(wm).fetch_all(&s.db).await?;
    if rows.is_empty() { return Ok(()); }
    let fresh: Vec<i64> = rows.iter().filter(|r| r.1 && !sent.contains(&r.0)).map(|r| r.0).collect();
    if !fresh.is_empty() {
        let subs: Vec<Sub> = sqlx::query_as("SELECT id, endpoint, p256dh, auth, tz, locale, car_ids, fail_count FROM drivelens.push_subscriptions WHERE trip_summary")
            .fetch_all(&s.db).await?;
        let multi: bool = sqlx::query_scalar("SELECT count(*) > 1 FROM cars").fetch_one(&s.db).await.unwrap_or(false);
        for id in &fresh {
            if !subs.is_empty() {
                if let Some(t) = trip_row(s, *id).await? {
                    if t.ended_recently && t.distance_km.unwrap_or(0.0) >= 0.1 {
                        for sub in subs.iter().filter(|x| x.car_ids.as_ref().map_or(true, |c| c.is_empty() || c.contains(&(t.car_id as i32)))) {
                            send(s, v, sub, &trip_message(&t, &sub.locale, multi), 24 * 3600).await;
                        }
                    }
                }
            }
            sent.push(*id);
        }
    }
    // advance the watermark over the contiguous handled prefix (finished, or stuck for more than a day)
    let mut new_wm = wm;
    for (id, done, stale) in &rows { if *done || *stale { new_wm = *id; } else { break; } }
    sent.retain(|x| *x > new_wm);
    sent.sort_unstable(); sent.dedup();
    if new_wm != wm { set_state(s, "drive_watermark", &new_wm.to_string()).await?; }
    set_state(s, "drive_sent", &sent.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")).await?;
    Ok(())
}

async fn trip_row(s: &AppState, id: i64) -> Result<Option<TripRow>, sqlx::Error> {
    let alias = journey_alias_ok(s).await;
    let (aj, sa, ea) = if alias {
        ("LEFT JOIN drivelens.address_aliases sal ON sal.address_id = d.start_address_id LEFT JOIN drivelens.address_aliases eal ON eal.address_id = d.end_address_id",
         "sal.name, ", "eal.name, ")
    } else { ("", "", "") };
    sqlx::query_as::<_, TripRow>(&format!(
        r#"SELECT d.id::int8 AS id, d.car_id::int8 AS car_id, c.name AS car_name,
             COALESCE({sa}gs.name, sa.name, NULLIF(CONCAT_WS(' ', sa.road, sa.house_number), ''), sa.city) AS start_place,
             COALESCE({ea}ge.name, ea.name, NULLIF(CONCAT_WS(' ', ea.road, ea.house_number), ''), ea.city) AS end_place,
             d.distance::float8 AS distance_km, d.duration_min::int4 AS duration_min,
             ((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency)::float8 AS energy_kwh,
             CASE WHEN d.distance > 0 THEN ((d.start_rated_range_km - d.end_rated_range_km) * c.efficiency * 1000 / d.distance)::float8 END AS efficiency_wh_km,
             d.end_date > (now() AT TIME ZONE 'UTC') - make_interval(hours => {STALE_HOURS}) AS ended_recently
           FROM drives d JOIN cars c ON c.id = d.car_id
           LEFT JOIN addresses sa ON sa.id = d.start_address_id LEFT JOIN addresses ea ON ea.id = d.end_address_id
           LEFT JOIN geofences gs ON gs.id = d.start_geofence_id LEFT JOIN geofences ge ON ge.id = d.end_geofence_id
           {aj}
           WHERE d.id = $1 AND d.end_date IS NOT NULL"#)).bind(id).fetch_optional(&s.db).await
}
async fn journey_alias_ok(s: &AppState) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT to_regclass('drivelens.address_aliases') IS NOT NULL AND has_table_privilege('drivelens.address_aliases', 'SELECT')")
        .fetch_one(&s.db).await.unwrap_or(false)
}

/// On the 1st (subscriber's tz) from MONTHLY_HOUR: "last month's report is ready", once per month per subscription.
async fn monthly(s: &AppState, v: &Vapid) -> anyhow::Result<()> {
    let due: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, to_char((now() AT TIME ZONE tz) - interval '1 month', 'YYYY-MM') FROM drivelens.push_subscriptions
          WHERE monthly_report AND extract(day from now() AT TIME ZONE tz) = 1 AND extract(hour from now() AT TIME ZONE tz) >= $1
            AND last_monthly IS DISTINCT FROM to_char((now() AT TIME ZONE tz) - interval '1 month', 'YYYY-MM')")
        .bind(MONTHLY_HOUR as f64).fetch_all(&s.db).await?;
    for (id, month) in due {
        let Some(sub) = sqlx::query_as::<_, Sub>("SELECT id, endpoint, p256dh, auth, tz, locale, car_ids, fail_count FROM drivelens.push_subscriptions WHERE id = $1")
            .bind(id).fetch_optional(&s.db).await? else { continue };
        // mark first: a failing push service must not cause a reminder every minute
        sqlx::query("UPDATE drivelens.push_subscriptions SET last_monthly = $2 WHERE id = $1").bind(id).bind(&month).execute(&s.db).await?;
        let (km, n): (Option<f64>, i64) = sqlx::query_as(
            "SELECT sum(distance)::float8, count(*)::int8 FROM drives
              WHERE to_char((start_date AT TIME ZONE 'UTC') AT TIME ZONE $1, 'YYYY-MM') = $2 AND end_date IS NOT NULL
                AND ($3::int4[] IS NULL OR cardinality($3::int4[]) = 0 OR car_id = ANY($3::int4[]))")
            .bind(&sub.tz).bind(&month).bind(&sub.car_ids).fetch_one(&s.db).await?;
        if n == 0 { continue; }   // nothing driven: no "your report is ready" for an empty report
        send(s, v, &sub, &monthly_message(&month, &sub.locale, km, n), 3 * 24 * 3600).await;
    }
    Ok(())
}

// ---------------- HTTP API ----------------
fn err(code: StatusCode, msg: &str) -> Response { (code, Json(serde_json::json!({"error": msg}))).into_response() }

pub async fn key(State(s): State<AppState>) -> Result<Response, ApiError> {
    if !push_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)); }
    let Some(v) = load_vapid(&s).await? else { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)) };
    Ok(Json(serde_json::json!({"public_key": v.public_b64})).into_response())
}

#[derive(Deserialize)]
pub struct Keys { p256dh: String, auth: String }
#[derive(Deserialize)]
pub struct SubscribeBody { endpoint: String, keys: Keys, trip_summary: Option<bool>, monthly_report: Option<bool>,
    tz: Option<String>, locale: Option<String>, car_ids: Option<Vec<i32>>, user_agent: Option<String> }
#[derive(Deserialize)]
pub struct EndpointBody { endpoint: String }

#[derive(Serialize, FromRow)]
pub struct Prefs { #[sqlx(default)] #[serde(serialize_with = "always_true")] subscribed: bool, trip_summary: bool, monthly_report: bool, tz: String, locale: String, car_ids: Option<Vec<i32>>,
    created_at: Option<String>, last_success_at: Option<String>, last_error: Option<String> }
fn always_true<S: serde::Serializer>(_: &bool, s: S) -> Result<S::Ok, S::Error> { s.serialize_bool(true) }
fn prefs_sql() -> String {
    format!("SELECT trip_summary, monthly_report, tz, locale, car_ids, to_char(created_at AT TIME ZONE 'UTC', '{TS}') AS created_at,
        to_char(last_success_at AT TIME ZONE 'UTC', '{TS}') AS last_success_at, last_error FROM drivelens.push_subscriptions WHERE endpoint = $1")
}

/// Push services the browsers actually use (Web Push endpoints): Chrome/Edge/Brave/Opera/Samsung → FCM,
/// Firefox → Mozilla autopush, Safari → Apple, legacy Edge → WNS. Exact host or any subdomain of these.
const PUSH_HOSTS: [&str; 5] = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com", "android.googleapis.com"];

/// Extra allowed push hosts (DRIVELENS_PUSH_HOSTS, comma-separated), e.g. a self-hosted autopush for a Firefox fork.
fn extra_push_hosts() -> Vec<String> {
    std::env::var("DRIVELENS_PUSH_HOSTS").unwrap_or_default().split(',')
        .map(|h| h.trim().trim_start_matches("*.").to_ascii_lowercase()).filter(|h| !h.is_empty()).collect()
}

fn host_allowed(host: &str, extra: &[String]) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    let m = |d: &str| h == d || h.ends_with(&format!(".{d}"));
    PUSH_HOSTS.iter().any(|d| m(d)) || extra.iter().any(|d| m(d))
}

/// https only, default port, no user info, host on the push-service allowlist (SSRF guard: the server must not
/// be usable to make requests to arbitrary / internal URLs).
fn endpoint_ok(e: &str, extra: &[String]) -> bool {
    let Ok(u) = e.parse::<axum::http::Uri>() else { return false };
    e.len() <= 2048 && u.scheme_str() == Some("https") && matches!(u.port_u16(), None | Some(443))
        && u.authority().is_some_and(|a| !a.as_str().contains('@'))
        && u.host().is_some_and(|h| host_allowed(h, extra))
}
fn valid_endpoint(e: &str) -> bool { endpoint_ok(e, &extra_push_hosts()) }

/// Addresses a push request may connect to: public unicast only (no loopback, private, link-local, CGNAT,
/// unique-local, multicast, documentation or unspecified ranges). Applied after DNS resolution.
fn public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            !(a.is_loopback() || a.is_private() || a.is_link_local() || a.is_unspecified() || a.is_broadcast()
              || a.is_multicast() || a.is_documentation() || o[0] == 0 || (o[0] == 100 && (o[1] & 0xc0) == 64)
              || (o[0] == 192 && o[1] == 0 && o[2] == 0) || (o[0] == 198 && (o[1] & 0xfe) == 18) || o[0] >= 240)
        }
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() { return public_ip(IpAddr::V4(v4)); }
            let s = a.segments();
            !(a.is_loopback() || a.is_unspecified() || a.is_multicast() || (s[0] & 0xfe00) == 0xfc00
              || (s[0] & 0xffc0) == 0xfe80 || (s[0] == 0x2001 && s[1] == 0x0db8) || (s[0] == 0x64 && s[1] == 0xff9b))
        }
    }
}

/// DNS resolver for the push client that drops non-public addresses (defends against an allowed name
/// resolving, or being rebound, to an internal address).
struct PublicOnly;
impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((name.as_str(), 0)).await?.filter(|a| public_ip(a.ip())).collect();
            if addrs.is_empty() { return Err(format!("{} resolves to no public address", name.as_str()).into()); }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The HTTP client used only for Web Push deliveries: no redirects, public addresses only, short timeouts.
pub fn push_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).dns_resolver(std::sync::Arc::new(PublicOnly))
        .connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(20)).build()?)
}

/// Create or update (same endpoint) a subscription. Omitted toggles keep their value (new: on).
pub async fn subscribe(State(s): State<AppState>, Json(b): Json<SubscribeBody>) -> Result<Response, ApiError> {
    if !push_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)); }
    if !valid_endpoint(&b.endpoint) { return Ok(err(StatusCode::BAD_REQUEST, "endpoint must be an https URL of a known push service")); }
    let probe = Sub { id: 0, endpoint: b.endpoint.clone(), p256dh: b.keys.p256dh.clone(), auth: b.keys.auth.clone(), tz: String::new(), locale: String::new(), car_ids: None, fail_count: 0 };
    if builder(&probe).is_err() { return Ok(err(StatusCode::BAD_REQUEST, "invalid subscription keys")); }
    let tz = b.tz.as_deref().map(str::trim).filter(|t| !t.is_empty() && t.len() <= 64).unwrap_or("UTC").to_string();
    let tz_ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)").bind(&tz).fetch_one(&s.db).await?;
    let tz = if tz_ok { tz } else { "UTC".to_string() };
    let locale = lang(b.locale.as_deref().unwrap_or("en").get(..2).unwrap_or("en")).to_string();
    let ua = b.user_agent.map(|u| u.chars().take(300).collect::<String>());
    let cars = b.car_ids.filter(|c| !c.is_empty() && c.len() <= 50);
    // last_monthly = last month: subscribing on the 1st does not immediately fire a reminder for a month already over
    sqlx::query(
        "INSERT INTO drivelens.push_subscriptions (endpoint, p256dh, auth, trip_summary, monthly_report, tz, locale, car_ids, user_agent, last_monthly)
         VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, true), $6, $7, $8, $9, to_char((now() AT TIME ZONE $6) - interval '1 month', 'YYYY-MM'))
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           trip_summary = COALESCE($4, push_subscriptions.trip_summary), monthly_report = COALESCE($5, push_subscriptions.monthly_report),
           tz = EXCLUDED.tz, locale = EXCLUDED.locale, car_ids = EXCLUDED.car_ids, user_agent = COALESCE(EXCLUDED.user_agent, push_subscriptions.user_agent),
           fail_count = 0, last_error = NULL, updated_at = now()")
        .bind(&b.endpoint).bind(b.keys.p256dh.trim()).bind(b.keys.auth.trim()).bind(b.trip_summary).bind(b.monthly_report)
        .bind(&tz).bind(&locale).bind(&cars).bind(&ua).execute(&s.db).await?;
    let p: Prefs = sqlx::query_as(&prefs_sql()).bind(&b.endpoint).fetch_one(&s.db).await?;
    Ok(Json(p).into_response())
}

/// Preferences of one subscription (POST: the endpoint is a long URL). `subscribed: false` = this server does not know it
/// (expired, removed, or registered with another server) — not a 404, which the app treats as "server too old".
pub async fn status(State(s): State<AppState>, Json(b): Json<EndpointBody>) -> Result<Response, ApiError> {
    if !push_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)); }
    Ok(match sqlx::query_as::<_, Prefs>(&prefs_sql()).bind(&b.endpoint).fetch_optional(&s.db).await? {
        Some(p) => Json(p).into_response(), None => Json(serde_json::json!({"subscribed": false})).into_response(),
    })
}

pub async fn unsubscribe(State(s): State<AppState>, Json(b): Json<EndpointBody>) -> Result<Response, ApiError> {
    if !push_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)); }
    sqlx::query("DELETE FROM drivelens.push_subscriptions WHERE endpoint = $1").bind(&b.endpoint).execute(&s.db).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn test(State(s): State<AppState>, Json(b): Json<EndpointBody>) -> Result<Response, ApiError> {
    if !push_ok(&s).await? { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)); }
    let Some(v) = load_vapid(&s).await? else { return Ok(err(StatusCode::SERVICE_UNAVAILABLE, MISSING)) };
    let Some(sub) = sqlx::query_as::<_, Sub>("SELECT id, endpoint, p256dh, auth, tz, locale, car_ids, fail_count FROM drivelens.push_subscriptions WHERE endpoint = $1")
        .bind(&b.endpoint).fetch_optional(&s.db).await? else { return Ok(err(StatusCode::NOT_FOUND, "subscription not found")) };
    Ok(match send(&s, &v, &sub, &test_message(&sub.locale), 600).await {
        Outcome::Sent => Json(serde_json::json!({"sent": true})).into_response(),
        Outcome::Gone(c) => err(StatusCode::GONE, &format!("the push service says this subscription has expired ({c}); it was removed")),
        Outcome::Failed(e) => err(StatusCode::BAD_GATEWAY, &format!("push service: {e}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn trip() -> TripRow { TripRow { id: 7, car_id: 1, car_name: Some("Model Y".into()), start_place: Some("Home".into()), end_place: Some("Office".into()),
        distance_km: Some(23.44), duration_min: Some(83), energy_kwh: Some(4.12), efficiency_wh_km: Some(175.6), ended_recently: true } }
    #[test]
    fn trip_texts() {
        let m = trip_message(&trip(), "en", false);
        assert_eq!(m.title, "Trip finished · 23.4 km");
        assert_eq!(m.body, "Home → Office\n1 h 23 min · 4.1 kWh · 176 Wh/km");
        assert_eq!(m.url, "/?view=drive:7&car=1");
        assert_eq!(trip_message(&trip(), "zh", true).title, "Model Y · 行程结束 · 23.4 km");
        assert!(trip_message(&trip(), "ja", false).body.contains("1時間23分"));
        assert_eq!(trip_message(&trip(), "xx", false).title, "Trip finished · 23.4 km");
    }
    #[test]
    fn monthly_texts() {
        let m = monthly_message("2026-09", "en", Some(1234.4), 45);
        assert_eq!(m.title, "Your September report is ready");
        assert_eq!(m.body, "1,234 km over 45 drives last month. Tap to open the report.");
        assert_eq!(m.url, "/?view=report:2026-09");
        assert_eq!(monthly_message("2026-10", "zh", Some(12.0), 1).title, "10 月月报已生成");
        assert_eq!(monthly_message("2026-01", "ja", None, 0).body, "タップして先月のレポートを表示。");
    }
    #[test]
    fn vapid_roundtrip_and_encrypt() {
        let k = Base64UrlUnpadded::encode_string(&ES256KeyPair::generate().to_bytes());
        let v = vapid_from(&k, DEFAULT_SUBJECT.into()).unwrap();
        assert_eq!(Base64UrlUnpadded::decode_vec(&v.public_b64).unwrap().len(), 65);
        // a browser-style subscription (keys from the web-push-native docs)
        let sub = Sub { id: 1, endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
            p256dh: "BLn9b-VR0ca83knDNZ32dCHGyjJp-1riX9ZTN40MqV8K_LpQmLqxC_DoHvqvFXO_nGdAB4W9dogZb_sM-uV4JbY".into(),
            auth: "_ordMnz7uTCmrpBTeUV4Bw".into(), tz: "UTC".into(), locale: "en".into(), car_ids: None, fail_count: 0 };
        let req = builder(&sub).unwrap().with_vapid(&v.kp, &v.subject).build(b"{}".to_vec()).unwrap();
        assert_eq!(req.headers()["content-encoding"], "aes128gcm");
        assert!(req.headers()["authorization"].to_str().unwrap().starts_with("vapid t="));
        assert!(vapid_from("not-a-key", DEFAULT_SUBJECT.into()).is_err());
    }
    #[test]
    fn payload_decrypts_with_the_browser_key() {
        use web_push_native::p256::{elliptic_curve::sec1::ToEncodedPoint, SecretKey};
        let ua = SecretKey::from_slice(&[7u8; 32]).unwrap();
        let auth = [9u8; 16];
        let sub = Sub { id: 1, endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x".into(),
            p256dh: Base64UrlUnpadded::encode_string(ua.public_key().to_encoded_point(false).as_bytes()),
            auth: Base64UrlUnpadded::encode_string(&auth), tz: "UTC".into(), locale: "en".into(), car_ids: None, fail_count: 0 };
        let v = vapid_from(&Base64UrlUnpadded::encode_string(&ES256KeyPair::generate().to_bytes()), DEFAULT_SUBJECT.into()).unwrap();
        let msg = serde_json::to_vec(&monthly_message("2026-09", "ja", Some(10.0), 2)).unwrap();
        let req = builder(&sub).unwrap().with_vapid(&v.kp, &v.subject).build(msg.clone()).unwrap();
        let plain = web_push_native::decrypt(req.into_body(), &ua, &Auth::clone_from_slice(&auth)).unwrap();
        assert_eq!(plain, msg);
    }
    #[test]
    fn endpoints() {
        assert!(valid_endpoint("https://web.push.apple.com/QGx"));
        assert!(!valid_endpoint("http://fcm.googleapis.com/x"));
        assert!(!valid_endpoint("file:///etc/passwd"));
        assert!(valid_endpoint("https://fcm.googleapis.com/fcm/send/abc:def"));
        assert!(valid_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assert!(valid_endpoint("https://wns2-par02p.notify.windows.com/w/?token=x"));
        assert!(!valid_endpoint("https://169.254.169.254/latest/meta-data"));
        assert!(!valid_endpoint("https://127.0.0.1/x"));
        assert!(!valid_endpoint("https://localhost/x"));
        assert!(!valid_endpoint("https://evilpush.apple.com.attacker.example/x"));
        assert!(!valid_endpoint("https://notpush.apple.com/x"), "suffix must match on a dot boundary");
        assert!(!valid_endpoint("https://fcm.googleapis.com:8443/x"));
        assert!(!valid_endpoint("https://user@fcm.googleapis.com/x"));
        assert!(endpoint_ok("https://push.example.org/x", &["push.example.org".into()]));
        assert!(endpoint_ok("https://a.push.example.org/x", &["push.example.org".into()]));
        assert_eq!(fmt_dur(5, "zh"), "5 分钟");
        assert_eq!(thousands(1234567), "1,234,567");
    }
    #[test]
    fn only_public_addresses() {
        for a in ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "64:ff9b::a00:1", "224.0.0.1"] {
            assert!(!public_ip(a.parse().unwrap()), "{a} must be rejected");
        }
        for a in ["142.250.196.106", "34.117.100.1", "2a00:1450:4001:80b::200a", "17.253.144.10"] { assert!(public_ip(a.parse().unwrap()), "{a} must be allowed"); }
    }
    #[tokio::test]
    async fn push_client_refuses_internal_names() {
        let c = push_client().unwrap();
        let e = c.post("https://localhost:9/x").send().await.unwrap_err();
        assert!(e.is_connect() || e.to_string().contains("error sending request"), "{e}");
    }
}

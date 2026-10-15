"""Generate realistic TeslaMate sample data around Tokyo -> sample_data.sql"""
import math, datetime as dt, random
random.seed(1)
out = []
q = lambda s: "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"
out.append("INSERT INTO cars (id,eid,vid,model,efficiency,vin,name,trim_badging,marketing_name,exterior_color,wheel_type) VALUES "
           "(1,1001,2001,'3',0.1345,'LRW3E7FA0PC000001','Sample Car',NULL,'Model 3 RWD','PearlWhite','Photon18');")
addrs = [  # name, road, city, lat, lng
 ("自宅", "世田谷通り", "世田谷区", 35.6431, 139.6530),
 ("Tesla Supercharger 東京有明", "有明", "江東区", 35.6340, 139.7930),
 ("渋谷スクランブルスクエア", "渋谷", "渋谷区", 35.6585, 139.7022),
 ("横浜みなとみらい", "みなとみらい", "横浜市", 35.4560, 139.6320),
 ("箱根湯本駅", "湯本", "箱根町", 35.2326, 139.1069),
]
for i,(n,r,c,la,lo) in enumerate(addrs,1):
    out.append(f"INSERT INTO addresses (id,display_name,latitude,longitude,name,road,city,state,country) VALUES ({i},{q(n+', '+c)},{la},{lo},{q(n)},{q(r)},{q(c)},'東京都','日本');")
out.append("INSERT INTO geofences (id,name,latitude,longitude,radius,cost_per_unit) VALUES (1,'🏠 自宅',35.6431,139.6530,50,31.0);")
pid = 0; did = 0; cid = 0; chid = 0
odo = 12345.0; batt = 80.0
pos_rows = []
def pos(t, la, lo, speed, b, drive_id):
    global pid
    pid += 1
    pos_rows.append(f"({pid},'{t:%Y-%m-%d %H:%M:%S}',{la:.6f},{lo:.6f},{speed},{random.randint(5,40) if speed else 0},{odo:.2f},{b*4.9:.2f},{int(b)},{18+random.random()*4:.1f},{random.randint(5,60)},1,{drive_id or 'NULL'},{b*4.9:.2f},{int(b)})")
    return pid
def flush():
    if pos_rows:
        out.append("INSERT INTO positions (id,date,latitude,longitude,speed,power,odometer,ideal_battery_range_km,battery_level,outside_temp,elevation,car_id,drive_id,rated_battery_range_km,usable_battery_level) VALUES\n" + ",\n".join(pos_rows) + ";")
        pos_rows.clear()
def drive(t0, a, b, geo=(None,None)):
    global did, odo, batt
    did += 1
    (_,_,_,la1,lo1),(_,_,_,la2,lo2) = addrs[a-1], addrs[b-1]
    dist = math.hypot((la2-la1)*111, (lo2-lo1)*91) * 1.3
    n = max(30, int(dist*2)); dur = int(dist / 38 * 60) + 5
    out.append(f"INSERT INTO drives (id,start_date,car_id) VALUES ({did},'{t0:%Y-%m-%d %H:%M:%S}',1);")
    sb = batt; start_odo = odo; first = last = None; vmax = 0
    for k in range(n+1):
        f = k/n
        bend = math.sin(f*math.pi)*0.08*(1 if did%2 else -1)
        la = la1 + (la2-la1)*f + bend*(lo2-lo1)*0.3 + random.uniform(-0.0004,0.0004)
        lo = lo1 + (lo2-lo1)*f - bend*(la2-la1)*0.3 + random.uniform(-0.0004,0.0004)
        sp = 0 if k in (0,n) else int(30+50*math.sin(f*math.pi)+random.randint(-8,8)); vmax = max(vmax, sp)
        odo = start_odo + dist*f; batt = sb - dist*f*0.152*1000/75/10*1.0
        p = pos(t0 + dt.timedelta(minutes=dur*f), la, lo, sp, batt, did)
        first = first or p; last = p
    t1 = t0 + dt.timedelta(minutes=dur)
    out.append(f"""UPDATE drives SET end_date='{t1:%Y-%m-%d %H:%M:%S}', distance={dist:.2f}, duration_min={dur}, start_km={start_odo:.2f}, end_km={odo:.2f},
  speed_max={vmax}, power_max=120, power_min=-45, outside_temp_avg=19.5, inside_temp_avg=22.0,
  start_ideal_range_km={sb*4.9:.2f}, end_ideal_range_km={batt*4.9:.2f}, start_rated_range_km={sb*4.9:.2f}, end_rated_range_km={batt*4.9:.2f},
  start_address_id={a}, end_address_id={b}, start_position_id={first}, end_position_id={last},
  start_geofence_id={geo[0] or 'NULL'}, end_geofence_id={geo[1] or 'NULL'}, ascent=40, descent=35 WHERE id={did};""")
    return t1
def charge(t0, a, target, fast, geo=None, price=None):
    global cid, chid, batt
    cid += 1
    la, lo = addrs[a-1][3], addrs[a-1][4]
    p = pos(t0, la, lo, 0, batt, None); flush()
    sb = batt; power = 150 if fast else 7
    kwh = (target - sb) / 100 * 75
    dur = int(kwh / (power*0.75 if fast else power) * 60) + 3
    out.append(f"INSERT INTO charging_processes (id,start_date,car_id,position_id,address_id,geofence_id) VALUES ({cid},'{t0:%Y-%m-%d %H:%M:%S}',1,{p},{a},{geo or 'NULL'});")
    steps = 12; rows = []
    for k in range(steps+1):
        f = k/steps; chid += 1
        b = sb + (target-sb)*f
        pw = 0 if k==steps else (int(power*(1-0.6*f)) if fast else power)
        rows.append(f"({chid},'{t0+dt.timedelta(minutes=dur*f):%Y-%m-%d %H:%M:%S}',{int(b)},{kwh*f:.2f},{int(pw*1000/(400 if fast else 200)) if pw else 0},{1 if not fast else 'NULL'},{32 if not fast else 'NULL'},{pw},{400 if fast else 200},{b*4.9:.2f},{b*4.9:.2f},{cid},{'true' if fast else 'false'},{q('Tesla') if fast else 'NULL'},{q('IEC') if not fast else 'NULL'},{int(b)})")
    out.append("INSERT INTO charges (id,date,battery_level,charge_energy_added,charger_actual_current,charger_phases,charger_pilot_current,charger_power,charger_voltage,ideal_battery_range_km,rated_battery_range_km,charging_process_id,fast_charger_present,fast_charger_brand,conn_charge_cable,usable_battery_level) VALUES\n" + ",\n".join(rows) + ";")
    used = kwh * (1.05 if fast else 1.12)
    cost = round(used * (price or 0), 2) if price else None
    t1 = t0 + dt.timedelta(minutes=dur)
    out.append(f"""UPDATE charging_processes SET end_date='{t1:%Y-%m-%d %H:%M:%S}', charge_energy_added={kwh:.2f}, charge_energy_used={used:.2f},
  start_battery_level={int(sb)}, end_battery_level={int(target)}, duration_min={dur}, outside_temp_avg=18.5, cost={cost if cost is not None else 'NULL'},
  start_ideal_range_km={sb*4.9:.2f}, end_ideal_range_km={target*4.9:.2f}, start_rated_range_km={sb*4.9:.2f}, end_rated_range_km={target*4.9:.2f} WHERE id={cid};""")
    batt = target
    return t1
t = dt.datetime(2026,10,10,0,30)  # UTC (09:30 JST)
t = drive(t, 1, 3, (1,None)); flush()
t = drive(t + dt.timedelta(hours=3), 3, 1, (None,1)); flush()
t = charge(t + dt.timedelta(minutes=10), 1, 90, False, geo=1, price=31)
t = drive(dt.datetime(2026,10,11,23,0), 1, 4, (1,None)); flush()
t = drive(t + dt.timedelta(hours=1), 4, 5); flush()
t = drive(t + dt.timedelta(hours=5), 5, 2); flush()
t = charge(t + dt.timedelta(minutes=2), 2, 80, True, price=55)
t = drive(t + dt.timedelta(minutes=5), 2, 1, (None,1)); flush()
t = charge(t + dt.timedelta(minutes=30), 1, 90, False, geo=1, price=31)
out.append("""INSERT INTO states (state,start_date,end_date,car_id) VALUES
 ('online','2026-10-12 10:00:00','2026-10-12 13:30:00',1),
 ('asleep','2026-10-12 13:30:00','2026-10-14 22:10:00',1),
 ('online','2026-10-14 22:10:00','2026-10-14 22:40:00',1),
 ('asleep','2026-10-14 22:40:00',NULL,1);""")
out.append("""INSERT INTO updates (start_date,end_date,version,car_id) VALUES
 ('2026-08-20 15:00:00','2026-08-20 15:40:00','2025.32.3 3ad1e4b6',1),
 ('2026-10-01 14:00:00','2026-10-01 14:35:00','2026.32.5 9f1c2a7e',1);""")
pid += 1
out.append(f"INSERT INTO positions (id,date,latitude,longitude,speed,power,odometer,ideal_battery_range_km,battery_level,outside_temp,inside_temp,elevation,car_id,rated_battery_range_km,est_battery_range_km,usable_battery_level) VALUES ({pid},'2026-10-14 22:35:00',35.643120,139.653050,NULL,0,{odo:.2f},{89*4.9:.2f},89,16.5,21.0,40,1,{89*4.9:.2f},{89*4.4:.2f},89);")
for s in ["states","updates"]:
    out.append(f"SELECT setval(pg_get_serial_sequence('{s}','id'), (SELECT max(id) FROM {s}));")
for s in ["cars","addresses","geofences","drives","positions","charging_processes","charges"]:
    out.append(f"SELECT setval(pg_get_serial_sequence('{s}','id'), (SELECT max(id) FROM {s}));")
open("sample_data.sql","w").write("\n".join(out)+"\n")

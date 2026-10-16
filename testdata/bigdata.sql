-- Synthetic large history for performance testing (run AFTER schema.sql + sample_data.sql).
-- ~3M positions over ~3 years before the sample data, 6,000 drives, 1,500 charging sessions.
BEGIN;
INSERT INTO drives (start_date, end_date, car_id, distance, duration_min, start_rated_range_km, end_rated_range_km,
                    start_address_id, end_address_id, speed_max)
SELECT ts, ts + interval '30 min', 1, 5 + random() * 40, 30, 400, 400 - (5 + random() * 40) * 1.1, 1 + (g % 5), 1 + ((g + 1) % 5), 90
FROM generate_series(1, 6000) g, LATERAL (SELECT timestamp '2023-09-01' + g * interval '4 hours 20 min' AS ts) t;

-- positions: one every 30 s; first ~1.5M linked to drives; every 10th row is a "full" record with range values
INSERT INTO positions (date, latitude, longitude, speed, odometer, battery_level, car_id, drive_id,
                       ideal_battery_range_km, rated_battery_range_km, est_battery_range_km, usable_battery_level, outside_temp, inside_temp)
SELECT timestamp '2023-09-01' + g * interval '30 s', 35.6 + random() * 0.1, 139.6 + random() * 0.2, (random() * 80)::int,
       10000 + g * 0.001, 50 + (g % 40), 1,
       CASE WHEN g <= 1500000 THEN (SELECT min(id) FROM drives) + (g / 250) END,
       CASE WHEN g % 10 = 0 THEN 300 END, CASE WHEN g % 10 = 0 THEN 300 END, CASE WHEN g % 10 = 0 THEN 280 END,
       CASE WHEN g % 10 = 0 THEN 50 + (g % 40) END, 15, 20
FROM generate_series(1, 3000000) g;

INSERT INTO charging_processes (start_date, end_date, car_id, position_id, address_id, charge_energy_added, cost,
                                start_battery_level, end_battery_level, duration_min)
SELECT timestamp '2023-09-01' + g * interval '17 hours', timestamp '2023-09-01' + g * interval '17 hours' + interval '1 hour',
       1, (SELECT min(id) FROM positions), 1 + (g % 5), 20 + random() * 30, 500 + random() * 800, 30, 80, 60
FROM generate_series(1, 1500) g;
COMMIT;
ANALYZE positions, drives, charging_processes, charges;

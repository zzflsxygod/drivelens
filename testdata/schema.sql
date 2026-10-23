-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Subset of TeslaMate's schema (column names/types follow TeslaMate's Ecto migrations).
CREATE TYPE billing_type AS ENUM ('per_kwh', 'per_minute');
CREATE TABLE cars (id smallserial PRIMARY KEY, eid bigint, vid bigint, model varchar(255), efficiency double precision,
  inserted_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), vin text, name text,
  trim_badging text, settings_id bigint, exterior_color text, spoiler_type text, wheel_type text,
  display_priority smallint NOT NULL DEFAULT 1, marketing_name varchar(255));
CREATE TABLE addresses (id serial PRIMARY KEY, display_name varchar(512), latitude numeric(8,6), longitude numeric(9,6),
  name varchar(255), house_number varchar(255), road varchar(255), neighbourhood varchar(255), city varchar(255),
  county varchar(255), postcode varchar(255), state varchar(255), state_district varchar(255), country varchar(255),
  raw jsonb, inserted_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
  osm_id bigint, osm_type text);
CREATE TABLE geofences (id serial PRIMARY KEY, name varchar(255) NOT NULL, latitude numeric(8,6) NOT NULL,
  longitude numeric(9,6) NOT NULL, radius smallint NOT NULL DEFAULT 25, inserted_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(), cost_per_unit numeric(6,4), session_fee numeric(6,2),
  billing_type billing_type NOT NULL DEFAULT 'per_kwh');
CREATE TABLE drives (id serial PRIMARY KEY, start_date timestamp NOT NULL, end_date timestamp,
  outside_temp_avg numeric(4,1), speed_max smallint, power_max smallint, power_min smallint,
  start_ideal_range_km numeric(6,2), end_ideal_range_km numeric(6,2), start_km double precision, end_km double precision,
  distance double precision, duration_min smallint, car_id smallint NOT NULL REFERENCES cars(id),
  inside_temp_avg numeric(4,1), start_address_id int REFERENCES addresses(id), end_address_id int REFERENCES addresses(id),
  start_rated_range_km numeric(6,2), end_rated_range_km numeric(6,2), start_position_id int, end_position_id int,
  start_geofence_id int REFERENCES geofences(id), end_geofence_id int REFERENCES geofences(id),
  ascent smallint, descent smallint);
CREATE TABLE positions (id serial PRIMARY KEY, date timestamp NOT NULL, latitude numeric(8,6) NOT NULL,
  longitude numeric(9,6) NOT NULL, speed smallint, power smallint, odometer double precision,
  ideal_battery_range_km numeric(6,2), battery_level smallint, outside_temp numeric(4,1), elevation smallint,
  fan_status int, driver_temp_setting numeric(4,1), passenger_temp_setting numeric(4,1), is_climate_on boolean,
  is_rear_defroster_on boolean, is_front_defroster_on boolean, car_id smallint NOT NULL REFERENCES cars(id),
  drive_id int REFERENCES drives(id), inside_temp numeric(4,1), battery_heater_on boolean, battery_heater boolean,
  battery_heater_no_power boolean, est_battery_range_km numeric(6,2), rated_battery_range_km numeric(6,2),
  usable_battery_level smallint, tpms_pressure_fl numeric(4,1), tpms_pressure_fr numeric(4,1),
  tpms_pressure_rl numeric(4,1), tpms_pressure_rr numeric(4,1));
CREATE TABLE charging_processes (id serial PRIMARY KEY, start_date timestamp NOT NULL, end_date timestamp,
  charge_energy_added numeric(8,2), start_ideal_range_km numeric(6,2), end_ideal_range_km numeric(6,2),
  start_battery_level smallint, end_battery_level smallint, duration_min smallint, outside_temp_avg numeric(4,1),
  car_id smallint NOT NULL REFERENCES cars(id), position_id int NOT NULL REFERENCES positions(id),
  address_id int REFERENCES addresses(id), start_rated_range_km numeric(6,2), end_rated_range_km numeric(6,2),
  geofence_id int REFERENCES geofences(id), charge_energy_used numeric(8,2), cost numeric(6,2));
CREATE TABLE charges (id serial PRIMARY KEY, date timestamp NOT NULL, battery_heater_on boolean, battery_level smallint,
  charge_energy_added numeric(8,2) NOT NULL, charger_actual_current smallint, charger_phases smallint,
  charger_pilot_current smallint, charger_power smallint NOT NULL, charger_voltage smallint,
  ideal_battery_range_km numeric(6,2) NOT NULL, outside_temp numeric(4,1),
  charging_process_id int NOT NULL REFERENCES charging_processes(id), battery_heater boolean,
  conn_charge_cable varchar(255), fast_charger_brand varchar(255), fast_charger_present boolean,
  fast_charger_type varchar(255), rated_battery_range_km numeric(6,2), usable_battery_level smallint,
  not_enough_power_to_heat boolean, battery_heater_no_power boolean);
CREATE TYPE states_status AS ENUM ('online', 'offline', 'asleep');
CREATE TABLE states (id serial PRIMARY KEY, state states_status NOT NULL, start_date timestamp NOT NULL,
  end_date timestamp, car_id smallint NOT NULL REFERENCES cars(id));
CREATE TABLE updates (id serial PRIMARY KEY, start_date timestamp NOT NULL, end_date timestamp,
  version varchar(255), car_id smallint NOT NULL REFERENCES cars(id));
-- Indexes as created by TeslaMate's migrations (as of 2026), so EXPLAIN locally matches production
CREATE INDEX positions_car_id_index ON positions (car_id);
CREATE INDEX positions_car_id_date__ideal_battery_range_km_IS_NOT_NULL_index ON positions (car_id, date, (ideal_battery_range_km IS NOT NULL)) WHERE ideal_battery_range_km IS NOT NULL;
CREATE INDEX positions_date_index ON positions USING brin (date timestamp_minmax_multi_ops) WITH (autosummarize = true, pages_per_range = 64);
CREATE INDEX positions_drive_id_date_index ON positions USING brin (drive_id, date timestamp_minmax_multi_ops) WITH (autosummarize = true, pages_per_range = 64);
CREATE INDEX trips_car_id_index ON drives (car_id);
CREATE INDEX drives_start_position_id_index ON drives (start_position_id);
CREATE INDEX drives_end_position_id_index ON drives (end_position_id);
CREATE INDEX charging_processes_car_id_index ON charging_processes (car_id);
CREATE INDEX charges_charging_process_id_index ON charges (charging_process_id);
CREATE INDEX states_car_id_index ON states (car_id);
CREATE UNIQUE INDEX states_car_id__end_date_IS_NULL_index ON states (car_id, (end_date IS NULL)) WHERE end_date IS NULL;
CREATE INDEX updates_car_id_index ON updates (car_id);

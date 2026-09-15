-- Prerequisite, run once against the geo_locations database:
--   CREATE EXTENSION IF NOT EXISTS postgis;
--
-- The osm_roads table itself is created by osm2pgsql from import_roads.lua,
-- not here. Import steps (run once on the server, after the pbf has been
-- copied up as backend/map/sri-lanka-260910.osm.pbf):
--   osmium tags-filter backend/map/sri-lanka-260910.osm.pbf w/highway -o /tmp/sri-lanka-roads.osm.pbf
--   osm2pgsql -d geo_locations -U $DB_USER -O flex -S backend/sql/import_roads.lua /tmp/sri-lanka-roads.osm.pbf
--
-- This table holds one row per user-submitted direction report for a
-- matched OSM way (append-only log, not a single "current value" per road),
-- so the same road can accumulate multiple independent reports and the
-- server can resolve conflicts (majority vote) rather than trusting the
-- single most recent submitter.
CREATE TABLE IF NOT EXISTS road_direction_reports (
    id SERIAL PRIMARY KEY,
    osm_way_id BIGINT NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('one_way', 'two_way')),
    distance_m DOUBLE PRECISION,
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_road_reports_way ON road_direction_reports (osm_way_id);

-- GiST index on osm_roads.geom is what makes the <-> nearest-neighbor
-- lookup in POST /api/road-trace fast instead of a full table scan.
CREATE INDEX IF NOT EXISTS idx_osm_roads_geom ON osm_roads USING GIST (geom);

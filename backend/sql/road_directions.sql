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
    -- Only set when direction = 'one_way'. Which way the reporter actually
    -- drove, relative to the matched OSM way's own digitized geometry
    -- direction (osm_roads.geom's point order): 'forward' means the trace
    -- ran the same way as the geometry (start -> end), 'backward' means
    -- against it. This is what lets POST /api/road-trace turn a one-way
    -- report into an actual direction-blocking cost on osm_roads_edges
    -- instead of just a label nobody acts on - see the migration note in
    -- backend/sql/road_direction_relative.sql if this table already exists.
    relative_direction VARCHAR(10) CHECK (relative_direction IN ('forward', 'backward')),
    distance_m DOUBLE PRECISION,
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_road_reports_way ON road_direction_reports (osm_way_id);

-- GiST index on osm_roads.geom is what makes the <-> nearest-neighbor
-- lookup in POST /api/road-trace fast instead of a full table scan.
CREATE INDEX IF NOT EXISTS idx_osm_roads_geom ON osm_roads USING GIST (geom);

-- Migration for an EXISTING database that already has road_direction_reports
-- (see backend/sql/road_directions.sql). Run this once, then re-deploy
-- server.js.
--
-- Adds the piece that was missing for one-way reports to actually affect
-- routing: which way along the matched road's own digitized geometry the
-- reporter was travelling. Without this, "one_way" only ever meant "someone
-- says this road is one-way", never *which* direction is the allowed one,
-- so GET /api/directions had nothing usable to act on and kept routing
-- purely off OSM's own oneway tag (see server.js's POST /api/road-trace
-- and the comment above the UPDATE osm_roads_edges call there).
--
-- NULL for every row inserted before this migration (direction unknown) and
-- for every 'two_way' row (not applicable). New one-way reports fill it in
-- going forward; old one-way reports keep voting on the one_way/two_way
-- tally but don't count toward *which* direction until re-reported.
ALTER TABLE road_direction_reports
    ADD COLUMN IF NOT EXISTS relative_direction VARCHAR(10)
        CHECK (relative_direction IN ('forward', 'backward'));

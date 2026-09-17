-- Prerequisite, run once against the geo_locations database (osm_roads
-- must already exist, see road_directions.sql):
--   sudo apt-get install postgresql-<version>-pgrouting postgresql-<version>-pgrouting-scripts
--   CREATE EXTENSION IF NOT EXISTS pgrouting;
--
-- Builds the graph GET /api/directions routes over: per-edge length/cost
-- columns, then a vertex table and source/target columns on osm_roads.
--
-- pgRouting 4.0 removed pgr_createTopology, so the vertex graph is built by
-- hand here: one vertex per distinct road endpoint, matched back onto
-- osm_roads by exact geometry equality. This works because osm2pgsql gives
-- shared OSM nodes bit-identical coordinates across the ways that meet
-- there, so ST_StartPoint/ST_EndPoint of two touching roads compare equal
-- without needing a snapping tolerance.
--
-- Re-run after re-importing osm_roads to rebuild the graph from scratch.

ALTER TABLE osm_roads ADD COLUMN IF NOT EXISTS source BIGINT;
ALTER TABLE osm_roads ADD COLUMN IF NOT EXISTS target BIGINT;
ALTER TABLE osm_roads ADD COLUMN IF NOT EXISTS length_m DOUBLE PRECISION;
ALTER TABLE osm_roads ADD COLUMN IF NOT EXISTS cost DOUBLE PRECISION;
ALTER TABLE osm_roads ADD COLUMN IF NOT EXISTS reverse_cost DOUBLE PRECISION;

UPDATE osm_roads SET length_m = ST_Length(geom) WHERE length_m IS NULL;

-- oneway='-1' means the way is tagged against its digitised direction
-- (forward blocked), 'yes'/'true'/'1' means reverse is blocked, anything
-- else is two-way. 1e9 acts as "effectively unroutable" rather than a hard
-- NULL so pgr_dijkstra can still ignore it without special-casing NULLs.
UPDATE osm_roads
SET cost = CASE WHEN oneway = '-1' THEN 1e9 ELSE length_m END,
    reverse_cost = CASE WHEN oneway IN ('yes', 'true', '1') THEN 1e9 ELSE length_m END;

DROP TABLE IF EXISTS osm_roads_vertices_pgr;

CREATE TABLE osm_roads_vertices_pgr AS
SELECT row_number() OVER () AS id, geom
FROM (
    SELECT DISTINCT ST_StartPoint(geom) AS geom FROM osm_roads
    UNION
    SELECT DISTINCT ST_EndPoint(geom) AS geom FROM osm_roads
) pts;

CREATE UNIQUE INDEX ON osm_roads_vertices_pgr (id);
CREATE INDEX ON osm_roads_vertices_pgr USING GIST (geom);

UPDATE osm_roads r SET source = v.id FROM osm_roads_vertices_pgr v WHERE v.geom = ST_StartPoint(r.geom);
UPDATE osm_roads r SET target = v.id FROM osm_roads_vertices_pgr v WHERE v.geom = ST_EndPoint(r.geom);

CREATE INDEX IF NOT EXISTS idx_osm_roads_source ON osm_roads (source);
CREATE INDEX IF NOT EXISTS idx_osm_roads_target ON osm_roads (target);

-- Prerequisite, run once against the geo_locations database (osm_roads
-- must already exist, see road_directions.sql):
--   sudo apt-get install postgresql-<version>-pgrouting postgresql-<version>-pgrouting-scripts
--   CREATE EXTENSION IF NOT EXISTS pgrouting;
--
-- Builds the graph GET /api/directions routes over, in its own
-- osm_roads_edges / osm_roads_vertices_pgr tables so the one-way/two-way
-- tagging map (which reads osm_roads directly) is untouched.
--
-- pgRouting 4.0 removed pgr_createTopology, and osm2pgrouting (the
-- purpose-built importer) segfaults on this distro, so the graph is built
-- by hand: a naive "one vertex per road endpoint" pass leaves the network
-- almost entirely disconnected (avg. vertex degree ~1.17 in testing),
-- because in OSM a road usually just passes *through* a junction without
-- being split there - the shared node sits in the middle of one road's
-- geometry, not at either road's endpoint. So instead:
--   1. Dump every point of every road (road_points).
--   2. A point is a real junction if it's shared by 2+ distinct roads
--      anywhere along their length, or if it's one of a road's own two
--      endpoints (split_candidates -> osm_roads_vertices_pgr).
--   3. Each road is cut into sub-edges between consecutive junction
--      points found on it (osm_roads_edges), via ST_LineSubstring on the
--      fractional position (ST_LineLocatePoint) of each junction point.
-- This brought the network to one giant component covering ~98.5% of all
-- vertices in testing (the rest are genuinely disconnected fragments -
-- ferry-only links, islands, private tracks - which is expected).
--
-- Re-run after re-importing osm_roads to rebuild the graph from scratch.
-- The road_points/split_candidates/way_split_points intermediates are
-- dropped at the end; only osm_roads_edges and osm_roads_vertices_pgr
-- persist. work_mem is raised and parallel workers disabled for this
-- session because the road_points <-> vertices join spills a lot of temp
-- data - the default 4MB work_mem was enough to exhaust this server's
-- disk via a degenerate hash-join batch explosion.

SET work_mem = '256MB';
SET max_parallel_workers_per_gather = 0;

DROP TABLE IF EXISTS road_points;
CREATE TABLE road_points AS
SELECT way_id, (dp).path[1] AS idx, (dp).geom AS geom
FROM (SELECT way_id, ST_DumpPoints(geom) AS dp FROM osm_roads) t;

CREATE INDEX idx_road_points_way ON road_points (way_id, idx);
CREATE INDEX idx_road_points_geom ON road_points USING GIST (geom);

DROP TABLE IF EXISTS split_candidates;
CREATE TABLE split_candidates AS
WITH numbered AS (
    SELECT way_id, idx, geom,
           idx = 1 AS is_start,
           idx = max(idx) OVER (PARTITION BY way_id) AS is_end
    FROM road_points
)
SELECT DISTINCT geom FROM (
    SELECT geom FROM numbered WHERE is_start OR is_end
    UNION ALL
    SELECT geom FROM road_points GROUP BY geom HAVING count(DISTINCT way_id) >= 2
) s;

DROP TABLE IF EXISTS osm_roads_vertices_pgr;
CREATE TABLE osm_roads_vertices_pgr AS
SELECT row_number() OVER () AS id, geom FROM split_candidates;

CREATE UNIQUE INDEX ON osm_roads_vertices_pgr (id);
CREATE INDEX ON osm_roads_vertices_pgr USING GIST (geom);

ANALYZE road_points;
ANALYZE osm_roads_vertices_pgr;
ANALYZE osm_roads;

DROP TABLE IF EXISTS way_split_points;
CREATE TABLE way_split_points AS
SELECT rp.way_id, rp.idx,
       ST_LineLocatePoint(r.geom, rp.geom) AS frac,
       v.id AS vertex_id
FROM road_points rp
JOIN osm_roads r ON r.way_id = rp.way_id
JOIN osm_roads_vertices_pgr v ON v.geom = rp.geom;

CREATE INDEX ON way_split_points (way_id, idx);

ANALYZE way_split_points;

DROP TABLE IF EXISTS osm_roads_edges;
CREATE TABLE osm_roads_edges AS
SELECT row_number() OVER () AS edge_id,
       s.way_id AS osm_way_id,
       s.vertex_id AS source,
       s.next_vertex_id AS target,
       ST_LineSubstring(r.geom, s.frac, s.next_frac) AS geom,
       r.oneway
FROM (
    SELECT way_id, idx, frac, vertex_id,
           LEAD(frac) OVER (PARTITION BY way_id ORDER BY idx) AS next_frac,
           LEAD(vertex_id) OVER (PARTITION BY way_id ORDER BY idx) AS next_vertex_id
    FROM way_split_points
) s
JOIN osm_roads r ON r.way_id = s.way_id
WHERE s.next_frac IS NOT NULL AND s.next_frac > s.frac;

CREATE UNIQUE INDEX ON osm_roads_edges (edge_id);
CREATE INDEX ON osm_roads_edges (source);
CREATE INDEX ON osm_roads_edges (target);

ALTER TABLE osm_roads_edges ADD COLUMN length_m DOUBLE PRECISION;
ALTER TABLE osm_roads_edges ADD COLUMN cost DOUBLE PRECISION;
ALTER TABLE osm_roads_edges ADD COLUMN reverse_cost DOUBLE PRECISION;

UPDATE osm_roads_edges SET length_m = ST_Length(geom);

-- oneway='-1' means the way is tagged against its digitised direction
-- (forward blocked), 'yes'/'true'/'1' means reverse is blocked, anything
-- else is two-way. 1e9 acts as "effectively unroutable" rather than a hard
-- NULL so pgr_dijkstra can still ignore it without special-casing NULLs.
UPDATE osm_roads_edges
SET cost = CASE WHEN oneway = '-1' THEN 1e9 ELSE length_m END,
    reverse_cost = CASE WHEN oneway IN ('yes', 'true', '1') THEN 1e9 ELSE length_m END;

DROP TABLE IF EXISTS road_points;
DROP TABLE IF EXISTS split_candidates;
DROP TABLE IF EXISTS way_split_points;

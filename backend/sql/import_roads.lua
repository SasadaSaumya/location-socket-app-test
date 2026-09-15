-- osm2pgsql flex-output style. Run once (re-run to refresh) on the server:
--   osm2pgsql -d geo_locations -U $DB_USER -O flex -S import_roads.lua sri-lanka-roads.osm.pbf
--
-- Only imports ways tagged with `highway`, the input pbf should already be
-- pre-filtered to roads only (see backend/sql/road_directions.sql comment
-- header for the osmium tags-filter command), keeping both the import and
-- the resulting table small on a low-disk server.
local roads = osm2pgsql.define_way_table('osm_roads', {
    { column = 'name', type = 'text' },
    { column = 'highway', type = 'text' },
    { column = 'oneway', type = 'text' },
    { column = 'geom', type = 'linestring', not_null = true },
})

function osm2pgsql.process_way(object)
    if not object.tags.highway then
        return
    end

    roads:insert({
        name = object.tags.name,
        highway = object.tags.highway,
        oneway = object.tags.oneway,
        geom = object:as_linestring(),
    })
end

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ENV_PATH = path.join(__dirname, '.env');

// Writes (or updates) the GOOGLE_API_KEY line in the .env file so the key
// set from the frontend survives a server restart, without touching any
// other variables already in the file.
function persistGoogleApiKey(key) {
    let contents = '';
    try {
        contents = fs.readFileSync(ENV_PATH, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const line = `GOOGLE_API_KEY=${key}`;
    const lines = contents.split(/\r?\n/);
    let found = false;

    const updated = lines.map((l) => {
        if (/^\s*GOOGLE_API_KEY\s*=/.test(l)) {
            found = true;
            return line;
        }
        return l;
    });

    if (!found) {
        if (updated.length > 0 && updated[updated.length - 1] === '') updated.pop();
        updated.push(line);
    }

    fs.writeFileSync(ENV_PATH, updated.join('\n') + '\n');
}

// Logs every single HTTP request that reaches this Express app, before
// anything else runs, static files, catch-alls, or API routes included.
// This is the important part for diagnosing routing issues, if a request
// for /api/config never shows up in this log, it means the request never
// reached this process at all (wrong host, wrong port, a reverse proxy
// intercepting it, or a completely different running process answering
// instead). If it DOES show up here but the response is still HTML, the
// problem is route order below, something above app.get('/api/config')
// is catching it first.
app.use((req, res, next) => {
    console.log(`[http] ${req.method} ${req.originalUrl}`);
    next();
});

// Lets the mobile app pull the Google API key at runtime instead of having
// it baked into the app bundle at build time. Note this is not a security
// boundary on its own, any device that calls this endpoint can read the
// key back out, it just keeps it out of source control and out of the
// compiled app binary. If you want the key to never leave this server at
// all, the stronger move is proxying the actual Places requests through a
// backend route instead of handing the key to the client.
//
// Registered BEFORE express.static() and BEFORE the socket.io setup below
// on purpose, in Express, whichever matching handler is registered first
// wins, so this must come before any static-file serving or catch-all
// route that might otherwise swallow the request and serve index.html.
app.get('/api/config', (req, res) => {
    console.log('[api/config] request received');

    // Nothing about this response is cacheable, the whole reason it's
    // fetched at runtime instead of hardcoded is so the key can be rotated
    // without an app update. Without this header, the original response
    // had no explicit caching instructions at all, which some HTTP clients
    // (and CDNs) will still cache based on heuristics like Last-Modified,
    // exactly the stale-HTML symptom seen while debugging this endpoint.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (!GOOGLE_API_KEY) {
        console.log('[api/config] GOOGLE_API_KEY is not set, responding 500');
        res.status(500).json({ error: 'Google API key is not configured on the server.' });
        return;
    }

    // Log only that a key exists and its length, never the key itself, so
    // this log stays safe to leave on in production.
    console.log(`[api/config] sending key (length ${GOOGLE_API_KEY.length})`);
    res.json({ googleApiKey: GOOGLE_API_KEY });
});

// Lets the frontend "Set Google API Key" form save a new key without
// touching the server filesystem by hand. Updates the in-memory key used by
// every socket handler immediately, and persists it to .env so it survives
// a restart. Only reports whether a key is set and its length, never the
// key value itself, so it's safe to poll on page load.
app.get('/api/config/status', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
        isSet: Boolean(GOOGLE_API_KEY),
        length: GOOGLE_API_KEY ? GOOGLE_API_KEY.length : 0
    });
});

app.post('/api/config', (req, res) => {
    const key = req.body && typeof req.body.googleApiKey === 'string' ? req.body.googleApiKey.trim() : '';

    if (!key) {
        res.status(400).json({ error: 'googleApiKey is required.' });
        return;
    }

    try {
        persistGoogleApiKey(key);
        GOOGLE_API_KEY = key;
        process.env.GOOGLE_API_KEY = key;
        console.log(`[api/config] GOOGLE_API_KEY updated (length ${key.length})`);
        res.json({ ok: true, length: key.length });
    } catch (error) {
        console.error('error saving GOOGLE_API_KEY:', error.message);
        res.status(500).json({ error: 'Failed to save the API key on the server.' });
    }
});

// Snaps a recorded GPS trace from the mobile app onto the nearest real road
// in osm_roads (imported from the Sri Lanka OSM extract, see
// backend/sql/road_directions.sql for the import steps), then records the
// user's one-way/two-way report against that road's OSM way id. Multiple
// reports can exist for the same way, direction is resolved as a majority
// vote below rather than trusting whichever report came in last.
// osm_roads holds every highway=* way (footways, steps, cycleways, pedestrian
// bridges, ...). One-way/two-way tagging and the tagged-roads map only make
// sense for roads a vehicle can drive, so both queries below restrict to these
// classes. Keep in sync with the highway IN (...) list in
// backend/sql/road_routing_topology.sql, which builds the routing graph.
const VEHICLE_HIGHWAYS = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential',
    'living_street', 'service', 'road'
];

// Maps a resolved direction straight onto the cost/reverse_cost convention
// osm_roads_edges already uses (see road_routing_topology.sql): a negative
// value is pgRouting's own sentinel for "this direction isn't part of the
// graph" - pgr_dijkstra drops it entirely rather than merely discouraging
// it, so a blocked direction that's someone's only way to reach a vertex
// correctly comes back as no route (0 rows) instead of a "route" that
// silently uses it anyway. Plain length_m means open. cost is the "forward"
// direction (source -> target, i.e. the same order as the way's own
// digitized geometry), reverse_cost is against it - matching
// relative_direction below exactly. Used to build the UPDATE in
// applyConsensusToRoutingGraph.
const EDGE_COST_SQL = {
    two_way: { cost: 'length_m', reverse_cost: 'length_m' },
    // forward allowed, backward (reverse) blocked
    forward: { cost: 'length_m', reverse_cost: '-1' },
    // backward (reverse) allowed, forward blocked
    backward: { cost: '-1', reverse_cost: 'length_m' }
};

// Pushes a way's community consensus onto the actual routing graph, so a
// one-way report doesn't just sit in road_direction_reports as a label
// nobody acts on (which is what GET /api/directions was doing before this -
// its cost/reverse_cost only ever came from OSM's own oneway tag, baked in
// once when road_routing_topology.sql was last run, see the comment on
// GET /api/directions below). Runs after every report, using the same
// majority vote already computed for the response:
//   - consensus 'two_way' opens both directions, overriding any earlier
//     one-way block for this way now that two-way has the votes.
//   - consensus 'one_way' blocks whichever direction the majority of
//     one-way reporters (the ones with a known relative_direction) say is
//     NOT the way to drive it. If no one-way report for this way has a
//     known relative_direction yet (all predate the relative_direction
//     migration, or every trace was too short/degenerate to tell), there's
//     nothing to act on - the edges are left as they are rather than
//     guessed.
// Failures here are logged, not thrown: osm_roads_edges only exists where
// backend/sql/road_routing_topology.sql has been run (e.g. not on a bare
// local dev DB), and a routing-graph hiccup shouldn't fail the trace
// submission itself.
async function applyConsensusToRoutingGraph(osmWayId, consensus) {
    try {
        let relativeDirection = null;
        if (consensus === 'one_way') {
            const dirTally = await db.query(
                `SELECT relative_direction
                 FROM road_direction_reports
                 WHERE osm_way_id = $1 AND direction = 'one_way' AND relative_direction IS NOT NULL
                 GROUP BY relative_direction
                 ORDER BY COUNT(*) DESC, MAX(reported_at) DESC
                 LIMIT 1`,
                [osmWayId]
            );
            if (dirTally.rows.length === 0) return;
            relativeDirection = dirTally.rows[0].relative_direction;
        }

        const { cost, reverse_cost: reverseCost } = consensus === 'two_way'
            ? EDGE_COST_SQL.two_way
            : EDGE_COST_SQL[relativeDirection];

        await db.query(
            `UPDATE osm_roads_edges SET cost = ${cost}, reverse_cost = ${reverseCost} WHERE osm_way_id = $1`,
            [osmWayId]
        );
    } catch (error) {
        console.error(`[road-trace] could not update routing graph for way ${osmWayId}:`, error.message);
    }
}

app.post('/api/road-trace', async (req, res) => {
    const points = Array.isArray(req.body && req.body.points) ? req.body.points : null;
    const direction = req.body && req.body.direction;

    if (!points || points.length < 2) {
        res.status(400).json({ error: 'points must be an array of at least 2 {lat,lng} entries.' });
        return;
    }
    if (direction !== 'one_way' && direction !== 'two_way') {
        res.status(400).json({ error: 'direction must be "one_way" or "two_way".' });
        return;
    }

    const MAX_MATCH_DISTANCE_M = 60;
    const lineWkt = `LINESTRING(${points.map((p) => `${p.lng} ${p.lat}`).join(', ')})`;

    try {
        // osm_roads.geom is stored in SRID 3857 (what osm2pgsql's flex output
        // produces), so the input line is reprojected to 3857 rather than
        // transforming every row, that way the <-> KNN search can still use
        // idx_osm_roads_geom instead of falling back to a full table scan.
        const match = await db.query(
            `SELECT way_id, name,
                    ST_Distance(geom, ST_Transform(ST_SetSRID(ST_GeomFromText($1), 4326), 3857)) AS distance_m
             FROM osm_roads
             WHERE highway = ANY($2)
             ORDER BY geom <-> ST_Transform(ST_SetSRID(ST_GeomFromText($1), 4326), 3857)
             LIMIT 1`,
            [lineWkt, VEHICLE_HIGHWAYS]
        );

        if (match.rows.length === 0 || match.rows[0].distance_m > MAX_MATCH_DISTANCE_M) {
            console.log(`[road-trace] no confident match within ${MAX_MATCH_DISTANCE_M}m`);
            res.json({ matched: false });
            return;
        }

        const { way_id: osmWayId, name, distance_m: distanceM } = match.rows[0];

        // Only meaningful for a one-way report: which way along the matched
        // way's own digitized geometry (osm_roads.geom's point order) the
        // reporter actually drove. ST_LineLocatePoint gives each point's
        // fractional position (0 = the way's start, 1 = its end) along that
        // geometry; points[0] -> points[last] is the direction the reporter
        // says traffic is allowed to move, so comparing their fractions says
        // whether that's the same way the geometry runs (forward) or against
        // it (backward). Left null (rather than guessed) on a degenerate
        // trace whose start and end land on the same point of the road -
        // this report still counts toward the one_way/two_way tally below,
        // it just can't vote on which direction to block.
        let relativeDirection = null;
        if (direction === 'one_way') {
            const first = points[0];
            const last = points[points.length - 1];
            const frac = await db.query(
                `SELECT
                    ST_LineLocatePoint(geom, ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), 3857)) AS start_frac,
                    ST_LineLocatePoint(geom, ST_Transform(ST_SetSRID(ST_MakePoint($4, $5), 4326), 3857)) AS end_frac
                 FROM osm_roads WHERE way_id = $1`,
                [osmWayId, first.lng, first.lat, last.lng, last.lat]
            );
            const { start_frac: startFrac, end_frac: endFrac } = frac.rows[0];
            if (startFrac !== endFrac) {
                relativeDirection = endFrac > startFrac ? 'forward' : 'backward';
            }
        }

        await db.query(
            'INSERT INTO road_direction_reports (osm_way_id, direction, relative_direction, distance_m) VALUES ($1, $2, $3, $4)',
            [osmWayId, direction, relativeDirection, distanceM]
        );

        const tally = await db.query(
            `SELECT direction, COUNT(*) AS count, MAX(reported_at) AS last_reported_at
             FROM road_direction_reports
             WHERE osm_way_id = $1
             GROUP BY direction
             ORDER BY count DESC, last_reported_at DESC`,
            [osmWayId]
        );

        const consensus = tally.rows[0].direction;
        await applyConsensusToRoutingGraph(osmWayId, consensus);

        console.log(`[road-trace] matched "${name}" (way ${osmWayId}), ${distanceM.toFixed(1)}m away`);

        res.json({
            matched: true,
            osmWayId,
            name: name || null,
            distanceM,
            consensus,
            reportCount: tally.rows.reduce((sum, row) => sum + Number(row.count), 0)
        });
    } catch (error) {
        console.error('error matching road trace:', error.message);
        res.status(500).json({ error: 'Failed to match this trace against the road network.' });
    }
});

// Every road that has at least one direction report, with its geometry, so
// the mobile app can render already-tagged roads on the map. Aggregation
// mirrors the majority-vote logic in POST /api/road-trace above.
//
// oneWayDirection ('forward' | 'backward' | null) is the same relative-to-
// the-way's-own-geometry direction applyConsensusToRoutingGraph uses to
// block a direction in the routing graph (see POST /api/road-trace); it's
// only meaningful when consensus is 'one_way', and can still be null there
// (no one-way report for this road has a known relative_direction yet). Left
// as a separate LEFT JOIN LATERAL rather than folded into the tally above so
// a road whose one-way reports all predate the relative_direction migration
// still shows up with consensus 'one_way' instead of silently dropping out.
app.get('/api/road-directions', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT r.way_id, r.name, ST_AsGeoJSON(ST_Transform(r.geom, 4326)) AS geometry,
                    tally.direction AS consensus, tally.report_count,
                    dir_tally.relative_direction AS one_way_direction
             FROM osm_roads r
             JOIN LATERAL (
                 SELECT direction, COUNT(*) AS report_count, MAX(reported_at) AS last_reported_at
                 FROM road_direction_reports
                 WHERE osm_way_id = r.way_id
                 GROUP BY direction
                 ORDER BY COUNT(*) DESC, MAX(reported_at) DESC
                 LIMIT 1
             ) tally ON true
             LEFT JOIN LATERAL (
                 SELECT relative_direction
                 FROM road_direction_reports
                 WHERE osm_way_id = r.way_id AND direction = 'one_way' AND relative_direction IS NOT NULL
                 GROUP BY relative_direction
                 ORDER BY COUNT(*) DESC, MAX(reported_at) DESC
                 LIMIT 1
             ) dir_tally ON tally.direction = 'one_way'
             WHERE r.highway = ANY($1)`,
            [VEHICLE_HIGHWAYS]
        );

        res.json(
            result.rows.map((row) => ({
                osmWayId: row.way_id,
                name: row.name,
                geometry: JSON.parse(row.geometry),
                consensus: row.consensus,
                oneWayDirection: row.one_way_direction || null,
                reportCount: Number(row.report_count)
            }))
        );
    } catch (error) {
        console.error('error fetching road directions:', error.message);
        res.status(500).json({ error: 'Failed to load tagged roads.' });
    }
});

// Free-text place -> {lat, lng, address} via the public OSM Nominatim
// geocoder (no API key, no Google). Nominatim's usage policy caps this at
// ~1 request/sec and asks for an identifying User-Agent, both fine for this
// app's traffic. countrycodes biases ambiguous names (more than one
// "Galle" exists) toward Sri Lanka without hard-restricting to it.
async function geocode(place) {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
            q: place,
            format: 'json',
            limit: 1,
            countrycodes: 'lk'
        },
        headers: { 'User-Agent': 'location-socket-app-test/1.0 (https://test.servefamily.com)' }
    });

    const hit = response.data[0];
    if (!hit) return null;

    return { lat: Number(hit.lat), lng: Number(hit.lon), address: hit.display_name };
}

// Matches "6.9271, 79.8612" / "6.9271 79.8612" / "(6.9271,79.8612)": two signed
// decimals split by a comma and/or whitespace, in lat, lng order.
const LAT_LNG_PATTERN = /^\(?\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*\)?$/;

// Returns {lat, lng} if the text is a coordinate pair, null if it is just a
// place name, and throws if it looks like coordinates but is out of range.
function parseLatLng(text) {
    const match = LAT_LNG_PATTERN.exec(text);
    if (!match) return null;

    const lat = Number(match[1]);
    const lng = Number(match[2]);

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        const err = new Error(`"${text}" is not a valid latitude, longitude pair.`);
        err.status = 400;
        throw err;
    }

    return { lat, lng };
}

// A route endpoint can be typed either as a place name (geocoded through
// Nominatim) or as raw "lat, lng" coordinates, which skip the geocoder.
async function resolvePlace(text) {
    const coords = parseLatLng(text);
    if (coords) return { ...coords, address: `${coords.lat}, ${coords.lng}` };
    return geocode(text);
}

// Nearest osm_roads_vertices_pgr node to a lat/lng, so a geocoded point
// (which rarely sits exactly on a road) has a graph node to route from/to.
async function nearestVertex(lat, lng) {
    const result = await db.query(
        `SELECT id
         FROM osm_roads_vertices_pgr
         ORDER BY geom <-> ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857)
         LIMIT 1`,
        [lng, lat]
    );
    return result.rows[0] ? result.rows[0].id : null;
}

// Turns two free-text places (e.g. "Colombo" / "Galle") or "lat, lng" pairs
// (e.g. "6.9271, 79.8612"), in any combination, into a driving
// route, entirely on our own infrastructure: Nominatim (free OSM geocoder)
// resolves the place names, then pgRouting's Dijkstra implementation finds
// the shortest path over osm_roads_edges, a routing graph built from the
// same osm_roads network used for the tagged-roads map (see
// backend/sql/road_directions.sql) but split into a separate table at
// every real shared OSM node, not just each road's own endpoints -
// otherwise a road that simply passes through a junction (the common case)
// never gets a graph node there. See backend/sql/road_routing_topology.sql.
// cost/reverse_cost start out derived from geometry length and the OSM
// oneway tag when the graph is (re)built (road_routing_topology.sql), so a
// one-way street the wrong direction is simply very expensive to traverse
// rather than hard-blocked. From then on, POST /api/road-trace keeps them
// current with whatever the community has actually reported for a way
// (majority vote, see applyConsensusToRoutingGraph above) - so a road
// tagged one-way through the app affects routes immediately, without
// needing the graph rebuilt.
app.get('/api/directions', async (req, res) => {
    const origin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    const destination = typeof req.query.destination === 'string' ? req.query.destination.trim() : '';

    if (!origin || !destination) {
        res.status(400).json({ error: 'origin and destination query params are required.' });
        return;
    }

    try {
        const [originPoint, destPoint] = await Promise.all([resolvePlace(origin), resolvePlace(destination)]);

        if (!originPoint) {
            res.status(404).json({ error: `Could not find "${origin}".` });
            return;
        }
        if (!destPoint) {
            res.status(404).json({ error: `Could not find "${destination}".` });
            return;
        }

        const [startVid, endVid] = await Promise.all([
            nearestVertex(originPoint.lat, originPoint.lng),
            nearestVertex(destPoint.lat, destPoint.lng)
        ]);

        if (startVid === null || endVid === null) {
            res.status(404).json({ error: 'No road network node found near one of those places.' });
            return;
        }

        const route = await db.query(
            `SELECT ST_AsGeoJSON(ST_LineMerge(ST_Transform(ST_Collect(r.geom ORDER BY d.seq), 4326))) AS geometry,
                    SUM(d.cost) AS total_cost_m
             FROM pgr_dijkstra(
                 'SELECT edge_id AS id, source, target, cost, reverse_cost FROM osm_roads_edges',
                 $1::bigint, $2::bigint
             ) d
             JOIN osm_roads_edges r ON r.edge_id = d.edge
             WHERE d.edge != -1`,
            [startVid, endVid]
        );

        if (route.rows.length === 0 || !route.rows[0].geometry) {
            console.log(`[directions] "${origin}" -> "${destination}": no path in road network`);
            res.status(404).json({ error: 'No route found between these places on the mapped road network.' });
            return;
        }

        console.log(`[directions] "${origin}" -> "${destination}": ${(route.rows[0].total_cost_m / 1000).toFixed(1)}km`);

        res.json({
            distanceKm: Number((route.rows[0].total_cost_m / 1000).toFixed(1)),
            startAddress: originPoint.address,
            endAddress: destPoint.address,
            startLocation: { lat: originPoint.lat, lng: originPoint.lng },
            endLocation: { lat: destPoint.lat, lng: destPoint.lng },
            geometry: JSON.parse(route.rows[0].geometry)
        });
    } catch (error) {
        if (error.status === 400) {
            res.status(400).json({ error: error.message });
            return;
        }
        console.error('error fetching directions:', error.message);
        res.status(500).json({ error: 'Failed to fetch directions.' });
    }
});

// Static frontend files (and, if you have one, a SPA catch-all) come
// AFTER the API routes above, so a request for /api/config is already
// handled by the time Express would otherwise fall back to serving
// index.html for an unrecognized path.
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

if (!GOOGLE_API_KEY) {
    console.error('no api key');
}

io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.id}`);

    let sessionToken = crypto.randomUUID();
    socket.on('search_text', async (searchText) => {
        if (!searchText || !searchText.trim()) return;

        try {
            const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
            const response = await axios.get(url, {
                params: {
                    input: searchText,
                    key: GOOGLE_API_KEY,
                    sessiontoken: sessionToken,
                    components: 'country:lk'
                }
            });

            if (response.data.status !== 'OK') {
                if (response.data.status !== 'ZERO_RESULTS') {
                    console.log(`google autocom w: ${response.data.status} ${response.data.error_message || ''}`);
                }
                socket.emit('suggestions_result', []);
                return;
            }

            const suggestions = response.data.predictions.map((p) => ({
                placeId: p.place_id,
                description: p.description
            }));

            socket.emit('suggestions_result', suggestions);
        } catch (error) {
            console.error('error autocomplete request failed:', error.message);
            socket.emit('suggestions_result', []);
        }
    });

    socket.on('get_location', async (payload) => {
        const placeId = payload && payload.placeId;
        const placeName = payload && payload.description;

        if (!placeId || !placeName) {
            socket.emit('location_error', 'Pick a suggestion from the list first.');
            return;
        }

        try {
            console.log(`search req: "${placeName}"`);

            const cached = await db.query(
                'SELECT * FROM locations WHERE place_name = $1',
                [placeName]
            );

            if (cached.rows.length > 0) {
                const row = cached.rows[0];
                console.log(`db cache hit: lat ${row.latitude}, lng ${row.longitude}`);

                socket.emit('location_result', {
                    name: row.place_name,
                    lat: Number(row.latitude),
                    lng: Number(row.longitude),
                    source: 'PostgreSQL cache'
                });
                return;
            }

            console.log('db cache miss, calling google place details API');

            const detailsUrl = 'https://maps.googleapis.com/maps/api/place/details/json';
            const response = await axios.get(detailsUrl, {
                params: {
                    place_id: placeId,
                    fields: 'geometry,formatted_address,name',
                    key: GOOGLE_API_KEY,
                    sessiontoken: sessionToken
                }
            });

            sessionToken = crypto.randomUUID();

            if (response.data.status !== 'OK') {
                console.log(`google place details failed: ${response.data.status} ${response.data.error_message || ''}`);
                socket.emit('location_error', 'could not resolve that location.');
                return;
            }

            const { lat, lng } = response.data.result.geometry.location;
            console.log(`google resolved: lat ${lat}, lng ${lng}`);

            // No target on ON CONFLICT here so it catches a conflict on
            // EITHER unique constraint: place_name, or the exact same
            // (latitude, longitude) already saved under different name
            // text (e.g. "Galle" vs "Galle, Sri Lanka" are the same spot).
            await db.query(
                `INSERT INTO locations (place_name, latitude, longitude)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [placeName, lat, lng]
            );
            console.log('db cached for next time.');

            // push the fresh full list to everyone so tables update live
            const all = await db.query(
                'SELECT id, place_name, latitude, longitude, created_at FROM locations ORDER BY created_at DESC'
            );
            io.emit('all_locations_result', all.rows);

            socket.emit('location_result', {
                name: placeName,
                lat,
                lng,
                source: 'Google API (live fetch)'
            });
        } catch (error) {
            console.error('error Location lookup failed:', error.message);
            socket.emit('location_error', 'Something went wrong while fetching that location.');
        }
    });

    // The mobile app's "Use My Location" flow resolves nearby places on the
    // device itself, straight from Google's nearbysearch endpoint, so it
    // already has name, lat, and lng with no placeId round trip needed.
    // This event just takes that and caches it, the same way get_location
    // does after a live Google fetch.
    socket.on('save_location', async (payload) => {
        const name = payload && payload.name;
        const lat = payload && payload.lat;
        const lng = payload && payload.lng;

        if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
            socket.emit('location_error', 'save_location needs a name, a numeric lat, and a numeric lng.');
            return;
        }

        try {
            console.log(`save req: "${name}" (${lat}, ${lng})`);

            // No target on ON CONFLICT: a place already saved by this or
            // another client (matched by name OR by this exact coordinate
            // already existing under different name text) is skipped
            // quietly, no error, no duplicate row.
            await db.query(
                `INSERT INTO locations (place_name, latitude, longitude)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [name, lat, lng]
            );
            console.log('db saved (or already existed).');

            // push the fresh full list to everyone, same as get_location
            const all = await db.query(
                'SELECT id, place_name, latitude, longitude, created_at FROM locations ORDER BY created_at DESC'
            );
            io.emit('all_locations_result', all.rows);

            socket.emit('location_result', {
                name,
                lat,
                lng,
                source: 'nearby search (client-side Google API)'
            });
        } catch (error) {
            console.error('error saving location:', error.message);
            socket.emit('location_error', 'Something went wrong while saving that location.');
        }
    });

    // sends the full cached table, called on connect and on demand
    socket.on('get_all_locations', async () => {
        try {
            const all = await db.query(
                'SELECT id, place_name, latitude, longitude, created_at FROM locations ORDER BY created_at DESC'
            );
            socket.emit('all_locations_result', all.rows);
        } catch (error) {
            console.error('error fetching all locations:', error.message);
            socket.emit('all_locations_result', []);
        }
    });

    socket.on('disconnect', () => {
        console.log(`client Disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT}`);
    console.log(`Config endpoint: http://localhost:${PORT}/api/config`);
});
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
             ORDER BY geom <-> ST_Transform(ST_SetSRID(ST_GeomFromText($1), 4326), 3857)
             LIMIT 1`,
            [lineWkt]
        );

        if (match.rows.length === 0 || match.rows[0].distance_m > MAX_MATCH_DISTANCE_M) {
            console.log(`[road-trace] no confident match within ${MAX_MATCH_DISTANCE_M}m`);
            res.json({ matched: false });
            return;
        }

        const { way_id: osmWayId, name, distance_m: distanceM } = match.rows[0];

        await db.query(
            'INSERT INTO road_direction_reports (osm_way_id, direction, distance_m) VALUES ($1, $2, $3)',
            [osmWayId, direction, distanceM]
        );

        const tally = await db.query(
            `SELECT direction, COUNT(*) AS count, MAX(reported_at) AS last_reported_at
             FROM road_direction_reports
             WHERE osm_way_id = $1
             GROUP BY direction
             ORDER BY count DESC, last_reported_at DESC`,
            [osmWayId]
        );

        console.log(`[road-trace] matched "${name}" (way ${osmWayId}), ${distanceM.toFixed(1)}m away`);

        res.json({
            matched: true,
            osmWayId,
            name: name || null,
            distanceM,
            consensus: tally.rows[0].direction,
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
app.get('/api/road-directions', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT r.way_id, r.name, ST_AsGeoJSON(ST_Transform(r.geom, 4326)) AS geometry,
                    tally.direction AS consensus, tally.report_count
             FROM osm_roads r
             JOIN LATERAL (
                 SELECT direction, COUNT(*) AS report_count, MAX(reported_at) AS last_reported_at
                 FROM road_direction_reports
                 WHERE osm_way_id = r.way_id
                 GROUP BY direction
                 ORDER BY COUNT(*) DESC, MAX(reported_at) DESC
                 LIMIT 1
             ) tally ON true`
        );

        res.json(
            result.rows.map((row) => ({
                osmWayId: row.way_id,
                name: row.name,
                geometry: JSON.parse(row.geometry),
                consensus: row.consensus,
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

// Turns two free-text places (e.g. "Colombo" / "Galle") into a driving
// route, entirely on our own infrastructure: Nominatim (free OSM geocoder)
// resolves the place names, then pgRouting's Dijkstra implementation finds
// the shortest path over the osm_roads network already imported into
// Postgres for the tagged-roads map (see backend/sql/road_directions.sql).
// osm_roads.cost/reverse_cost were pre-computed from geometry length and
// the OSM oneway tag by backend/sql/road_routing_topology.sql, so a
// one-way street the wrong direction is simply very expensive to traverse.
app.get('/api/directions', async (req, res) => {
    const origin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    const destination = typeof req.query.destination === 'string' ? req.query.destination.trim() : '';

    if (!origin || !destination) {
        res.status(400).json({ error: 'origin and destination query params are required.' });
        return;
    }

    try {
        const [originPoint, destPoint] = await Promise.all([geocode(origin), geocode(destination)]);

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
                 'SELECT way_id AS id, source, target, cost, reverse_cost FROM osm_roads',
                 $1::bigint, $2::bigint
             ) d
             JOIN osm_roads r ON r.way_id = d.edge
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

            await db.query(
                `INSERT INTO locations (place_name, latitude, longitude)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (place_name) DO NOTHING`,
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

            // ON CONFLICT DO NOTHING here means a place already saved by
            // this or another client just gets skipped quietly, no error,
            // no duplicate row, matching how get_location already behaves.
            await db.query(
                `INSERT INTO locations (place_name, latitude, longitude)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (place_name) DO NOTHING`,
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
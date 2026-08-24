const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

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

    // New event. The mobile app's "Use My Location" flow resolves nearby
    // places on the device itself, straight from Google's nearbysearch
    // endpoint, so it already has name, lat, and lng with no placeId round
    // trip needed. This event just takes that and caches it, the same way
    // get_location does after a live Google fetch.
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
});
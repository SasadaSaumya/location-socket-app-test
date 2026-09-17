# Location Socket App — Full API Documentation

Complete reference for every API surface this server exposes: the real-time
Socket.IO location search/cache API, and the REST endpoints for app
configuration, one-way/two-way road tagging, and free/self-hosted driving
directions.

## Base URL

```text
https://test.servefamily.com
```

## Authentication

```text
None required
```

There is no API key, token, or login for any endpoint or socket event in
this API. Anyone who can reach the base URL can call everything below.
`POST /api/config` in particular lets a caller overwrite the server's
Google API key — see the security note in that section.

## Transport

| Surface | Protocol | Section |
|---|---|---|
| Location search, coordinate lookup, location cache | Socket.IO / WebSocket | [§2 Socket.IO API](#2-socketio-api) |
| App config, road tagging, tagged-roads map data, driving directions | HTTP REST (JSON) | [§1 REST API](#1-rest-api) |

CORS is open (`Access-Control-Allow-Origin: *`) on every REST route, so any
origin can call the REST API directly from a browser.

---

# 1. REST API

All REST responses are `application/json`. There is no versioning prefix —
routes are rooted at `/api/`.

## 1.1 `GET /api/config`

Returns the Google API key currently configured on the server, so a mobile
app can fetch it at runtime instead of baking it into the app bundle at
build time.

> ⚠️ **Not a security boundary.** Any client that can call this endpoint
> can read the live Google API key back out. It only keeps the key out of
> source control and out of the compiled app binary. If the key must never
> reach the client at all, proxy the actual Google Places calls through a
> backend route instead (which is exactly what the Socket.IO `search_text`
> / `get_location` events already do — see §2).

**Auth:** none
**Cache:** `Cache-Control: no-store, no-cache, must-revalidate` (always fetched fresh, never cached)

### Response — 200 OK

```json
{
    "googleApiKey": "AIzaSy...redacted..."
}
```

### Response — 500 (key not configured)

```json
{
    "error": "Google API key is not configured on the server."
}
```

### Example

```bash
curl https://test.servefamily.com/api/config
```

---

## 1.2 `GET /api/config/status`

Reports whether a Google API key is set and how long it is, without ever
returning the key itself. Safe to poll from a frontend on page load (this
is what the home page's "Google API Key" panel uses).

**Auth:** none

### Response — 200 OK

```json
{
    "isSet": true,
    "length": 39
}
```

| Field | Type | Description |
|---|---|---|
| `isSet` | boolean | Whether `GOOGLE_API_KEY` is currently configured |
| `length` | number | Character length of the configured key (`0` if unset) |

### Example

```bash
curl https://test.servefamily.com/api/config/status
```

---

## 1.3 `POST /api/config`

Sets (or replaces) the server's Google API key. Updates the key in memory
immediately — every subsequent Socket.IO `search_text` / `get_location`
call uses the new key right away — and persists it to `backend/.env` so it
survives a server restart. Only ever writes the `GOOGLE_API_KEY` line;
every other line in `.env` is left untouched.

> ⚠️ **No auth on this route.** Anyone who can reach the server can
> overwrite the live Google API key. Treat this endpoint as trusted-network
> / admin-only in practice, even though the server doesn't enforce that.

**Auth:** none
**Content-Type:** `application/json`

### Request Body

```json
{
    "googleApiKey": "AIzaSy...your-key..."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `googleApiKey` | string | Yes | The new Google API key. Whitespace is trimmed; empty string is rejected. |

### Response — 200 OK

```json
{
    "ok": true,
    "length": 39
}
```

### Response — 400 (missing key)

```json
{
    "error": "googleApiKey is required."
}
```

### Response — 500 (couldn't write to disk)

```json
{
    "error": "Failed to save the API key on the server."
}
```

### Example

```bash
curl -X POST https://test.servefamily.com/api/config \
  -H "Content-Type: application/json" \
  -d '{"googleApiKey": "AIzaSy...your-key..."}'
```

---

## 1.4 `POST /api/road-trace`

Snaps a recorded GPS trace (e.g. from a mobile app driving along a road) to
the nearest real road in the imported OpenStreetMap network, then records
the caller's one-way/two-way report against that road. Multiple people can
report the same road; the server resolves conflicts by majority vote
rather than trusting whichever report arrived most recently (see
`GET /api/road-directions` for how the tally is read back).

**Auth:** none
**Content-Type:** `application/json`
**Match radius:** 60 meters — a trace that doesn't come within 60m of any
known road is reported as unmatched rather than guessed.

### Request Body

```json
{
    "points": [
        { "lat": 6.9271, "lng": 79.8612 },
        { "lat": 6.9275, "lng": 79.8618 },
        { "lat": 6.9280, "lng": 79.8623 }
    ],
    "direction": "one_way"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `points` | array of `{lat, lng}` | Yes | At least 2 GPS points forming the traveled path, in order |
| `direction` | `"one_way"` \| `"two_way"` | Yes | What the caller observed while driving this road |

### Response — 200 OK (matched)

```json
{
    "matched": true,
    "osmWayId": "8625227",
    "name": "Dickson Road",
    "distanceM": 4.2,
    "consensus": "one_way",
    "reportCount": 3
}
```

| Field | Type | Description |
|---|---|---|
| `matched` | boolean | `true` — a nearby road was found |
| `osmWayId` | string | OpenStreetMap way ID of the matched road |
| `name` | string \| null | Road name from OSM, if it has one |
| `distanceM` | number | Distance in meters between the trace and the matched road |
| `consensus` | `"one_way"` \| `"two_way"` | The current majority-vote direction for this road, including this new report |
| `reportCount` | number | Total number of reports ever submitted for this road (all directions combined) |

### Response — 200 OK (no confident match)

```json
{
    "matched": false
}
```

Returned instead of an error when the trace is more than 60m from every
known road — nothing is recorded in this case.

### Response — 400 (bad input)

```json
{ "error": "points must be an array of at least 2 {lat,lng} entries." }
```
```json
{ "error": "direction must be \"one_way\" or \"two_way\"." }
```

### Response — 500

```json
{ "error": "Failed to match this trace against the road network." }
```

### Example

```bash
curl -X POST https://test.servefamily.com/api/road-trace \
  -H "Content-Type: application/json" \
  -d '{
    "points": [{"lat":6.9271,"lng":79.8612},{"lat":6.9275,"lng":79.8618}],
    "direction": "one_way"
  }'
```

---

## 1.5 `GET /api/road-directions`

Returns every road that has at least one direction report, with its full
geometry, so a map can render already-tagged roads. This is what the
`/map` page's one-way (red) / two-way (green) overlay is built from.
Aggregation uses the same majority-vote logic as `POST /api/road-trace`.

Roads with **zero** reports are not included — this endpoint is only the
tagged subset, not the full road network (for that, see the routing graph
used internally by `GET /api/directions`).

**Auth:** none

### Response — 200 OK

```json
[
    {
        "osmWayId": "8625227",
        "name": "Dickson Road",
        "geometry": {
            "type": "LineString",
            "coordinates": [
                [80.2186699, 6.035074699],
                [80.2187311, 6.034904699],
                [80.2187631, 6.034811699]
            ]
        },
        "consensus": "one_way",
        "reportCount": 3
    }
]
```

| Field | Type | Description |
|---|---|---|
| `osmWayId` | string | OpenStreetMap way ID |
| `name` | string \| null | Road name from OSM |
| `geometry` | GeoJSON `LineString` | Road path, `[lng, lat]` pairs in WGS84 (EPSG:4326) |
| `consensus` | `"one_way"` \| `"two_way"` | Current majority-vote direction |
| `reportCount` | number | Number of reports backing the winning direction |

### Response — 500

```json
{ "error": "Failed to load tagged roads." }
```

### Example

```bash
curl https://test.servefamily.com/api/road-directions
```

```javascript
fetch('https://test.servefamily.com/api/road-directions')
  .then((res) => res.json())
  .then((roads) => console.log(`${roads.length} tagged roads`));
```

---

## 1.6 `GET /api/directions`

Turns two free-text place names (e.g. `"Colombo"` → `"Galle"`) into a
driving route — **entirely free and self-hosted, no Google Maps
dependency**:

1. Each place name is geocoded via the public **OSM Nominatim** API (no
   API key).
2. The shortest path between them is computed by **pgRouting's Dijkstra**
   implementation, running against this server's own Postgres database,
   over a routing graph built from the Sri Lanka OpenStreetMap road
   network (see `backend/sql/road_routing_topology.sql`).
3. Each road's OSM `oneway` tag is baked into the graph as a direction
   cost, so the route respects one-way streets.

**Auth:** none

### Query Parameters

| Param | Type | Required | Description |
|---|---|---|---|
| `origin` | string | Yes | Free-text starting place, e.g. `Colombo` |
| `destination` | string | Yes | Free-text destination place, e.g. `Galle` |

### Response — 200 OK

```json
{
    "distanceKm": 119.1,
    "startAddress": "Colombo, Colombo District, Western Province, Sri Lanka",
    "endAddress": "Galle, Galle District, Southern Province, Sri Lanka",
    "startLocation": { "lat": 6.9319248, "lng": 79.8478623 },
    "endLocation": { "lat": 6.0535141, "lng": 80.2148804 },
    "geometry": {
        "type": "LineString",
        "coordinates": [
            [79.8478623, 6.9319248],
            [79.8482, 6.9315],
            [80.2148804, 6.0535141]
        ]
    }
}
```

| Field | Type | Description |
|---|---|---|
| `distanceKm` | number | Total route distance in kilometers, rounded to 1 decimal |
| `startAddress` | string | Full geocoded address of `origin`, from Nominatim |
| `endAddress` | string | Full geocoded address of `destination`, from Nominatim |
| `startLocation` | `{lat, lng}` | Geocoded coordinates of `origin` |
| `endLocation` | `{lat, lng}` | Geocoded coordinates of `destination` |
| `geometry` | GeoJSON `LineString` | The route path, `[lng, lat]` pairs in WGS84 (EPSG:4326) |

> **No ETA.** `distanceKm` is pure road length; there is no travel-time
> estimate. Unlike Google Directions, this endpoint has no speed model —
> it doesn't know posted speed limits or traffic, so there's nothing
> meaningful to base a duration on.

### Response — 400 (missing params)

```json
{ "error": "origin and destination query params are required." }
```

### Response — 404 (place not found)

```json
{ "error": "Could not find \"Nowhereville\"." }
```

### Response — 404 (no road-network node nearby)

```json
{ "error": "No road network node found near one of those places." }
```

### Response — 404 (geocoded, but no route exists)

```json
{ "error": "No route found between these places on the mapped road network." }
```

Can happen for places in genuinely disconnected parts of the network
(e.g. an island reachable only by ferry, or a private/unmapped track).

### Response — 500

```json
{ "error": "Failed to fetch directions." }
```

### Example

```bash
curl "https://test.servefamily.com/api/directions?origin=Colombo&destination=Galle"
```

```javascript
const res = await fetch(
  `https://test.servefamily.com/api/directions?origin=${encodeURIComponent('Colombo')}&destination=${encodeURIComponent('Galle')}`
);
const route = await res.json();
console.log(`${route.distanceKm} km from ${route.startAddress} to ${route.endAddress}`);
```

### Rate limiting note

Nominatim's usage policy caps free public use at roughly **1 request per
second**. Each call to this endpoint makes 2 Nominatim requests (origin +
destination), so avoid firing it in a tight loop.

---

# 2. Socket.IO API

Real-time location search, coordinate lookup, and a shared cache of
previously-resolved locations (backed by Postgres, broadcast to every
connected client when it changes).

## 2.1 Installation

```bash
npm install socket.io-client
```

## 2.2 Connect

```javascript
import { io } from 'socket.io-client';

const socket = io('https://test.servefamily.com');

socket.on('connect', () => {
    console.log('Connected to Location API');
    console.log('Socket ID:', socket.id);
});

socket.on('connect_error', (error) => {
    console.error('Connection failed:', error.message);
});

socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
});
```

On every connection, the server internally generates a fresh Google Places
session token (used to keep autocomplete + place-details billing grouped
as one session). This is handled entirely server-side — nothing to do on
the client.

---

## 2.3 `search_text` — search for a place (client → server)

Triggers a Google Places Autocomplete lookup, biased to Sri Lanka
(`components: country:lk`).

### Emit

```javascript
socket.emit('search_text', 'Pettah Railway Station');
```

| Payload | Type | Description |
|---|---|---|
| (unnamed) | string | Free-text search query. Empty/whitespace-only strings are silently ignored (no event fires back). |

### Response: `suggestions_result` (server → client)

```javascript
socket.on('suggestions_result', (suggestions) => {
    console.log(suggestions);
});
```

```json
[
    { "placeId": "ChIJxxxxxxxxxxxxxxxx", "description": "Pettah Railway Station, Colombo, Sri Lanka" },
    { "placeId": "ChIJyyyyyyyyyyyyyyyy", "description": "Pettah, Colombo, Sri Lanka" }
]
```

| Field | Type | Description |
|---|---|---|
| `placeId` | string | Google Place ID — pass this into `get_location` |
| `description` | string | Human-readable place description |

An empty array `[]` is emitted both for zero results and for any upstream
Google API failure — check the server logs (`google autocom w: ...`) if
suggestions are unexpectedly empty.

---

## 2.4 `get_location` — resolve coordinates (client → server)

Resolves a picked suggestion to actual lat/lng. Checks the Postgres cache
first (by exact place name); on a cache miss, calls Google Place Details
and caches the result for every future lookup of that same place name.

### Emit

```javascript
socket.emit('get_location', {
    placeId: 'ChIJxxxxxxxxxxxxxxxx',
    description: 'Pettah Railway Station, Colombo, Sri Lanka'
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `placeId` | string | Yes | Place ID from `suggestions_result` |
| `description` | string | Yes | Description from `suggestions_result` — also used as the cache key |

### Response: `location_result` (server → client)

```javascript
socket.on('location_result', (data) => {
    console.log(data);
});
```

```json
{
    "name": "Pettah Railway Station, Colombo, Sri Lanka",
    "lat": 6.9344,
    "lng": 79.8500,
    "source": "PostgreSQL cache"
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Place name (same as `description` sent in) |
| `lat` | number | Latitude |
| `lng` | number | Longitude |
| `source` | string | Where the coordinates came from — see below |

**`source` values:**

| Value | Meaning |
|---|---|
| `"PostgreSQL cache"` | Already resolved before; served from the `locations` table, no Google call made |
| `"Google API (live fetch)"` | Cache miss; freshly resolved via Google Place Details and now cached |

When a fresh Google lookup happens, the server also broadcasts
`all_locations_result` to **every** connected client (not just the one who
asked), so shared location tables stay live across clients.

### Response: `location_error` (server → client)

```javascript
socket.on('location_error', (message) => {
    console.error('Location Error:', message);
});
```

| Message | When |
|---|---|
| `"Pick a suggestion from the list first."` | `placeId` or `description` missing from the emitted payload |
| `"could not resolve that location."` | Google Place Details returned a non-`OK` status |
| `"Something went wrong while fetching that location."` | Unexpected server/DB error |

---

## 2.5 `save_location` — cache a location directly (client → server)

For clients that already have a resolved name/lat/lng from elsewhere (e.g.
a mobile app's own "Use My Location" flow via Google Nearby Search on the
device) and just want it added to the shared cache, without a
`placeId` round trip.

### Emit

```javascript
socket.emit('save_location', {
    name: 'Current Location - Home',
    lat: 6.9271,
    lng: 79.8612
});
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Place name — also the cache key (unique) |
| `lat` | number | Yes | Latitude |
| `lng` | number | Yes | Longitude |

If a location with this exact `name` is already cached (by this or any
other client), the save is silently skipped — no error, no duplicate row.

### Response: `location_result` (server → client)

Same shape as §2.4, with `source: "nearby search (client-side Google API)"`.

### Response: `location_error` (server → client)

| Message | When |
|---|---|
| `"save_location needs a name, a numeric lat, and a numeric lng."` | Missing/wrong-typed field |
| `"Something went wrong while saving that location."` | Unexpected server/DB error |

On success, `all_locations_result` is broadcast to every connected client,
same as `get_location`.

---

## 2.6 `get_all_locations` — fetch the full cache (client → server)

Requests the complete, current `locations` table. Also fires automatically
once right after `connect`, so a freshly-connected client always gets the
full list without asking.

### Emit

```javascript
socket.emit('get_all_locations');
```

No payload.

### Response: `all_locations_result` (server → client)

```javascript
socket.on('all_locations_result', (locations) => {
    console.log(locations);
});
```

```json
[
    {
        "id": 1,
        "place_name": "Pettah Railway Station, Colombo, Sri Lanka",
        "latitude": 6.9344,
        "longitude": 79.8500,
        "created_at": "2026-08-18T15:30:00.000Z"
    }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | number | Row ID |
| `place_name` | string | Unique place name |
| `latitude` | number | Latitude |
| `longitude` | number | Longitude |
| `created_at` | ISO 8601 string | When this location was first cached |

Ordered newest-first (`ORDER BY created_at DESC`). This same event also
fires unsolicited (broadcast to all clients) whenever any client caches a
new place via `get_location` or `save_location`.

---

## 2.7 Event Summary

| Direction | Event | Payload |
|---|---|---|
| Client → Server | `search_text` | search text (string) |
| Server → Client | `suggestions_result` | array of `{placeId, description}` |
| Client → Server | `get_location` | `{placeId, description}` |
| Server → Client | `location_result` | `{name, lat, lng, source}` |
| Server → Client | `location_error` | error message (string) |
| Client → Server | `save_location` | `{name, lat, lng}` |
| Client → Server | `get_all_locations` | none |
| Server → Client | `all_locations_result` | array of cached location rows |

---

## 2.8 Complete Socket.IO Integration Example

```javascript
import { io } from 'socket.io-client';

const socket = io('https://test.servefamily.com');

socket.on('connect', () => {
    console.log('Connected to Location API');
});

// Search location
socket.emit('search_text', 'Pettah');

socket.on('suggestions_result', (suggestions) => {
    console.log('Suggestions:', suggestions);

    if (suggestions.length > 0) {
        const selectedPlace = suggestions[0];

        // Get coordinates
        socket.emit('get_location', {
            placeId: selectedPlace.placeId,
            description: selectedPlace.description
        });
    }
});

// Receive coordinates
socket.on('location_result', (location) => {
    console.log('Name:', location.name);
    console.log('Latitude:', location.lat);
    console.log('Longitude:', location.lng);
    console.log('Source:', location.source);
});

// Handle errors
socket.on('location_error', (message) => {
    console.error('Location error:', message);
});

// Live-updating cache table
socket.on('all_locations_result', (locations) => {
    console.log(`${locations.length} locations cached`);
});

// Connection error
socket.on('connect_error', (error) => {
    console.error('Connection error:', error.message);
});
```

---

# 3. Data Models

## 3.1 `locations` (Postgres table backing the Socket.IO cache)

| Column | Type | Notes |
|---|---|---|
| `id` | serial | Primary key |
| `place_name` | text | Unique — the cache key |
| `latitude` | numeric | |
| `longitude` | numeric | |
| `created_at` | timestamp | Defaults to insert time |

## 3.2 `osm_roads` (imported OpenStreetMap road network)

| Column | Type | Notes |
|---|---|---|
| `way_id` | bigint | OpenStreetMap way ID, primary key |
| `name` | text | Road name, if tagged in OSM |
| `highway` | text | OSM `highway` tag value (e.g. `residential`, `trunk`) |
| `oneway` | text | Raw OSM `oneway` tag value |
| `geom` | `geometry(LineString, 3857)` | Road path, Web Mercator |

Imported via `osm2pgsql` — see `backend/sql/road_directions.sql` and
`backend/sql/import_roads.lua`. This table is what
`GET /api/road-directions` and `POST /api/road-trace` read/match against.

## 3.3 `road_direction_reports` (user-submitted one-way/two-way reports)

| Column | Type | Notes |
|---|---|---|
| `id` | serial | Primary key |
| `osm_way_id` | bigint | References `osm_roads.way_id` |
| `direction` | text | `'one_way'` or `'two_way'` |
| `distance_m` | double precision | Distance from the submitted trace to the matched road |
| `reported_at` | timestamp | Defaults to insert time |

Append-only — every report is kept, not just the latest. The "current"
direction for a road is always resolved as a majority vote over this
table (see §1.4 / §1.5), so conflicting reports self-correct over time
rather than the most recent submitter silently overriding everyone else.

## 3.4 `osm_roads_edges` / `osm_roads_vertices_pgr` (routing graph)

Used internally by `GET /api/directions` only — not exposed directly by
any endpoint. Built from `osm_roads` by
`backend/sql/road_routing_topology.sql`: each road is split into sub-edges
at every point it actually shares with another road (not just its own
endpoints), so pgRouting has a correct graph node at every real
intersection. `cost` / `reverse_cost` are the segment length in meters,
inflated to an effectively-unroutable `1e9` in whichever direction the
OSM `oneway` tag disallows.

---

# 4. External Dependencies

| Dependency | Used by | Requires a key? | Notes |
|---|---|---|---|
| Google Places Autocomplete + Place Details | `search_text`, `get_location` (Socket.IO) | Yes — `GOOGLE_API_KEY` | Configured via `POST /api/config` or the `backend/.env` file |
| OSM Nominatim | `GET /api/directions` (geocoding) | No | Public instance, ~1 req/sec usage policy |
| pgRouting + PostGIS | `GET /api/directions` (route calculation) | No | Self-hosted on this server's own Postgres — no external service call |

---

# 5. Quick Start

```bash
npm install socket.io-client
```

```javascript
import { io } from 'socket.io-client';

const BASE_URL = 'https://test.servefamily.com';
const socket = io(BASE_URL);

// --- Socket.IO: search + resolve a place ---
socket.on('connect', () => console.log('Connected'));
socket.emit('search_text', 'Pettah');
socket.on('suggestions_result', (data) => console.log(data));
socket.on('location_result', (data) => console.log(data.lat, data.lng));

// --- REST: driving directions between two places ---
fetch(`${BASE_URL}/api/directions?origin=Colombo&destination=Galle`)
  .then((res) => res.json())
  .then((route) => console.log(`${route.distanceKm} km`));

// --- REST: tagged one-way/two-way roads for a map ---
fetch(`${BASE_URL}/api/road-directions`)
  .then((res) => res.json())
  .then((roads) => console.log(`${roads.length} tagged roads`));
```

---

## Reference

| | |
|---|---|
| **API Server** | `https://test.servefamily.com` |
| **Socket.IO Client** | `socket.io-client` |
| **Authentication** | None required |
| **Protocols** | Socket.IO / WebSocket, HTTP REST (JSON) |

# Location Socket App

Real-time place search and Sri Lanka road-direction crowdsourcing platform. Three parts, two repositories:

| Part | Path | Repo |
|---|---|---|
| Backend (Express + Socket.IO + Postgres/PostGIS) | `backend/` | this repo |
| Frontend (Vite/React test & admin UI) | `frontend/` | this repo |
| Mobile app (Expo/React Native) | `D:\Astrivix\PlacesApp` | separate repo |

Production: **https://test.servefamily.com** (EC2 instance `35.153.73.209`, `ubuntu@` user, PM2 process name `location-backend`).

---

## 1. What this system does

1. **Place search & geocoding.** A client (the `frontend` test UI, or the mobile app) sends free-text search over Socket.IO, gets Google Places autocomplete suggestions back, then resolves a chosen suggestion to lat/lng — cached in Postgres so a repeat search never re-hits Google. Full Socket.IO event reference: [`Location Socket API – External Developer Integration.md`](./Location%20Socket%20API%20%E2%80%93%20External%20Developer%20Integration.md).
2. **Google API key distribution.** The mobile app and frontend don't ship a hardcoded Google API key; they fetch it at runtime from `GET /api/config`, so the key can be rotated from the frontend's admin form without an app rebuild.
3. **Road direction tagging (crowdsourced).** A person walks or drives a road in the mobile app, records a GPS trace between **Start** and **End**, and tags it one-way or two-way. The backend snaps that trace onto the real OpenStreetMap road network (imported from a Sri Lanka `.osm.pbf` extract) via PostGIS nearest-line matching, and aggregates every user's report per road into a majority-vote consensus.

---

## 2. Repository layout

```
location-socket-app-test/
├── backend/
│   ├── server.js              Express app, Socket.IO server, all REST routes
│   ├── db.js                  pg Pool, reads .env
│   ├── .env                   PORT, DB_*, GOOGLE_API_KEY (not committed)
│   ├── sql/
│   │   ├── schema.sql         locations table (place search cache)
│   │   ├── import_roads.lua   osm2pgsql flex-output style (osm_roads table)
│   │   └── road_directions.sql  road_direction_reports table + indexes
│   └── map/
│       └── sri-lanka-260910.osm.pbf   Sri Lanka OSM extract (not committed, see §6)
├── frontend/
│   ├── src/App.jsx             Test UI: search box, cached-locations table, Google API key form
│   └── vite.config.js          Dev server + /api and /socket.io proxy to the backend
└── Location Socket API – External Developer Integration.md   Socket.IO reference for external consumers
```

The mobile app lives in a separate repository at `D:\Astrivix\PlacesApp` — see its own `README.md` for mobile-specific docs.

---

## 3. Local development

### Backend
```bash
cd backend
npm install
cp .env.example .env   # fill in DB_* and GOOGLE_API_KEY (see §5)
npm run dev            # nodemon server.js, http://localhost:<PORT>
```

### Frontend
```bash
cd frontend
npm install
npm run dev             # Vite dev server, proxies /api and /socket.io to the backend
```
`frontend/vite.config.js` proxies `/api` and `/socket.io` to `http://localhost:<PORT>` — keep that in sync with the backend's `.env` `PORT`, and with whatever port is actually free on your machine (multiple unrelated projects sharing one dev machine has previously caused a silent port collision — see §9).

---

## 4. REST API reference

All routes are registered in `backend/server.js`, before `express.static()`, so a route added there always wins over the static frontend fallback — a Cannot-GET/404-returns-HTML bug happened once from routes registered in the wrong order (see §9).

### `GET /api/config`
Returns the current Google API key so the frontend/mobile app can call Google Places directly without the key being baked into a build.

```json
{ "googleApiKey": "AIza..." }
```
`500` with `{ "error": "..." }` if no key is configured yet.

### `GET /api/config/status`
Safe-to-poll status check — never returns the key itself.
```json
{ "isSet": true, "length": 39 }
```

### `POST /api/config`
Sets/updates the Google API key. Persists to `backend/.env` (survives a restart) and updates the in-memory key used by every socket handler immediately.

Request:
```json
{ "googleApiKey": "AIza..." }
```
Response: `{ "ok": true, "length": 39 }`, or `400`/`500` with `{ "error": "..." }`.

### `POST /api/road-trace`
Matches a recorded GPS trace to the nearest real road (PostGIS `<->` KNN search against `osm_roads`, rejected if the nearest road is more than **60m** away) and records the submitted direction as one report against that road.

Request:
```json
{
  "points": [ { "lat": 6.9344, "lng": 79.8500 }, { "lat": 6.9349, "lng": 79.8503 } ],
  "direction": "one_way"
}
```
`direction` must be `"one_way"` or `"two_way"`. `points` needs at least 2 entries.

Response, matched:
```json
{
  "matched": true,
  "osmWayId": 123456789,
  "name": "Galle Road",
  "distanceM": 8.2,
  "consensus": "two_way",
  "reportCount": 4
}
```
`consensus` is the **majority-vote** direction across every report ever submitted for that OSM way, not just this one — so one person's mistaken tag doesn't flip the answer for everyone.

Response, no confident match: `{ "matched": false }`.

### `GET /api/road-directions`
Every road with at least one direction report, for rendering on a map.
```json
[
  {
    "osmWayId": 123456789,
    "name": "Galle Road",
    "geometry": { "type": "LineString", "coordinates": [[79.85, 6.93], ...] },
    "consensus": "two_way",
    "reportCount": 4
  }
]
```

---

## 5. Environment variables (`backend/.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the Express/Socket.IO server listens on |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` | Postgres connection (see `backend/db.js`) |
| `GOOGLE_API_KEY` | Google Places API key, also writable at runtime via `POST /api/config` |

`.env` is gitignored; never commit it.

---

## 6. Database schema

Three tables, all in the same Postgres database (`DB_NAME`):

### `locations` (`backend/sql/schema.sql`)
The place-search cache — one row per resolved place, keyed by name.
```sql
CREATE TABLE locations (
    id SERIAL PRIMARY KEY,
    place_name VARCHAR(255) UNIQUE NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### `osm_roads` (created by `osm2pgsql`, style defined in `backend/sql/import_roads.lua`)
Every OSM way tagged `highway=*` in the Sri Lanka extract — the road network traces get matched against.
```
osm_id BIGINT, name TEXT, highway TEXT, oneway TEXT, geom LINESTRING
```
Requires the `postgis` extension. Import steps (one-time, run on the server — needs the resize in §8 first):
```bash
CREATE EXTENSION IF NOT EXISTS postgis;
osmium tags-filter backend/map/sri-lanka-260910.osm.pbf w/highway -o /tmp/sri-lanka-roads.osm.pbf
osm2pgsql -d geo_locations -U $DB_USER -O flex -S backend/sql/import_roads.lua /tmp/sri-lanka-roads.osm.pbf
```

### `road_direction_reports` (`backend/sql/road_directions.sql`)
One row per user-submitted direction report — append-only, so conflicting reports for the same road can be resolved by majority vote instead of trusting whichever came in last.
```sql
CREATE TABLE road_direction_reports (
    id SERIAL PRIMARY KEY,
    osm_way_id BIGINT NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('one_way', 'two_way')),
    relative_direction VARCHAR(10) CHECK (relative_direction IN ('forward', 'backward')),
    distance_m DOUBLE PRECISION,
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```
`idx_road_reports_way` and a GiST index on `osm_roads.geom` (`idx_osm_roads_geom`) make both the per-way lookup and the nearest-neighbor match fast.

`relative_direction` (only set on `one_way` reports) records which way the
reporter actually drove, relative to the matched road's own OSM digitized
direction — see the "External Developer Integration" doc §1.4/§3.3/§3.4 for
how `POST /api/road-trace` derives it and uses it to actually block that
direction in the `GET /api/directions` routing graph
(`osm_roads_edges`/`osm_roads_vertices_pgr`, built by
`backend/sql/road_routing_topology.sql` — not otherwise documented in this
README yet). If this column doesn't exist on an existing database, run
`backend/sql/road_direction_relative.sql` once to add it.

---

## 7. Road Direction Tagging feature — how it works end to end

1. **Mobile (`PlacesApp`, "Road Tagging" screen):** user taps **Start**, `expo-location.watchPositionAsync` records `{lat, lng, timestamp}` fixes every ~5m/2s while the app stays open in the foreground (no background tracking). Taps **End**, picks **One-way** or **Two-way**. The trace is saved locally in SQLite (`roadDb.js`) immediately, independent of network.
2. **Submit (`roadTraceService.js`):** the trace is POSTed to `/api/road-trace`.
3. **Match (`server.js`):** the trace's points become a `LINESTRING`, matched via PostGIS `<->` KNN against `osm_roads`, rejected past 60m.
4. **Store & aggregate:** a row goes into `road_direction_reports`; the response includes the majority-vote `consensus` across all reports for that road.
5. **Feedback:** the app shows "Matched to `<road name>` — community says `<consensus>` (`N` reports)" and marks the local row `synced`.
6. **Shared view:** every device also fetches `GET /api/road-directions` on load and draws all previously-tagged roads on the map (orange = one-way, green = two-way), so the crowdsourced result is visible to everyone, not just whoever recorded it.

Why PostGIS nearest-line matching instead of a full routing engine (OSRM): the actual need is "which real road does this trace correspond to," not turn-by-turn routing between two points — a spatial nearest-neighbor query does that directly, at a fraction of OSRM's memory/CPU cost, which matters a lot on this project's small production instance (see §8).

---

## 8. Deployment (production: `test.servefamily.com`)

- **Server:** EC2 `35.153.73.209`, Ubuntu, SSH as `ubuntu`.
- **Process manager:** PM2, process name `location-backend`, running `backend/server.js` from `/home/ubuntu/location-socket-app-test`.
- **Reverse proxy:** nginx serves `frontend/dist` as static files at `/`, and proxies `/api/` and `/socket.io/` to the Node process on `localhost:<PORT>`.
- **Database:** Postgres, same box, `DB_HOST=localhost`.

### Deploying a code change
```bash
ssh -i <key.pem> ubuntu@35.153.73.209
cd location-socket-app-test
git pull
pm2 restart location-backend
```
**`git pull` alone is not enough.** PM2 keeps the old code running in memory until explicitly restarted — this exact gap caused a real incident (see §9). Always restart after pulling.

### Current infrastructure status (as of the road-tagging feature)
The production instance is small — **~512MB RAM, ~2.7GB free disk** at last check — enough for the existing Node + Postgres app, but **not enough** to install PostGIS and import the Sri Lanka road network safely. Before the road-tagging backend pieces (§4, §6, §7) can be installed/imported on production:
1. Resize the EC2 instance to at least **t3.small** (2GB RAM) via the AWS Console (stop → change instance type → start).
2. Grow the attached EBS volume to **~20GB** while stopped.
3. After boot, grow the filesystem to match (`growpart` + `resize2fs`).

Until that resize happens, the road-tagging **code** is written and committed, but `osm_roads`/`road_direction_reports` don't exist on the production database yet, so `/api/road-trace` and `/api/road-directions` will error there. The mobile app's local SQLite recording still works fully offline regardless.

---

## 9. Known incidents / lessons (worth knowing before touching this codebase)

- **`git pull` doesn't restart PM2.** A route (`/api/config/status`) was added, deployed via `git pull`, and appeared to 404 in production for days because the PM2 process was never restarted to load it. Always `pm2 restart location-backend` after pulling.
- **Route order matters.** All API routes must be registered before `app.use(express.static(...))`, or a missing route silently falls through to serving the frontend's `index.html` (or a plain-text 404), which breaks JSON parsing on the client with `Unexpected token '<'`.
- **Dev port collisions.** This machine runs multiple unrelated projects. If `/api/config` or similar suddenly 404s or returns an unrelated app's HTML in local dev, check that nothing else is bound to the port in `backend/.env` / `frontend/vite.config.js` (`Get-NetTCPConnection -State Listen` on Windows) before assuming the code is broken.

---

## 10. Related docs

- [`Location Socket API – External Developer Integration.md`](./Location%20Socket%20API%20%E2%80%93%20External%20Developer%20Integration.md) — full Socket.IO event reference for external consumers.
- `D:\Astrivix\PlacesApp\README.md` — mobile app setup, features, and file structure.

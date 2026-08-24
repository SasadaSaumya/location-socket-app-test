# Location Socket API

## Base URL

```text
https://test.servefamily.com
```

This API uses **Socket.IO**.


---

## 1. Installation

Install the Socket.IO client in the external project:

```bash
npm install socket.io-client
```

---

## 2. Connect to the API

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

---

# 3. Search Locations

Use the `search_text` event to search for a location.

### Request

```javascript
socket.emit('search_text', 'Pettah Railway Station');
```

### Event

```text
search_text
```

### Payload

```text
string
```

### Example

```javascript
socket.emit('search_text', 'Pettah');
```

---

# 4. Receive Search Suggestions

Listen for the `suggestions_result` event.

```javascript
socket.on('suggestions_result', (suggestions) => {
    console.log(suggestions);
});
```

### Response

```json
[
    {
        "placeId": "ChIJxxxxxxxxxxxxxxxx",
        "description": "Pettah Railway Station, Colombo, Sri Lanka"
    },
    {
        "placeId": "ChIJyyyyyyyyyyyyyyyy",
        "description": "Pettah, Colombo, Sri Lanka"
    }
]
```

### Response Fields

| Field | Type | Description |
|---|---|---|
| `placeId` | string | Google Place ID |
| `description` | string | Location name/description |

---

# 5. Get Location Coordinates

After the user selects a suggestion, send the `placeId` and `description` using the `get_location` event.

### Request

```javascript
socket.emit('get_location', {
    placeId: 'ChIJxxxxxxxxxxxxxxxx',
    description: 'Pettah Railway Station, Colombo, Sri Lanka'
});
```

### Event

```text
get_location
```

### Request Body

```json
{
    "placeId": "ChIJxxxxxxxxxxxxxxxx",
    "description": "Pettah Railway Station, Colombo, Sri Lanka"
}
```

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `placeId` | string | Yes | Place ID received from `suggestions_result` |
| `description` | string | Yes | Description received from `suggestions_result` |

---

# 6. Receive Location Result

Listen for:

```javascript
socket.on('location_result', (data) => {
    console.log(data);
});
```

### Response

```json
{
    "name": "Pettah Railway Station, Colombo, Sri Lanka",
    "lat": 6.9344,
    "lng": 79.8500,
    "source": "Google API (live fetch)"
}
```

### Response Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Location name |
| `lat` | number | Latitude |
| `lng` | number | Longitude |
| `source` | string | Data source |

### Possible `source` values

```text
PostgreSQL cache
```

or

```text
Google API (live fetch)
```

The external application does not need to do anything differently based on the source.

---

# 7. Handle Location Errors

Listen for:

```javascript
socket.on('location_error', (message) => {
    console.error('Location Error:', message);
});
```

Example:

```text
Pick a suggestion from the list first.
```

Another possible response:

```text
could not resolve that location.
```

---

# 8. Get All Cached Locations

To retrieve all available cached locations:

### Request

```javascript
socket.emit('get_all_locations');
```

No payload is required.

### Receive Response

```javascript
socket.on('all_locations_result', (locations) => {
    console.log(locations);
});
```

### Response

```json
[
    {
        "id": 1,
        "place_name": "Pettah Railway Station, Colombo, Sri Lanka",
        "latitude": 6.9344,
        "longitude": 79.8500,
        "created_at": "2026-08-18T15:30:00.000Z"
    },
    {
        "id": 2,
        "place_name": "Colombo Fort Railway Station, Sri Lanka",
        "latitude": 6.9347,
        "longitude": 79.8428,
        "created_at": "2026-08-18T15:40:00.000Z"
    }
]
```

---

# 9. Complete Integration Example

Copy this code into another JavaScript/React project:

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

// Connection error
socket.on('connect_error', (error) => {
    console.error('Connection error:', error.message);
});
```

---

# 10. API Event Summary

| Direction | Event | Payload |
|---|---|---|
| Client → Server | `search_text` | Search text string |
| Server → Client | `suggestions_result` | Array of suggestions |
| Client → Server | `get_location` | `placeId`, `description` |
| Server → Client | `location_result` | Location coordinates |
| Server → Client | `location_error` | Error message |
| Client → Server | `get_all_locations` | None |
| Server → Client | `all_locations_result` | Array of locations |

---

# 11. Quick Start

```bash
npm install socket.io-client
```

```javascript
import { io } from 'socket.io-client';

const socket = io('https://test.servefamily.com');

socket.on('connect', () => {
    console.log('Connected');
});

socket.emit('search_text', 'Pettah');

socket.on('suggestions_result', (data) => {
    console.log(data);
});

socket.on('location_result', (data) => {
    console.log(data.lat);
    console.log(data.lng);
});
```

---

## API Server

```text
https://test.servefamily.com
```

## Socket.IO Client

```text
socket.io-client
```

## Authentication

```text
None required
```

## Protocol

```text
Socket.IO / WebSocket
```
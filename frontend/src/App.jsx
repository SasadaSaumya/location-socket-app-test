import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = window.location.origin;

function App() {
  const socketRef = useRef(null);
  const debounceRef = useRef(null);

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [allLocations, setAllLocations] = useState([]);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('get_all_locations');
    });

    socket.on('suggestions_result', (data) => {
      setSuggestions(data);
    });

    socket.on('location_result', (data) => {
      setDisabled(false);
      setStatus('');
      setError('');
      setResult(data);
    });

    socket.on('location_error', (msg) => {
      setDisabled(false);
      setStatus('');
      setResult(null);
      setError(msg);
    });

    // sent on connect and again whenever any client caches a new place
    socket.on('all_locations_result', (rows) => {
      setAllLocations(rows);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  function handleInputChange(e) {
    const text = e.target.value;
    setQuery(text);

    clearTimeout(debounceRef.current);

    if (text.trim().length <= 2) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(() => {
      socketRef.current.emit('search_text', text.trim());
    }, 300);
  }

  function handlePick(place) {
    setQuery(place.description);
    setSuggestions([]);
    setResult(null);
    setError('');
    setStatus('Looking up coordinates...');
    setDisabled(true);

    socketRef.current.emit('get_location', {
      placeId: place.placeId,
      description: place.description
    });
  }

  return (
    <div>
      <h2>Find Location Coordinates</h2>

      <input
        type="text"
        value={query}
        onChange={handleInputChange}
        placeholder="Search a place (e.g., Pettah)..."
        disabled={disabled}
        autoComplete="off"
        style={{ height: 30, width: 300 }}
      />

      {suggestions.length > 0 && (
        <ul>
          {suggestions.map((place) => (
            <li key={place.placeId} onClick={() => handlePick(place)}>
              {place.description}
            </li>
          ))}
        </ul>
      )}

      {status && <p>{status}</p>}

      {result && (
        <div>
          <p>Name: {result.name}</p>
          <p>Latitude: {result.lat}</p>
          <p>Longitude: {result.lng}</p>
          <p style={{ color: 'red' }}>Source: {result.source}</p>
        </div>
      )}

      {error && <p>Error: {error}</p>}

      <h3>All cached locations ({allLocations.length})</h3>

      {allLocations.length === 0 ? (
        <p>No locations cached yet.</p>
      ) : (
        <table border="1" cellPadding="6">
          <thead>
            <tr>
              <th>ID</th>
              <th>Place Name</th>
              <th>Latitude</th>
              <th>Longitude</th>
              <th>Created At</th>
            </tr>
          </thead>
          <tbody>
            {allLocations.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.place_name}</td>
                <td>{row.latitude}</td>
                <td>{row.longitude}</td>
                <td>{new Date(row.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default App;
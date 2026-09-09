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

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState(null); // { isSet, length }
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState('');
  const [apiKeyError, setApiKeyError] = useState('');

  function refreshApiKeyStatus() {
    fetch('/api/config/status')
      .then((res) => res.json())
      .then((data) => setApiKeyStatus(data))
      .catch(() => {});
  }

  useEffect(() => {
    refreshApiKeyStatus();
  }, []);

  function handleSaveApiKey(e) {
    e.preventDefault();
    const key = apiKeyInput.trim();

    setApiKeyMessage('');
    setApiKeyError('');

    if (!key) {
      setApiKeyError('Enter a Google API key first.');
      return;
    }

    setApiKeySaving(true);

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ googleApiKey: key })
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save the API key.');
        setApiKeyMessage('Google API key saved.');
        setApiKeyInput('');
        refreshApiKeyStatus();
      })
      .catch((err) => setApiKeyError(err.message))
      .finally(() => setApiKeySaving(false));
  }

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
      <h2>Test Find Location Coordinates</h2>

      <fieldset style={{ width: 340, marginBottom: 20 }}>
        <legend>Google API Key</legend>

        <p style={{ margin: '4px 0' }}>
          Status:{' '}
          {apiKeyStatus === null
            ? 'Checking...'
            : apiKeyStatus.isSet
            ? `Set (${apiKeyStatus.length} characters)`
            : 'Not set'}
        </p>

        <form onSubmit={handleSaveApiKey} style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="Enter GOOGLE_API_KEY"
            autoComplete="off"
            style={{ height: 30, flex: 1 }}
          />
          <button type="submit" disabled={apiKeySaving} style={{ height: 34 }}>
            {apiKeySaving ? 'Saving...' : 'Save'}
          </button>
        </form>

        {apiKeyMessage && <p style={{ color: 'green', margin: '4px 0' }}>{apiKeyMessage}</p>}
        {apiKeyError && <p style={{ color: 'red', margin: '4px 0' }}>{apiKeyError}</p>}
      </fieldset>

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
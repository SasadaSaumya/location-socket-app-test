import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Vite bundles leaflet's marker images under hashed filenames, which breaks
// Leaflet's own default-icon lookup (it expects them next to leaflet.js on
// disk), leaving markers with a broken image and offset shadow unless the
// resolved URLs are wired back in here.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

const DEFAULT_CENTER = [7.8731, 80.7718]; // Sri Lanka
const DEFAULT_ZOOM = 8;

const DIRECTION_STYLE = {
  one_way: { color: '#e5383b', label: 'One way' },
  two_way: { color: '#2b9348', label: 'Two way' }
};

function MapPage() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const roadsLayerRef = useRef(null);
  const routeLayerRef = useRef(null);

  const [roads, setRoads] = useState([]);
  const [status, setStatus] = useState('Loading tagged roads...');
  const [error, setError] = useState('');

  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [routeInfo, setRouteInfo] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [routeLoading, setRouteLoading] = useState(false);

  // create the map once
  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map(mapContainerRef.current).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    roadsLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // load tagged roads from the server
  useEffect(() => {
    fetch('/api/road-directions')
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load tagged roads from the server.');
        return res.json();
      })
      .then((data) => {
        setRoads(data);
        setStatus(data.length === 0 ? 'No tagged roads yet.' : '');
      })
      .catch((err) => {
        setStatus('');
        setError(err.message);
      });
  }, []);

  // draw/update the road polylines whenever the data changes
  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = roadsLayerRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();
    if (roads.length === 0) return;

    const bounds = L.latLngBounds([]);

    roads.forEach((road) => {
      const style = DIRECTION_STYLE[road.consensus] || { color: '#555555', label: 'Unknown' };
      const latLngs = road.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

      const polyline = L.polyline(latLngs, {
        color: style.color,
        weight: 5,
        opacity: 0.85
      }).addTo(layerGroup);

      polyline.bindPopup(
        `<strong>${road.name || 'Unnamed road'}</strong><br/>` +
          `${style.label} &middot; ${road.reportCount} report${road.reportCount === 1 ? '' : 's'}`
      );

      latLngs.forEach((ll) => bounds.extend(ll));
    });

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }, [roads]);

  function handleShowRoute(e) {
    e.preventDefault();

    const origin = fromText.trim();
    const destination = toText.trim();

    setRouteError('');
    setRouteInfo(null);

    if (!origin || !destination) {
      setRouteError('Enter both a "from" and a "to" place.');
      return;
    }

    setRouteLoading(true);

    fetch(`/api/directions?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not find that route.');
        return data;
      })
      .then((data) => {
        setRouteInfo(data);

        const map = mapRef.current;
        const routeLayer = routeLayerRef.current;
        if (!map || !routeLayer) return;

        routeLayer.clearLayers();

        const latLngs = data.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        L.polyline(latLngs, {
          color: '#1d4ed8',
          weight: 5,
          opacity: 0.85,
          dashArray: '10 8'
        }).addTo(routeLayer);

        L.marker([data.startLocation.lat, data.startLocation.lng])
          .addTo(routeLayer)
          .bindPopup(`<strong>From:</strong> ${data.startAddress}`);

        L.marker([data.endLocation.lat, data.endLocation.lng])
          .addTo(routeLayer)
          .bindPopup(`<strong>To:</strong> ${data.endAddress}`);

        const bounds = L.latLngBounds(latLngs);
        map.fitBounds(bounds, { padding: [30, 30] });
      })
      .catch((err) => setRouteError(err.message))
      .finally(() => setRouteLoading(false));
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h2>Tagged Roads Map</h2>
        <Link to="/">
          <button type="button" style={{ height: 36, padding: '0 16px' }}>
            Back to Home
          </button>
        </Link>
      </div>

      <form onSubmit={handleShowRoute} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={fromText}
          onChange={(e) => setFromText(e.target.value)}
          placeholder="From e.g. Colombo"
          autoComplete="off"
          style={{ height: 32, width: 180 }}
        />
        <span>to</span>
        <input
          type="text"
          value={toText}
          onChange={(e) => setToText(e.target.value)}
          placeholder="To e.g. Galle"
          autoComplete="off"
          style={{ height: 32, width: 180 }}
        />
        <button type="submit" disabled={routeLoading} style={{ height: 36, padding: '0 16px' }}>
          {routeLoading ? 'Finding route...' : 'Show Route'}
        </button>
      </form>

      {routeError && <p style={{ color: 'red', margin: '4px 0' }}>{routeError}</p>}
      {routeInfo && (
        <p style={{ margin: '4px 0' }}>
          <strong>{routeInfo.startAddress}</strong> &rarr; <strong>{routeInfo.endAddress}</strong>
          {' '}({routeInfo.distanceKm} km)
        </p>
      )}

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 4, background: DIRECTION_STYLE.one_way.color, display: 'inline-block' }} />
          One way
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 4, background: DIRECTION_STYLE.two_way.color, display: 'inline-block' }} />
          Two way
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 4, background: '#1d4ed8', display: 'inline-block' }} />
          Route
        </span>
        <span>{roads.length} tagged road{roads.length === 1 ? '' : 's'}</span>
      </div>

      {status && <p>{status}</p>}
      {error && <p style={{ color: 'red' }}>Error: {error}</p>}

      <div ref={mapContainerRef} style={{ width: '100%', height: '75vh', border: '1px solid #ccc' }} />
    </div>
  );
}

export default MapPage;

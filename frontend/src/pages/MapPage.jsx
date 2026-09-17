import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const DEFAULT_CENTER = [7.8731, 80.7718]; // Sri Lanka
const DEFAULT_ZOOM = 8;

const DIRECTION_STYLE = {
  one_way: { color: '#e5383b', label: 'One way' },
  two_way: { color: '#2b9348', label: 'Two way' }
};

function MapPage() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);

  const [roads, setRoads] = useState([]);
  const [status, setStatus] = useState('Loading tagged roads...');
  const [error, setError] = useState('');

  // create the map once
  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map(mapContainerRef.current).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    layerGroupRef.current = L.layerGroup().addTo(map);
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
    const layerGroup = layerGroupRef.current;
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

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 4, background: DIRECTION_STYLE.one_way.color, display: 'inline-block' }} />
          One way
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 20, height: 4, background: DIRECTION_STYLE.two_way.color, display: 'inline-block' }} />
          Two way
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

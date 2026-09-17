import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import MapPage from './pages/MapPage.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/map" element={<MapPage />} />
    </Routes>
  );
}

export default App;

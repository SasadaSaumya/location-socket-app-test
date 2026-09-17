CREATE TABLE IF NOT EXISTS locations (
    id SERIAL PRIMARY KEY,
    place_name VARCHAR(255) UNIQUE NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Prevents saving the same physical spot twice under different name
    -- text (e.g. "Galle" vs "Galle, Sri Lanka"). See
    -- backend/sql/locations_lat_lng_unique.sql for the migration that adds
    -- this to an existing database.
    CONSTRAINT locations_lat_lng_unique UNIQUE (latitude, longitude)
);

CREATE INDEX IF NOT EXISTS idx_locations_place_name ON locations (place_name);

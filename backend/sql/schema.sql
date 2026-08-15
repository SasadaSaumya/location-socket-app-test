CREATE TABLE IF NOT EXISTS locations (
    id SERIAL PRIMARY KEY,
    place_name VARCHAR(255) UNIQUE NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_locations_place_name ON locations (place_name);

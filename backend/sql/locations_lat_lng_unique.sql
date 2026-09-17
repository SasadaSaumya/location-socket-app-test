-- Run once against the geo_locations database.
--
-- locations.place_name was already UNIQUE, but the PlacesApp mobile
-- client's "Use My Location" flow (and the website's search-and-save flow)
-- can save the exact same physical spot under different name text
-- ("Galle" vs "Galle, Sri Lanka"), producing real duplicate rows at the
-- same coordinate. This adds a second uniqueness rule on the coordinate
-- itself so that can't happen going forward, regardless of what name
-- string comes in.
--
-- Requires deduplicating any rows that already violate it first, or the
-- ALTER TABLE below fails. Keeps the oldest row (lowest id, first ever
-- saved) in each (latitude, longitude) group and deletes the rest.
DELETE FROM locations a
USING locations b
WHERE a.latitude = b.latitude
  AND a.longitude = b.longitude
  AND a.id > b.id;

ALTER TABLE locations ADD CONSTRAINT locations_lat_lng_unique UNIQUE (latitude, longitude);

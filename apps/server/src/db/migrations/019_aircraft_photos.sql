-- Aircraft photographs, cached as bytes.
--
-- A receiver hears no photographs, so this is the result of asking an external
-- service about an airframe. What is stored is the image itself rather than a
-- link to it, for three reasons: a hotlink puts every viewer's browser in touch
-- with the third party rather than only this server, it breaks on a receiver
-- with no internet access even for a photograph already seen, and it rots on
-- the upstream's schedule rather than on ours.
--
-- Keyed on ICAO address rather than registration because that is what the live
-- path has; a registration is metadata that may be missing.
--
-- A lookup that found nothing is cached too, under `status = 'absent'`, with a
-- shorter expiry: without it every unphotographed airframe — which is most of
-- general aviation — is re-asked upstream on every view. A transport failure is
-- cached as `'failed'` with the same shorter expiry, so an upstream outage
-- does not poison the cache for a month.
CREATE TABLE IF NOT EXISTS aircraft_photos (
  icao text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('present', 'absent', 'failed')),
  image bytea,
  content_type text,
  bytes integer,
  width integer,
  height integer,
  credit text,
  link_url text,
  source_url text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_served_at timestamptz NOT NULL DEFAULT now(),
  -- Only a present row may carry an image, and a present row must. Without
  -- this a failed fetch that half-wrote could be served as a zero-byte
  -- photograph, which renders as a broken image rather than as nothing.
  CONSTRAINT aircraft_photos_image_matches_status CHECK (
    (status = 'present') = (image IS NOT NULL)
  )
);

-- The maintenance sweep drops expired rows first, then the least recently
-- served rows beyond the entry cap. One index per pass.
CREATE INDEX IF NOT EXISTS aircraft_photos_expires_at_idx
  ON aircraft_photos (expires_at);

CREATE INDEX IF NOT EXISTS aircraft_photos_last_served_at_idx
  ON aircraft_photos (last_served_at);

-- The retention audit row accounts for every table the run deletes from. The
-- photo cache is the first one evicted by count rather than by age, so it
-- takes two columns: what expired, and what was evicted to stay under the cap.
ALTER TABLE maintenance_log
  ADD COLUMN IF NOT EXISTS expired_photos bigint NOT NULL DEFAULT 0;

ALTER TABLE maintenance_log
  ADD COLUMN IF NOT EXISTS evicted_photos bigint NOT NULL DEFAULT 0;

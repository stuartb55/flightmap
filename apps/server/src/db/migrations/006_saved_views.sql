CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  surface text NOT NULL CHECK (surface IN ('live', 'history', 'insights')),
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_views_updated_idx
  ON saved_views (updated_at DESC, name);
